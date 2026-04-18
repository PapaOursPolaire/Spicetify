// spotify-lyrics-saver.js — v6 — Compatible Spicy-Lyrics v5.20+
// Fix : lecture IndexedDB (SpicyLyrics_LyricsStore) en source primaire
//       → données enrichies (Background, OppositeAligned) telles que SpicyLyrics les stocke
//       + préservation complète de la structure JSON brute

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════════════════════ */
  const CONFIG = {
    debug               : true,
    preferWordSync      : true,
    autoSkipAfterSave   : true,
    autoSkipDelay       : 1800,
    retryOnFail         : true,
    maxRetries          : 5,
    deduplicateByTrackId: true,
    pollingInterval     : 600,
    spicyWaitMs         : 5000,   // délai d'attente WORD avant fallback LINE
  };

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  const state = {
    savedTrackIds  : new Set(),
    currentTrackId : null,
    retryCount     : 0,
    totalSaved     : 0,
    queueMode      : false,
    origFetch      : window.fetch,
    origXHROpen    : XMLHttpRequest.prototype.open,
    origXHRSend    : XMLHttpRequest.prototype.send,
    interceptActive: false,
    pollingTimer   : null,
    pending        : {},   // { [trackId]: { timer, bestLyrics } }
    trackSeenAt    : {},
  };

  /* ═══════════════════════════════════════════════════════════
     LOG
  ═══════════════════════════════════════════════════════════ */
  const log = (...a) => CONFIG.debug &&
    console.log('%c[LyricsSaver]', 'color:#1DB954;font-weight:bold', ...a);

  /* ═══════════════════════════════════════════════════════════
     UTILS
  ═══════════════════════════════════════════════════════════ */
  function sanitize(s) {
    return s.replace(/[<>:"/\\|?*\[\]\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  }

  function getCurrentTrackInfo() {
    try {
      const data  = Spicetify?.Player?.data;
      if (!data) return null;
      const track = data.item || data.track;
      if (!track) return null;
      const trackId = track.uri?.match(/spotify:track:([a-zA-Z0-9]+)/)?.[1] || track.id || null;
      return {
        trackId,
        trackName : track.name || 'Unknown Track',
        artistName: track.artists?.map(a => a.name).join(', ') || 'Unknown Artist',
        albumName : track.album?.name || '',
      };
    } catch { return null; }
  }

  /* ═══════════════════════════════════════════════════════════
     PARSERS
  ═══════════════════════════════════════════════════════════ */

  /**
   * Convertit une valeur temps en ms.
   * SpicyLyrics → secondes (ex: 10.5) → ms
   * Spotify     → ms déjà (ex: 10500)
   */
  function toMs(val) {
    if (!val) return 0;
    const n = Number(val);
    return n < 10000 ? Math.round(n * 1000) : Math.round(n);
  }

  /**
   * Reconstruit les mots à partir d'un tableau de syllabes.
   * IsPartOfWord === true  → la syllabe s'attache à la SUIVANTE (même mot)
   * IsPartOfWord === false → fin du mot courant
   */
  function syllablesToWords(syllables) {
    const syls  = syllables || [];
    const words = [];
    let cur = null;

    for (let i = 0; i < syls.length; i++) {
      const s       = syls[i];
      const sylText = s.Text || s.text || '';

      if (!cur) {
        cur = { text: '', startTime: toMs(s.StartTime || s.startTime), endTime: 0 };
      }

      cur.text   += sylText;
      cur.endTime = toMs(s.EndTime || s.endTime);

      // IsPartOfWord sur la syllabe COURANTE :
      //   true  → encore des syllabes à fusionner → on continue
      //   false → fin du mot courant
      const isPartOfWord = s.IsPartOfWord ?? s.isPartOfWord ?? false;
      const isWordEnd    = !isPartOfWord || i === syls.length - 1;

      if (isWordEnd) {
        const wordText = cur.text.trim();
        if (wordText) {
          words.push({ text: wordText, startTime: cur.startTime, endTime: cur.endTime });
        }
        cur = null;
      }
    }

    // Flush si un mot reste ouvert
    if (cur?.text.trim()) {
      words.push({ text: cur.text.trim(), startTime: cur.startTime, endTime: cur.endTime });
    }

    return words;
  }

  /**
   * Parse une section Lead ou Background (identique, juste le rôle diffère).
   * Retourne null si la section est vide.
   */
  function parseSection(section) {
    if (!section) return null;
    const syllables = section.Syllables || section.syllables || [];
    if (!syllables.length) return null;

    const words    = syllablesToWords(syllables);
    const lineText = syllables.map(s => s.Text || s.text || '').join('').trim();
    if (!lineText) return null;

    return {
      text     : lineText,
      startTime: toMs(section.StartTime || section.startTime),
      endTime  : toMs(section.EndTime   || section.endTime),
      words,
    };
  }

  /**
   * Parse le format Spicy-Lyrics v5 word-sync en préservant TOUTE la richesse du JSON :
   *
   * Chaque item dans Content[] peut avoir :
   *   - Type           : "Vocal" | "Background" (casse variable)
   *   - Lead           : section chanteur principal (objet unique)
   *   - Background     : backing vocals — ATTENTION : l'API retourne un TABLEAU d'objets
   *                      (ex: [{ Syllables[], StartTime, EndTime }]), pas un objet unique.
   *                      On normalise en un tableau `backgrounds[]` et on expose aussi
   *                      `background` (premier élément) pour compatibilité descendante.
   *   - OppositeAligned : booléen — vrai pour second chanteur / duet
   *
   * La structure de sortie par ligne :
   * {
   *   type           : "Vocal" | "Background",
   *   oppositeAligned: boolean,
   *   lead           : { text, startTime, endTime, words[] } | null,
   *   background     : { text, startTime, endTime, words[] } | null,  // 1er bg (compat)
   *   backgrounds    : Array<{ text, startTime, endTime, words[] }>,   // TOUS les bgs
   *   // champs plats pour compatibilité (dérivés du lead ou du 1er background)
   *   text           : string,
   *   startTime      : number,
   *   endTime        : number,
   *   words          : Word[],
   * }
   */
  function parseSpicyWordSync(result) {
    try {
      if (!result?.Content) return null;
      const lines = [];

      for (const item of result.Content) {
        const rawType = (item.Type || item.type || 'Vocal');
        // Normaliser : "Vocal" | "Background" (première lettre majuscule)
        const type    = rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase();

        // OppositeAligned : propriété directe sur l'item
        const oppositeAligned = item.OppositeAligned ?? item.oppositeAligned ?? false;

        const lead = parseSection(item.Lead || item.lead);

        // ── Background : l'API retourne un tableau, pas un objet unique ──
        // Formats possibles :
        //   { Background: [{ Syllables:[], StartTime, EndTime }] }  ← api.spicylyrics.org
        //   { Background:  { Syllables:[], StartTime, EndTime }  }  ← ancien format / IDB
        const bgRaw    = item.Background || item.background;
        const bgArray  = Array.isArray(bgRaw) ? bgRaw : (bgRaw ? [bgRaw] : []);
        const backgrounds = bgArray.map(b => parseSection(b)).filter(Boolean);
        const background  = backgrounds[0] || null; // compat descendante

        // Il faut au moins une section non-vide pour valider la ligne
        if (!lead && !background) continue;

        // Champs plats : on privilégie Lead, sinon le premier Background
        const primary = lead || background;

        lines.push({
          type,
          oppositeAligned,
          lead,
          background,   // premier background (compatibilité descendante)
          backgrounds,  // TOUS les backgrounds (nouveau — préserve fidèlement l'API)
          // Champs plats (compatibilité descendante avec le reste du code)
          text     : primary.text,
          startTime: primary.startTime,
          endTime  : primary.endTime,
          words    : primary.words,
        });
      }

      if (!lines.length) return null;

      const totalWords = lines.reduce((n, l) => n + (l.words?.length || 0), 0);
      if (totalWords === 0) return null;

      const hasBackground     = lines.some(l => l.backgrounds?.length > 0);
      const hasOpposite       = lines.some(l => l.oppositeAligned);
      const hasBackgroundType = lines.some(l => l.type === 'Background');
      const totalBgSections   = lines.reduce((n, l) => n + (l.backgrounds?.length || 0), 0);

      log(
        `✓ WORD parsé : ${lines.length} lignes, ${totalWords} mots` +
        (hasBackground     ? ` [+Background vocals ×${totalBgSections}]` : '') +
        (hasOpposite       ? ' [+OppositeAligned]'                        : '') +
        (hasBackgroundType ? ' [+type:Background]'                        : '')
      );

      return {
        syncType   : 'WORD',
        provider   : result.provider || 'spicylyrics',
        songWriters: result.SongWriters || result.songWriters || [],
        duration   : toMs(result.EndTime || result.endTime),
        lines,
      };
    } catch (e) {
      log('parseSpicyWordSync error:', e);
      return null;
    }
  }

  function parseLineSync(lines, provider = 'spotify') {
    if (!Array.isArray(lines)) return null;
    const parsed = lines
      .map(l => ({
        text     : (l.words || l.text || '').trim(),
        startTime: toMs(l.startTimeMs ?? l.startTime ?? 0),
        endTime  : toMs(l.endTimeMs   ?? l.endTime   ?? 0),
      }))
      .filter(l => l.text);
    if (!parsed.length) return null;
    return { syncType: 'LINE', provider, lines: parsed };
  }

  function parsePlain(text) {
    if (typeof text !== 'string') return null;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ text: l }));
    if (!lines.length) return null;
    return { syncType: 'NONE', provider: 'unknown', lines };
  }

  function autoDetect(data) {
    if (!data || typeof data !== 'object') return null;

    // 1. Spicy-Lyrics v5 word-sync direct (Content[] à la racine)
    if (CONFIG.preferWordSync && Array.isArray(data.Content)) {
      const ws = parseSpicyWordSync(data);
      if (ws) return ws;
    }

    // 2. Réponse api.spicylyrics.org/query — plusieurs formats possibles :
    //
    //    Format A — tableau de queries (GraphQL-like) :
    //    { queries: [{ operation: "lyrics", result: { data: { Content: [...] } } }] }
    //
    //    Format B — objet data direct :
    //    { data: { Content: [...] } }
    //
    //    Format C — résultat direct dans result :
    //    { result: { Content: [...] } }
    //
    //    Format D — réponse à la racine avec trackId :
    //    { trackId: "...", Content: [...] }   ← déjà géré par le cas 1 ci-dessus

    if (Array.isArray(data.queries)) {
      for (const q of data.queries) {
        // Chercher le résultat de lyrics peu importe le nom de l'opération
        const resultData = q.result?.data || q.result || q.data;
        if (!resultData) continue;

        if (CONFIG.preferWordSync && Array.isArray(resultData.Content)) {
          const ws = parseSpicyWordSync(resultData);
          if (ws) return ws;
        }
        if (resultData.lines) return parseLineSync(resultData.lines, 'spicylyrics');
      }
    }

    // Format B
    if (data.data && typeof data.data === 'object') {
      if (CONFIG.preferWordSync && Array.isArray(data.data.Content)) {
        const ws = parseSpicyWordSync(data.data);
        if (ws) return ws;
      }
      if (data.data.lines) return parseLineSync(data.data.lines, 'spicylyrics');
    }

    // Format C
    if (data.result && typeof data.result === 'object') {
      if (CONFIG.preferWordSync && Array.isArray(data.result.Content)) {
        const ws = parseSpicyWordSync(data.result);
        if (ws) return ws;
      }
      if (data.result.lines) return parseLineSync(data.result.lines, 'spicylyrics');
      // result.data imbriqué
      if (data.result.data?.Content) {
        const ws = CONFIG.preferWordSync ? parseSpicyWordSync(data.result.data) : null;
        if (ws) return ws;
        if (data.result.data.lines) return parseLineSync(data.result.data.lines, 'spicylyrics');
      }
    }

    // 3. Spotify color-lyrics API
    if (data.lyrics?.lines) return parseLineSync(data.lyrics.lines, 'spotify');

    // 4. Lignes directes
    if (Array.isArray(data.lines)) return parseLineSync(data.lines, 'unknown');

    // 5. Content[] présent mais vide en WORD → fallback LINE
    if (Array.isArray(data.Content) && data.Content.length) {
      const lines = data.Content
        .filter(i => (i.Lead?.Syllables || i.lead?.Syllables || i.words || i.text))
        .map(i => {
          const lead = i.Lead || i.lead;
          if (lead?.Syllables) {
            return {
              text     : lead.Syllables.map(s => s.Text || s.text || '').join('').trim(),
              startTime: toMs(lead.StartTime || lead.startTime),
              endTime  : toMs(lead.EndTime   || lead.endTime),
            };
          }
          return {
            text     : (i.words || i.text || '').trim(),
            startTime: toMs(i.startTimeMs || i.startTime || 0),
            endTime  : toMs(i.endTimeMs   || i.endTime   || 0),
          };
        })
        .filter(l => l.text);
      if (lines.length) return { syncType: 'LINE', provider: 'spicylyrics-fallback', lines };
    }

    return null;
  }

  /* ═══════════════════════════════════════════════════════════
     SAUVEGARDE
     Le JSON de sortie préserve intégralement la structure parsée,
     y compris les champs type, oppositeAligned, lead, background.
  ═══════════════════════════════════════════════════════════ */
  async function saveLyrics(trackInfo, lyricsData, score = 0, rawData = null) {
    // Statistiques enrichies
    const wordCount            = lyricsData.lines.reduce((s, l) => s + (l.words?.length || 0), 0);
    const backgroundLineCount  = lyricsData.lines.filter(l => l.backgrounds?.length > 0).length;
    const backgroundSectCount  = lyricsData.lines.reduce((n, l) => n + (l.backgrounds?.length || 0), 0);
    const backgroundTypeCount  = lyricsData.lines.filter(l => l.type === 'Background').length;
    const oppositeAlignedCount = lyricsData.lines.filter(l => l.oppositeAligned).length;

    const output = {
      metadata: {
        track               : trackInfo.trackName,
        artist              : trackInfo.artistName,
        album               : trackInfo.albumName,
        trackId             : trackInfo.trackId,
        downloadedAt        : new Date().toISOString(),
        syncType            : lyricsData.syncType,
        qualityScore        : score,
        qualityLabel        : qualityLabel(score),
        provider            : lyricsData.provider || 'unknown',
        lineCount           : lyricsData.lines.length,
        wordCount,
        backgroundLineCount,
        backgroundSectCount,
        backgroundTypeCount,
        oppositeAlignedCount,
        songWriters         : lyricsData.songWriters || [],
        duration            : lyricsData.duration || null,
      },
      lyrics: lyricsData,
      // JSON source préservé intégralement (avant tout parsing/transformation).
      // Contient la structure PascalCase native de SpicyLyrics :
      //   Content[].OppositeAligned, Content[].Lead.Syllables, Content[].Background.Syllables,
      //   IsPartOfWord, ainsi que les champs racine Type, SongWriters, StartTime, EndTime.
      rawLyrics: rawData || null,
    };

    // ── Garde-fou anti double-save concurrent ───────────────────────────────
    // processPayload peut être appelé plusieurs fois de suite sans await (polling
    // 600ms, IDB write hook, fetch hook…). Si deux appels concurrents arrivent avant
    // que savedScore soit positionné, ils passeraient tous les deux le check
    // prevScore >= score et déclencheraient deux saveLyrics simultanés.
    // On marque le score AVANT le download pour court-circuiter le second appel.
    if (!state.savedScore) state.savedScore = {};
    const prevSavedScore = state.savedScore[trackInfo.trackId] ?? 0;
    if (prevSavedScore >= score) {
      log(`⚠ saveLyrics annulé — score déjà enregistré (${prevSavedScore} ≥ ${score}) pour ${trackInfo.trackName}`);
      return;
    }
    state.savedScore[trackInfo.trackId] = score;  // verrouille avant I/O asynchrone

    const filename = `${sanitize(trackInfo.artistName)} - ${sanitize(trackInfo.trackName)}.json`;
    const blob     = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const a        = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 300ms était trop court : dans Spotify/Electron le download peut démarrer
    // plus tard (tab en arrière-plan, Electron occupé, plusieurs downloads en file).
    // Si l'URL est révoquée avant que le download démarre, le fichier n'est pas créé
    // mais l'état interne dit "sauvegardé" → blocage silencieux définitif.
    // 60s est largement suffisant pour tout scénario réel.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    state.savedTrackIds.add(trackInfo.trackId);
    const isUpgrade = prevSavedScore > 0;
    if (!isUpgrade) state.totalSaved++;
    state.retryCount = 0;

    const st = document.getElementById('lsSyncType');
    if (st) st.textContent = lyricsData.syncType;

    const extras = [
      backgroundLineCount  ? `bg:${backgroundLineCount}(×${backgroundSectCount})`  : null,
      backgroundTypeCount  ? `bgT:${backgroundTypeCount}`                           : null,
      oppositeAlignedCount ? `opp:${oppositeAlignedCount}`                          : null,
      score                ? `q:${score}`                                            : null,
    ].filter(Boolean).join(' ');

    const upgradeTag = isUpgrade ? ' [UPGRADE]' : '';
    log(`✓${upgradeTag} ${filename} (${output.metadata.lineCount} lignes, ${wordCount} mots${extras ? ' — ' + extras : ''})`);
    uiAddLog(`✓${upgradeTag} ${trackInfo.artistName} — ${trackInfo.trackName} [${qualityLabel(score)}${extras ? ' ' + extras : ''}]`, 'success');
    uiSetStatus('idle');
    uiUpdateStats();
    Spicetify?.showNotification?.(`[Lyrics] ✓${upgradeTag} ${trackInfo.trackName} (${qualityLabel(score)})`);

    if (CONFIG.autoSkipAfterSave && state.queueMode && !isUpgrade) {
      uiAddLog(`⏭ Skip dans ${CONFIG.autoSkipDelay}ms…`, 'info');
      setTimeout(() => Spicetify?.Player?.next?.(), CONFIG.autoSkipDelay);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SYSTÈME DE QUALITÉ
     Score de 0 à 100 — plus c'est haut, meilleure est la source.
     Hiérarchie :
       WORD enrichi (Background + OppositeAligned)  → 100
       WORD enrichi (Background seul)               →  85
       WORD enrichi (OppositeAligned seul)           →  80
       WORD brut (Syllables uniquement)              →  60
       LINE                                          →  20
       NONE                                          →   5
  ═══════════════════════════════════════════════════════════ */
  function qualityScore(lyrics) {
    if (!lyrics) return 0;
    if (lyrics.syncType === 'NONE') return 5;
    if (lyrics.syncType === 'LINE') return 20;

    // WORD — on évalue la richesse des données
    const lines = lyrics.lines || [];
    const hasBackground     = lines.some(l => l.backgrounds?.length > 0);
    const hasOpposite       = lines.some(l => l.oppositeAligned === true);
    const hasBackgroundType = lines.some(l => l.type === 'Background');
    const hasWords          = lines.some(l => l.words?.length > 0);

    if (!hasWords) return 30; // WORD sans mots → quasi-LINE

    let score = 60; // WORD de base
    if (hasBackground || hasBackgroundType) score += 25;
    if (hasOpposite)                        score += 15;
    return Math.min(score, 100);
  }

  function qualityLabel(score) {
    if (score >= 100) return 'WORD+BG+OPP';
    if (score >= 85)  return 'WORD+BG';
    if (score >= 80)  return 'WORD+OPP';
    if (score >= 60)  return 'WORD';
    if (score >= 20)  return 'LINE';
    return 'NONE';
  }

  /* ═══════════════════════════════════════════════════════════
     EXTRACTION DU JSON BRUT
     Retourne le sous-objet de paroles le plus précis possible,
     sans aucune transformation, pour archivage fidèle.
  ═══════════════════════════════════════════════════════════ */
  function extractRawLyricsPayload(data) {
    if (!data || typeof data !== 'object') return null;

    // Format queries[] (api.spicylyrics.org/query)
    // → on remonte jusqu'à result.data qui contient Content[], SongWriters, etc.
    if (Array.isArray(data.queries)) {
      for (const q of data.queries) {
        const rd = q.result?.data;
        if (rd && (rd.Content || rd.lines)) return rd;
        // Cas où result est directement le payload (sans .data)
        if (q.result && (q.result.Content || q.result.lines)) return q.result;
      }
      // Rien de valide trouvé dans queries → on renvoie l'objet complet
      return data;
    }

    // Format { data: { Content: [...] } }
    if (data.data && typeof data.data === 'object' &&
        (data.data.Content || data.data.lines)) return data.data;

    // Format { result: { data: { Content: [...] } } }
    if (data.result?.data && (data.result.data.Content || data.result.data.lines))
      return data.result.data;

    // Format { result: { Content: [...] } }
    if (data.result && (data.result.Content || data.result.lines)) return data.result;

    // Format direct (Content[] à la racine, ou IDB déjà désérialisé)
    return data;
  }

  /* ═══════════════════════════════════════════════════════════
     TRAITEMENT PAYLOAD
  ═══════════════════════════════════════════════════════════ */
  /**
   * @param {string|object} raw        - Corps de la réponse (string JSON ou objet déjà parsé)
   * @param {string|null}   expectedTrackId
   *   ID de la piste au moment de l'interception (fetch/XHR/poll).
   *   Fourni par les hooks pour détecter les payloads devenus obsolètes :
   *   si la piste a changé entre l'interception et la résolution du promise,
   *   les paroles seraient attribuées à la mauvaise piste → rejet.
   *   null = pas de vérification (IDB synchrone, CustomEvent…).
   */
  async function processPayload(raw, expectedTrackId = null) {
    let data;
    if (typeof raw === 'string') {
      try { data = JSON.parse(raw); } catch { return; }
    } else if (raw && typeof raw === 'object') {
      data = raw;
    } else {
      return;
    }

    const ti = getCurrentTrackInfo();
    if (!ti?.trackId) return;

    // ── Garde-fou anti-attribution croisée ──────────────────────────
    // Si expectedTrackId est fourni et diffère de la piste en cours,
    // c'est que le payload (fetch async) appartient à une piste passée.
    // On le rejette pour éviter de sauvegarder A sous l'ID de B,
    // ce qui bloquerait ensuite la vraie sauvegarde de B (prevScore ≥ score).
    if (expectedTrackId && expectedTrackId !== ti.trackId) {
      log(`⚠ Payload obsolète rejeté — piste changée (${expectedTrackId} → ${ti.trackId})`);
      return;
    }

    uiSetStatus('parsing');
    const lyrics = autoDetect(data);
    if (!lyrics) { uiSetStatus(state.queueMode ? 'active' : 'idle'); return; }

    // rawData : on extrait le sous-objet de paroles le plus précis possible
    // (pour les réponses queries[], c'est result.data ; sinon data lui-même)
    const rawData = extractRawLyricsPayload(data);

    const id    = ti.trackId;
    const score = qualityScore(lyrics);
    const label = qualityLabel(score);

    log(`payload reçu — ${ti.trackName} — qualité: ${label} (${score})`);

    // ── Score parfait (≥100) : WORD enrichi complet → sauvegarde immédiate ──
    if (score >= 100) {
      if (state.pending[id]) {
        clearTimeout(state.pending[id].timer);
        delete state.pending[id];
      }
      // Remplacer même si déjà sauvegardé avec une version moins bonne
      const prevScore = state.savedScore?.[id] ?? 0;
      if (prevScore >= 100) {
        log(`⏭ Qualité maximale déjà sauvegardée pour ${ti.trackName}`);
        return;
      }
      log(`► ${label} pour ${ti.trackName} — sauvegarde immédiate`);
      uiAddLog(`🎵 ${label} reçu — ${ti.trackName}`, 'success');
      await saveLyrics(ti, lyrics, score, rawData);
      return;
    }

    // ── Déjà sauvegardé avec une meilleure qualité → ignorer ──
    const prevScore = state.savedScore?.[id] ?? 0;
    if (CONFIG.deduplicateByTrackId && prevScore >= score) {
      log(`⏭ Déjà sauvegardé en meilleure qualité (${prevScore} ≥ ${score}) — ${ti.trackName}`);
      return;
    }

    // ── En attente : comparer avec le candidat actuel ──
    if (state.pending[id]) {
      const currentBestScore = qualityScore(state.pending[id].bestLyrics);

      if (score > currentBestScore) {
        log(`↑ Meilleur candidat trouvé : ${label} (${score} > ${currentBestScore}) — ${ti.trackName}`);
        state.pending[id].bestLyrics = lyrics;
        state.pending[id].rawData    = rawData;  // ← mise à jour du raw avec le meilleur candidat

        // Si le nouveau candidat est un WORD enrichi (≥60), on peut réduire l'attente
        if (score >= 60 && currentBestScore < 60) {
          clearTimeout(state.pending[id].timer);
          const reducedWait = Math.min(CONFIG.spicyWaitMs, 2000);
          state.pending[id].timer = setTimeout(async () => {
            const pending   = state.pending[id];
            const best      = pending?.bestLyrics || lyrics;
            const bestRaw   = pending?.rawData    || rawData;
            const bestScore = qualityScore(best);
            delete state.pending[id];
            if ((state.savedScore?.[id] ?? 0) >= bestScore) return;
            uiAddLog(`↓ Fallback ${qualityLabel(bestScore)} pour ${ti.trackName}`, 'info');
            await saveLyrics(ti, best, bestScore, bestRaw);
          }, reducedWait);
        }
      }
      return;
    }

    // ── Pas encore en attente → démarrer le timer ──
    uiAddLog(`⏳ ${ti.trackName} — attente meilleure source (${CONFIG.spicyWaitMs / 1000}s) [${label}]…`, 'info');

    const timer = setTimeout(async () => {
      const pending   = state.pending[id];
      const best      = pending?.bestLyrics || lyrics;
      const bestRaw   = pending?.rawData    || rawData;
      const bestScore = qualityScore(best);
      delete state.pending[id];
      if ((state.savedScore?.[id] ?? 0) >= bestScore) return;
      uiAddLog(`↓ Fallback ${qualityLabel(bestScore)} pour ${ti.trackName}`, 'info');
      await saveLyrics(ti, best, bestScore, bestRaw);
    }, CONFIG.spicyWaitMs);

    state.pending[id] = { timer, bestLyrics: lyrics, rawData, trackInfo: ti };
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 1 — Fetch
  ═══════════════════════════════════════════════════════════ */
  const PATTERNS = [
    'api.spicylyrics.org',    // ← SOURCE PRINCIPALE : API SpicyLyrics enrichie (Background, OppositeAligned…)
    'spicylyrics.org',
    'spicylyrics',
    'beautiful-lyrics',
    'socalifornian',
    'color-lyrics',
    '/lyrics/',
    'spclient.wg.spotify',
    'gew4-spclient',
    'api-partner.spotify',
    'encore-lyrics',
  ];

  function looksLikeLyrics(url) {
    if (typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return PATTERNS.some(p => lower.includes(p));
  }

  function hookFetch() {
    window.fetch = async function (...args) {
      const res = await state.origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (looksLikeLyrics(url)) {
        log('fetch intercepté:', url);
        // Capturer l'ID de piste MAINTENANT (réponse en cours de streaming).
        // Le .text() est asynchrone : si la piste change avant sa résolution,
        // processPayload recevrait expectedTrackId ≠ currentTrackId → rejet.
        const capturedTrackId = getCurrentTrackInfo()?.trackId || null;
        res.clone().text()
          .then(text => processPayload(text, capturedTrackId))
          .catch(() => {});
      }
      return res;
    };
    log('✓ Fetch hooké');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 2 — XMLHttpRequest
  ═══════════════════════════════════════════════════════════ */
  function hookXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._lsUrl = url || '';
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (looksLikeLyrics(this._lsUrl)) {
        log('XHR intercepté:', this._lsUrl);
        // Même logique que fetch : capturer l'ID avant l'asynchronisme.
        const capturedTrackId = getCurrentTrackInfo()?.trackId || null;
        this.addEventListener('load', function () {
          try { processPayload(this.responseText, capturedTrackId); } catch {}
        });
      }
      return origSend.apply(this, args);
    };
    log('✓ XHR hooké');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 3 — Polling + hook objet global SpicyLyrics
  ═══════════════════════════════════════════════════════════ */

  /* ── IndexedDB : lecture directe de SpicyLyrics_LyricsStore ──
   *
   * SpicyLyrics stocke ses données parsées (enrichies avec OppositeAligned,
   * Background, Lead complets, etc.) dans IndexedDB sous l'origine
   * https://xpui.app.spotify.com/ — c'est la source la plus fidèle au JSON
   * interne que tu vois dans l'onglet Application des DevTools.
   *
   * On énumère tous les object stores de toutes les IDB ouvertes sur cette
   * origine, puis on tente de lire la clé correspondant au trackId courant.
   *
   * Noms de DB / stores observés :
   *   DB  : "SpicyLyrics" | "spicy-lyrics" | "SpicyLyricsDB" | "lyrics" | …
   *   Store : "LyricsStore" | "lyrics" | "tracks" | "cache" | …
   *
   * Comme on ne peut pas être exhaustif sur les noms exacts (ils peuvent changer
   * entre versions), on ouvre TOUTES les IDB disponibles et on tente de lire
   * dans chaque store avec la clé trackId, ou on fait un getAll() et on filtre.
   */

  // Noms de DB et de stores à tenter (par priorité)
  const IDB_DB_NAMES   = ['SpicyLyrics', 'spicy-lyrics', 'SpicyLyricsDB', 'SpicyLyrics_LyricsStore', 'lyrics', 'spicylyrics'];
  const IDB_STORE_NAMES = ['LyricsStore', 'lyrics', 'tracks', 'cache', 'lyricsCache'];

  /**
   * Ouvre une IDB (sans créer de nouveau schéma) et retourne l'objet db.
   * Retourne null si la DB n'existe pas ou est inaccessible.
   */
  function openIDBReadOnly(dbName) {
    return new Promise(resolve => {
      try {
        // On ouvre sans préciser de version → on obtient la version courante
        const req = indexedDB.open(dbName);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = ()  => resolve(null);
        // onupgradeneeded → DB n'existait pas, on l'annule
        req.onupgradeneeded = e => {
          e.target.transaction?.abort();
          resolve(null);
        };
      } catch { resolve(null); }
    });
  }

  /**
   * Tente de lire les données de paroles depuis IndexedDB pour un trackId donné.
   * Stratégie : tente d'abord une lecture par clé directe (trackId),
   *             puis si ça échoue, fait un getAll() et filtre par trackId.
   * Retourne le premier objet valide trouvé, ou null.
   */
  async function readFromIDB(trackId) {
    for (const dbName of IDB_DB_NAMES) {
      let db = null;
      try {
        db = await openIDBReadOnly(dbName);
        if (!db) continue;

        const storeNames = Array.from(db.objectStoreNames);
        if (!storeNames.length) { db.close(); continue; }

        // On tente chaque store connu + tous les stores réels de la DB
        const storesToTry = [...new Set([...IDB_STORE_NAMES, ...storeNames])];

        for (const storeName of storesToTry) {
          if (!storeNames.includes(storeName)) continue;

          const result = await new Promise(resolve => {
            try {
              const tx    = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);

              // 1. Lecture directe par trackId
              const req = store.get(trackId);
              req.onsuccess = e => {
                const val = e.target.result;
                if (val && (val.Content || val.lines || val.lyrics)) {
                  resolve(val);
                  return;
                }

                // 2. Lecture par trackId préfixé (ex: "spotify:track:XXXXX")
                const req2 = store.get(`spotify:track:${trackId}`);
                req2.onsuccess = e2 => {
                  const val2 = e2.target.result;
                  if (val2 && (val2.Content || val2.lines || val2.lyrics)) {
                    resolve(val2);
                    return;
                  }

                  // 3. getAll() + filtrage
                  const req3 = store.getAll();
                  req3.onsuccess = e3 => {
                    const all = e3.target.result || [];
                    const match = all.find(item =>
                      item?.trackId === trackId ||
                      item?.id      === trackId ||
                      item?.uri?.includes(trackId) ||
                      item?.spotifyId === trackId
                    );
                    resolve(match || null);
                  };
                  req3.onerror = () => resolve(null);
                };
                req2.onerror = () => resolve(null);
              };
              req.onerror = () => resolve(null);
            } catch { resolve(null); }
          });

          if (result) {
            log(`✓ IDB hit : DB="${dbName}" store="${storeName}" trackId="${trackId}"`);
            db.close();
            return result;
          }
        }
        db.close();
      } catch (e) {
        log('readFromIDB error:', e);
        try { db?.close(); } catch {}
      }
    }
    return null;
  }

  /**
   * Sonde l'IndexedDB SpicyLyrics pour la piste en cours.
   * Retourne les données si trouvées (format interne SpicyLyrics enrichi).
   */
  async function pollIDB() {
    const ti = getCurrentTrackInfo();
    if (!ti?.trackId) return null;
    try {
      const data = await readFromIDB(ti.trackId);
      if (data) {
        log('IDB → données trouvées pour', ti.trackName);
        return data;
      }
    } catch (e) { log('pollIDB error:', e); }
    return null;
  }
  function getSpicyLyricsPayload() {
    const candidates = [
      () => window.SpicyLyrics?.CurrentTrackLyrics,
      () => window.SpicyLyrics?.currentLyrics,
      () => window.SpicyLyrics?.lyrics,
      () => window.spicyLyrics?.CurrentTrackLyrics,
      () => window.spicyLyrics?.currentLyrics,
      () => window.spicyLyrics?.NowBar?.currentLyrics,
      () => window.spicyLyrics?.Pages?.lyrics,
      () => window._spicyLyricsData,
      () => window.__spicyLyricsCache,
    ];
    for (const fn of candidates) {
      try { const v = fn(); if (v) return v; } catch {}
    }
    return null;
  }


  /**
   * Hook sur IDBObjectStore.prototype.put / add
   * → intercepte les écritures de SpicyLyrics dans son IDB en temps réel.
   * C'est le moyen le plus fiable pour capter les données enrichies
   * (Background, OppositeAligned) au moment exact où SpicyLyrics les persiste.
   */
  function hookIDBWrites() {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;

    function interceptWrite(val) {
      if (!val || typeof val !== 'object') return;
      // Heuristique : données de paroles si elles ont Content[], lines[], ou structure Lead/Syllables
      if (val.Content || val.lines || val.lyrics || val.Lead || val.Syllables) {
        log('IDB write intercepté — données de paroles détectées');
        processPayload(val);
      }
    }

    IDBObjectStore.prototype.put = function (value, ...rest) {
      try { interceptWrite(value); } catch {}
      return origPut.apply(this, [value, ...rest]);
    };

    IDBObjectStore.prototype.add = function (value, ...rest) {
      try { interceptWrite(value); } catch {}
      return origAdd.apply(this, [value, ...rest]);
    };

    log('✓ IDB writes hookés (put/add)');
  }

  function hookSpicyLyricsObject() {
    let _spicy = window.SpicyLyrics;
    Object.defineProperty(window, 'SpicyLyrics', {
      configurable: true,
      get() { return _spicy; },
      set(v) {
        _spicy = v;
        log('SpicyLyrics object détecté, installation du proxy...');
        hookSpicyLyricsData(v);
      },
    });
  }

  function hookSpicyLyricsData(sl) {
    if (!sl || typeof sl !== 'object') return;
    const props = ['CurrentTrackLyrics', 'currentLyrics', 'lyrics'];
    for (const prop of props) {
      if (prop in sl) {
        let _val = sl[prop];
        try {
          Object.defineProperty(sl, prop, {
            configurable: true,
            get() { return _val; },
            set(v) {
              _val = v;
              if (v) { log(`SpicyLyrics.${prop} mis à jour — traitement`); processPayload(v); }
            },
          });
          log(`✓ Hook sur SpicyLyrics.${prop}`);
        } catch {}
      }
    }
  }

  function startPolling() {
    if (state.pollingTimer) return;
    state.pollingTimer = setInterval(async () => {
      const ti = getCurrentTrackInfo();
      if (!ti?.trackId) return;
      if (CONFIG.deduplicateByTrackId && state.savedTrackIds.has(ti.trackId)) return;

      // Capturer l'ID avant tout await : la piste peut changer pendant un await IDB.
      const capturedTrackId = ti.trackId;

      if (state.queueMode && !state.pending[capturedTrackId]) {
        const trackSeen = state.trackSeenAt[capturedTrackId];
        if (trackSeen && Date.now() - trackSeen > CONFIG.spicyWaitMs * 2) {
          uiAddLog(`⏭ Aucune parole disponible après ${CONFIG.spicyWaitMs * 2 / 1000}s — skip (${ti.trackName})`, 'warn');
          state.savedTrackIds.add(capturedTrackId);
          setTimeout(() => Spicetify?.Player?.next?.(), 500);
          return;
        }
        if (!trackSeen) state.trackSeenAt[capturedTrackId] = Date.now();
      }

      // ── SOURCE 1 : IndexedDB (données enrichies SpicyLyrics) ──
      const idbData = await pollIDB();
      if (idbData) {
        log('Données via IndexedDB SpicyLyrics');
        processPayload(idbData, capturedTrackId);
        return;
      }

      // ── SOURCE 2 : Objet global window.SpicyLyrics ──
      const payload = getSpicyLyricsPayload();
      if (payload) {
        log('Données via window.SpicyLyrics polling');
        processPayload(payload, capturedTrackId);
        return;
      }

      // ── SOURCE 3 : DOM data-attribute ──
      const el = document.querySelector('[data-spicy-lyrics],[data-lyrics-content]');
      if (el) {
        try {
          const raw = el.getAttribute('data-spicy-lyrics')
                   || el.getAttribute('data-lyrics-content')
                   || el.textContent;
          if (raw) processPayload(JSON.parse(raw), capturedTrackId);
        } catch {}
      }
    }, CONFIG.pollingInterval);
    log('✓ Polling démarré (IDB + window + DOM)');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 4 — CustomEvents SpicyLyrics
  ═══════════════════════════════════════════════════════════ */
  function hookSpicyEvents() {
    const spicyEvents = [
      'spicylyrics:lyrics',
      'spicylyrics:update',
      'SpicyLyrics:lyricsLoaded',
      'lyrics:loaded',
      'lyrics:update',
    ];
    for (const evt of spicyEvents) {
      document.addEventListener(evt, e => {
        if (e.detail) {
          log(`CustomEvent ${evt} reçu`);
          processPayload(e.detail);
        }
      });
    }
    log('✓ CustomEvents SpicyLyrics hookés');
  }

  /* ═══════════════════════════════════════════════════════════
     FORÇAGE MANUEL
  ═══════════════════════════════════════════════════════════ */
  async function getSpotifyToken() {
    try {
      const res = await Spicetify?.CosmosAsync?.get('sp://oauth/v2/token');
      return res?.accessToken
        || Spicetify?.Platform?.AuthorizationAPI?.getState?.()?.token
        || null;
    } catch { return null; }
  }

  async function forceCurrentTrack() {
    const ti = getCurrentTrackInfo();
    if (!ti) return uiAddLog('⚠ Aucune piste en cours', 'warn');

    state.savedTrackIds.delete(ti.trackId);
    delete state.pending[ti.trackId];
    // ── Fix : effacer savedScore sinon processPayload voit prevScore >= score
    //         et bloque silencieusement même après un forçage manuel.
    if (state.savedScore) delete state.savedScore[ti.trackId];
    state.retryCount = 0;
    uiAddLog(`↻ Force: ${ti.artistName} — ${ti.trackName}`, 'info');
    uiSetStatus('active');

    // 0. Source prioritaire : IndexedDB SpicyLyrics (données enrichies avec Background, OppositeAligned…)
    try {
      const idbData = await readFromIDB(ti.trackId);
      if (idbData) {
        log('Force → IDB hit (données enrichies SpicyLyrics)');
        uiAddLog('✓ IDB : données enrichies (Background/OppositeAligned)', 'info');
        await processPayload(idbData);
        if (state.savedTrackIds.has(ti.trackId)) return;
      }
    } catch (e) { log('Force IDB erreur:', e); }

    // 0.5. Appel direct api.spicylyrics.org/query (données enrichies garanties)
    //      SpicyLyrics fait ce fetch automatiquement au changement de piste,
    //      mais on peut aussi le déclencher manuellement.
    if (ti.trackId) {
      try {
        // On tente GET d'abord (certaines versions de l'API acceptent GET avec query params)
        const spicyUrl = `https://api.spicylyrics.org/query?trackId=${ti.trackId}&type=lyrics`;
        const spicyRes = await state.origFetch(spicyUrl, {
          headers: { 'Accept': 'application/json' },
        });
        if (spicyRes.ok) {
          const spicyData = await spicyRes.json();
          log('Force → api.spicylyrics.org/query (GET) OK');
          uiAddLog('✓ api.spicylyrics.org/query (données enrichies)', 'info');
          await processPayload(spicyData);
          if (state.savedTrackIds.has(ti.trackId)) return;
        }
      } catch (e) { log('api.spicylyrics.org/query GET échouée:', e); }
    }

    // 1. API Spotify color-lyrics directe (données brutes, sans enrichissement)
    if (ti.trackId) {
      try {
        const token = await getSpotifyToken();
        if (token) {
          const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${ti.trackId}?format=json&vocalRemoval=false`;
          const res = await state.origFetch(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'App-Platform': 'WebPlayer' },
          });
          if (res.ok) {
            const data = await res.json();
            log('Paroles récupérées via API directe Spotify');
            await processPayload(data);
            if (state.savedTrackIds.has(ti.trackId)) return;
          }
        }
      } catch (e) { log('API directe Spotify échouée:', e); }
    }

    const payload = getSpicyLyricsPayload();
    if (payload) {
      log('Données SpicyLyrics disponibles localement');
      await processPayload(payload);
      if (state.savedTrackIds.has(ti.trackId)) return;
    }

    Spicetify?.Player?.seek?.(0);
    uiAddLog('ℹ Seek à 0 — Spicy-Lyrics devrait recharger', 'info');
  }

  /* ═══════════════════════════════════════════════════════════
     MODE FILE AUTO
  ═══════════════════════════════════════════════════════════ */
  function toggleQueueMode() {
    state.queueMode = !state.queueMode;
    const btn = document.getElementById('lsQueueBtn');
    if (btn) {
      btn.textContent = state.queueMode ? '⏹ Arrêter file' : '▶ File auto';
      btn.classList.toggle('off', !state.queueMode);
    }
    uiSetStatus(state.queueMode ? 'active' : 'idle');
    uiAddLog(
      state.queueMode
        ? '▶ Mode file activé — défilement auto après chaque sauvegarde'
        : '⏹ Mode file désactivé',
      state.queueMode ? 'success' : 'info'
    );
    uiUpdateStats();
    if (state.queueMode) {
      const ti = getCurrentTrackInfo();
      if (ti) {
        state.savedTrackIds.delete(ti.trackId);
        // Même fix que forceCurrentTrack : effacer savedScore pour que
        // processPayload accepte de re-sauvegarder la piste en cours.
        if (state.savedScore) delete state.savedScore[ti.trackId];
        Spicetify?.Player?.seek?.(0);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     INTERFACE GRAPHIQUE
  ═══════════════════════════════════════════════════════════ */
  let uiPanel, uiStatusEl, uiLogEl, uiCountEl;

  const CSS = `
    #lsPanel{position:fixed;bottom:90px;right:20px;width:370px;
      background:#111;border:1px solid #2a2a2a;border-radius:14px;
      box-shadow:0 12px 48px rgba(0,0,0,.85);
      font-family:'Circular Sp','Helvetica Neue',sans-serif;font-size:13px;
      color:#aaa;z-index:99999;overflow:hidden;transition:opacity .2s,transform .2s}
    #lsPanel.ls-hidden{opacity:0;pointer-events:none;transform:translateY(12px)}
    #lsHeader{display:flex;align-items:center;justify-content:space-between;
      padding:13px 16px;background:#171717;border-bottom:1px solid #2a2a2a;cursor:move}
    #lsHeader h2{margin:0;font-size:14px;font-weight:700;color:#fff;letter-spacing:.4px}
    #lsHeader h2 span{color:#1DB954}
    #lsClose{background:none;border:none;color:#666;cursor:pointer;font-size:17px;line-height:1;padding:0;transition:color .15s}
    #lsClose:hover{color:#fff}
    #lsMethodBadge{font-size:9px;padding:2px 7px;border-radius:20px;background:#1a1a1a;
      color:#444;border:1px solid #2a2a2a;margin:0 8px 0 auto;letter-spacing:.3px}
    #lsStatus{display:flex;align-items:center;gap:8px;padding:9px 16px;
      background:#141414;border-bottom:1px solid #222;font-size:11.5px}
    #lsDot{width:8px;height:8px;border-radius:50%;background:#444;flex-shrink:0;transition:background .3s}
    #lsDot.idle{background:#444}
    #lsDot.active{background:#1DB954;animation:lsPulse 1.2s infinite}
    #lsDot.parsing{background:#f59e0b;animation:lsPulse .7s infinite}
    #lsDot.error{background:#ef4444}
    @keyframes lsPulse{0%,100%{opacity:1}50%{opacity:.35}}
    #lsStats{display:flex;border-bottom:1px solid #222}
    .ls-stat{flex:1;display:flex;flex-direction:column;align-items:center;
      padding:10px 0;border-right:1px solid #222}
    .ls-stat:last-child{border-right:none}
    .ls-stat .ls-num{font-size:20px;font-weight:700;color:#fff;line-height:1}
    .ls-stat .ls-lbl{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
    #lsConfigRow{display:flex;flex-wrap:wrap;gap:6px;padding:9px 16px;
      border-bottom:1px solid #222;background:#131313}
    .ls-toggle{display:flex;align-items:center;gap:5px;font-size:11px;color:#888;cursor:pointer}
    .ls-toggle input{accent-color:#1DB954;cursor:pointer}
    #lsLog{height:150px;overflow-y:auto;padding:6px 0;
      scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
    .ls-entry{padding:3px 16px;font-size:11px;border-left:2px solid transparent;line-height:1.55}
    .ls-entry.success{border-color:#1DB954;color:#888}
    .ls-entry.warn{border-color:#f59e0b;color:#f59e0b}
    .ls-entry.info{border-color:#333;color:#555}
    .ls-entry.error{border-color:#ef4444;color:#ef4444}
    #lsControls{display:flex;gap:8px;padding:11px 16px;border-top:1px solid #222;background:#161616}
    .ls-btn{flex:1;padding:8px 0;border-radius:7px;border:none;
      font-size:11.5px;font-weight:600;cursor:pointer;transition:background .15s,transform .1s}
    .ls-btn:active{transform:scale(.97)}
    .ls-btn-green{background:#1DB954;color:#000}
    .ls-btn-green:hover{background:#1ed760}
    .ls-btn-green.off{background:#252525;color:#888}
    .ls-btn-grey{background:#252525;color:#fff}
    .ls-btn-grey:hover{background:#303030}
    .ls-btn-red{background:#2d0010;color:#ef4444}
    .ls-btn-red:hover{background:#450018}
    #lsFloatBtn{position:fixed;bottom:90px;right:20px;width:44px;height:44px;
      border-radius:50%;background:#1DB954;border:none;cursor:pointer;
      display:none;align-items:center;justify-content:center;
      box-shadow:0 4px 18px rgba(29,185,84,.45);z-index:99998;
      font-size:19px;transition:transform .15s}
    #lsFloatBtn:hover{transform:scale(1.1)}
    #lsFloatBtn.visible{display:flex}
  `;

  function buildUI() {
    if (document.getElementById('lsPanel')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    uiPanel = document.createElement('div');
    uiPanel.id = 'lsPanel';
    uiPanel.innerHTML = `
      <div id="lsHeader">
        <h2>🎵 Lyrics<span>Saver</span></h2>
        <span id="lsMethodBadge">fetch · xhr · poll · events</span>
        <button id="lsClose">✕</button>
      </div>
      <div id="lsStatus">
        <div id="lsDot" class="idle"></div>
        <span id="lsStatusText">En attente d'une piste…</span>
      </div>
      <div id="lsStats">
        <div class="ls-stat"><span class="ls-num" id="lsCount">0</span><span class="ls-lbl">Sauvegardées</span></div>
        <div class="ls-stat"><span class="ls-num" id="lsModeLabel">Manuel</span><span class="ls-lbl">Mode</span></div>
        <div class="ls-stat"><span class="ls-num" id="lsSyncType">—</span><span class="ls-lbl">Sync</span></div>
      </div>
      <div id="lsConfigRow">
        <label class="ls-toggle"><input type="checkbox" id="lsCbWord" ${CONFIG.preferWordSync ? 'checked' : ''}> Mot-par-mot</label>
        <label class="ls-toggle"><input type="checkbox" id="lsCbDedup" ${CONFIG.deduplicateByTrackId ? 'checked' : ''}> Dédoublonnage</label>
        <label class="ls-toggle"><input type="checkbox" id="lsCbSkip" ${CONFIG.autoSkipAfterSave ? 'checked' : ''}> Auto-skip</label>
      </div>
      <div id="lsLog"></div>
      <div id="lsControls">
        <button class="ls-btn ls-btn-green off" id="lsQueueBtn">▶ File auto</button>
        <button class="ls-btn ls-btn-grey"      id="lsNowBtn">⬇ Piste actuelle</button>
        <button class="ls-btn ls-btn-grey"      id="lsCopyLogBtn">📋 Copier log</button>
      </div>
    `;
    document.body.appendChild(uiPanel);

    const floatBtn = document.createElement('button');
    floatBtn.id = 'lsFloatBtn';
    floatBtn.textContent = '🎵';
    floatBtn.title = 'Ouvrir LyricsSaver';
    document.body.appendChild(floatBtn);

    uiStatusEl = document.getElementById('lsStatusText');
    uiLogEl    = document.getElementById('lsLog');
    uiCountEl  = document.getElementById('lsCount');

    document.getElementById('lsClose').onclick      = () => { uiPanel.classList.add('ls-hidden'); floatBtn.classList.add('visible'); };
    floatBtn.onclick                                = () => { uiPanel.classList.remove('ls-hidden'); floatBtn.classList.remove('visible'); };
    document.getElementById('lsCopyLogBtn').onclick = () => {
      const lines = [...uiLogEl.querySelectorAll('.ls-entry')].map(e => e.textContent).join('\n');
      navigator.clipboard.writeText(lines).then(
        () => { Spicetify?.showNotification?.('[LyricsSaver] Log copié ✓'); uiAddLog('📋 Log copié', 'info'); },
        () => uiAddLog('⚠ Copie échouée', 'warn')
      );
    };
    document.getElementById('lsNowBtn').onclick   = forceCurrentTrack;
    document.getElementById('lsQueueBtn').onclick = toggleQueueMode;

    document.getElementById('lsCbWord').onchange  = e => { CONFIG.preferWordSync        = e.target.checked; };
    document.getElementById('lsCbDedup').onchange = e => { CONFIG.deduplicateByTrackId  = e.target.checked; };
    document.getElementById('lsCbSkip').onchange  = e => { CONFIG.autoSkipAfterSave     = e.target.checked; };

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        const hidden = uiPanel.classList.toggle('ls-hidden');
        floatBtn.classList.toggle('visible', hidden);
      }
    });

    try {
      if (Spicetify?.Topbar?.Button) {
        new Spicetify.Topbar.Button(
          'LyricsSaver',
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`,
          () => { const h = uiPanel.classList.toggle('ls-hidden'); floatBtn.classList.toggle('visible', h); }
        );
        floatBtn.classList.remove('visible');
        log('✓ Bouton Topbar Spicetify enregistré');
      } else {
        floatBtn.classList.add('visible');
        log('⚠ Topbar indisponible — bouton flottant actif (Ctrl+Shift+L)');
      }
    } catch (err) {
      floatBtn.classList.add('visible');
      log('⚠ Topbar erreur — bouton flottant actif:', err);
    }

    makeDraggable(uiPanel, document.getElementById('lsHeader'));
    uiUpdateStats();
    log('✓ Interface graphique montée');
  }

  function makeDraggable(el, handle) {
    let ox, oy, sx, sy;
    handle.addEventListener('mousedown', e => {
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      const mv = e => {
        el.style.right  = 'auto'; el.style.bottom = 'auto';
        el.style.left   = `${Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  ox + e.clientX - sx))}px`;
        el.style.top    = `${Math.max(0, Math.min(window.innerHeight - el.offsetHeight, oy + e.clientY - sy))}px`;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function uiSetStatus(s) {
    const dot = document.getElementById('lsDot');
    if (!dot) return;
    dot.className = s;
    const msgs = { idle: 'En attente…', active: 'Interception active', parsing: 'Analyse des paroles…', error: 'Erreur' };
    if (uiStatusEl) uiStatusEl.textContent = msgs[s] || s;
  }

  function uiAddLog(msg, type = 'info') {
    if (!uiLogEl) return;
    const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const div = Object.assign(document.createElement('div'), {
      className  : `ls-entry ${type}`,
      textContent: `[${t}] ${msg}`,
    });
    uiLogEl.appendChild(div);
    uiLogEl.scrollTop = uiLogEl.scrollHeight;
  }

  function uiUpdateStats() {
    if (uiCountEl) uiCountEl.textContent = state.totalSaved;
    const ml = document.getElementById('lsModeLabel');
    if (ml) ml.textContent = state.queueMode ? 'File' : 'Manuel';
  }

  /* ═══════════════════════════════════════════════════════════
     ÉVÉNEMENTS PLAYER
  ═══════════════════════════════════════════════════════════ */
  function setupPlayerEvents() {
    Spicetify.Player.addEventListener('songchange', () => {
      const ti = getCurrentTrackInfo();
      if (!ti || ti.trackId === state.currentTrackId) return;
      state.currentTrackId = ti.trackId;
      state.retryCount     = 0;

      // ── Sauvegarde d'urgence des paroles en attente ──────────────────
      // Avant mon fix, les timers pendants étaient simplement annulés (clearTimeout)
      // → les paroles des chansons avec score < 100 étaient définitivement perdues.
      // Maintenant on sauvegarde immédiatement avant de passer à la piste suivante.
      for (const id of Object.keys(state.pending)) {
        if (id !== ti.trackId) {
          const { timer, bestLyrics, rawData, trackInfo } = state.pending[id];
          clearTimeout(timer);
          delete state.pending[id];
          if (bestLyrics && trackInfo) {
            const sc = qualityScore(bestLyrics);
            if ((state.savedScore?.[id] ?? 0) < sc) {
              log(`♪ songchange → sauvegarde urgente : ${trackInfo.trackName} (${qualityLabel(sc)})`);
              // Fire-and-forget — on ne peut pas await ici (handler synchrone)
              saveLyrics(trackInfo, bestLyrics, sc, rawData).catch(() => {});
            }
          }
        }
      }

      delete state.trackSeenAt[ti.trackId];
      // Ne pas effacer savedScore pour la piste en cours (permet upgrade si elle revient)
      // Mais effacer les anciennes pistes pour libérer la mémoire
      if (state.savedScore) {
        const keep = new Set(state.savedTrackIds);
        for (const k of Object.keys(state.savedScore)) {
          if (!keep.has(k)) delete state.savedScore[k];
        }
      }

      uiAddLog(`♪ ${ti.artistName} — ${ti.trackName}`, 'info');
      uiSetStatus(state.queueMode ? 'active' : 'idle');
      const st = document.getElementById('lsSyncType');
      if (st) st.textContent = '…';
    });
  }

  /* ═══════════════════════════════════════════════════════════
     API PUBLIQUE
  ═══════════════════════════════════════════════════════════ */
  function setupAPI() {
    window.SpotifyLyricsSaver = {
      config     : CONFIG,
      state,
      toggleQueue: toggleQueueMode,
      forceNow   : forceCurrentTrack,
      clearSaved : () => {
        state.savedTrackIds.clear();
        state.savedScore = {};
        uiAddLog('Cache vidé', 'info');
      },

      // Dump l'objet global SpicyLyrics (window.SpicyLyrics)
      dumpRaw    : () => {
        const p = getSpicyLyricsPayload();
        console.log('[LyricsSaver] Raw window.SpicyLyrics data:', p);
        return p;
      },

      // Liste toutes les IndexedDB disponibles sur cette origine
      listIDBs   : async () => {
        try {
          const dbs = await indexedDB.databases();
          console.log('[LyricsSaver] IndexedDB disponibles:', dbs);
          return dbs;
        } catch (e) {
          console.warn('[LyricsSaver] indexedDB.databases() non supporté:', e);
          // Fallback : tenter d'ouvrir chacun de nos noms connus
          const found = [];
          for (const name of IDB_DB_NAMES) {
            const db = await openIDBReadOnly(name);
            if (db) {
              found.push({ name, stores: Array.from(db.objectStoreNames) });
              db.close();
            }
          }
          console.log('[LyricsSaver] IDBs trouvées (fallback):', found);
          return found;
        }
      },

      // Lit l'IDB pour la piste en cours et dump le résultat brut
      dumpIDB    : async (trackId) => {
        const ti = getCurrentTrackInfo();
        const id = trackId || ti?.trackId;
        if (!id) { console.warn('[LyricsSaver] Pas de trackId'); return null; }
        const data = await readFromIDB(id);
        console.log(`[LyricsSaver] IDB dump pour ${id}:`, data);
        return data;
      },

      // Ouvre toutes les IDB connues et liste leurs stores + nb d'entrées
      inspectIDB : async () => {
        const report = [];
        let dbNames = IDB_DB_NAMES;
        try {
          const all = await indexedDB.databases();
          dbNames = [...new Set([...all.map(d => d.name), ...IDB_DB_NAMES])];
        } catch {}
        for (const dbName of dbNames) {
          const db = await openIDBReadOnly(dbName);
          if (!db) continue;
          const entry = { db: dbName, stores: {} };
          for (const storeName of Array.from(db.objectStoreNames)) {
            await new Promise(res => {
              try {
                const tx    = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req   = store.count();
                req.onsuccess = e => { entry.stores[storeName] = e.target.result; res(); };
                req.onerror   = ()  => { entry.stores[storeName] = '?'; res(); };
              } catch { entry.stores[storeName] = 'ERR'; res(); }
            });
          }
          report.push(entry);
          db.close();
        }
        console.table(report.flatMap(r =>
          Object.entries(r.stores).map(([s, c]) => ({ DB: r.db, Store: s, Entries: c }))
        ));
        return report;
      },
    };
  }

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  function activateAll() {
    buildUI();
    hookIDBWrites();          // ← EN PREMIER : patche put/add avant que SpicyLyrics écrive
    hookSpicyLyricsObject();  // ← avant hookFetch pour capter l'objet global en premier
    hookFetch();
    hookXHR();
    hookSpicyEvents();
    startPolling();
    setupPlayerEvents();
    setupAPI();
    state.interceptActive = true;
    uiSetStatus('active');
    uiAddLog('IDB writes + fetch + XHR + events + polling activés', 'success');
    Spicetify?.showNotification?.('[LyricsSaver] Extension prête ✓');
    log('✓ Toutes les méthodes d\'interception actives (IDB prioritaire)');
  }

  let attempts = 0;
  const wait = setInterval(() => {
    if (Spicetify?.Player && Spicetify?.showNotification) {
      clearInterval(wait);
      activateAll();
    }
    if (++attempts > 30) {
      clearInterval(wait);
      log('⚠ Spicetify timeout — activation partielle');
      buildUI();
      hookIDBWrites();
      hookSpicyLyricsObject();
      hookFetch();
      hookXHR();
      hookSpicyEvents();
      startPolling();
      uiAddLog('⚠ Spicetify non détecté — mode dégradé (IDB actif)', 'warn');
    }
  }, 500);

})();
