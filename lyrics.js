// spotify-lyrics-saver.js — v4 — Compatible Spicy-Lyrics v5.20+
// Fix critique : IsPartOfWord sur syllabe courante + hook SpicyLyrics interne

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
   * Parse le format Spicy-Lyrics v5 word-sync.
   *
   * Structure attendue :
   * {
   *   Content: [
   *     {
   *       Type: "Vocal",
   *       Lead: {
   *         StartTime: <secondes>,
   *         EndTime:   <secondes>,
   *         Syllables: [
   *           { Text: "Hel", StartTime: <s>, EndTime: <s>, IsPartOfWord: true  },
   *           { Text: "lo",  StartTime: <s>, EndTime: <s>, IsPartOfWord: false },
   *           ...
   *         ]
   *       }
   *     }
   *   ]
   * }
   *
   * IsPartOfWord:
   *   true  → la syllabe est attachée à la suivante (même mot, on continue)
   *   false → la syllabe clôt le mot courant
   */
  function parseSpicyWordSync(result) {
    try {
      if (!result?.Content) return null;
      const lines = [];

      for (const item of result.Content) {
        // Accepter 'Vocal' et variantes de casse
        const type = (item.Type || item.type || '').toLowerCase();
        if (type !== 'vocal') continue;

        const lead = item.Lead || item.lead;
        if (!lead?.Syllables?.length) continue;

        const syls    = lead.Syllables;
        const startMs = toMs(lead.StartTime);
        const endMs   = toMs(lead.EndTime);
        const words   = [];

        let cur = null; // { text, startTime, endTime }

        for (let i = 0; i < syls.length; i++) {
          const s = syls[i];
          const sylText = s.Text || s.text || '';

          // Initialiser le mot en cours
          if (!cur) {
            cur = { text: '', startTime: toMs(s.StartTime || s.startTime), endTime: 0 };
          }

          cur.text   += sylText;
          cur.endTime = toMs(s.EndTime || s.endTime);

          // ✅ FIX CRITIQUE : IsPartOfWord sur la syllabe COURANTE
          //   true  → encore des syllabes à fusionner → on continue
          //   false/undefined → fin du mot courant
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

        const lineText = syls.map(s => s.Text || s.text || '').join('').trim();
        if (lineText) {
          lines.push({ text: lineText, startTime: startMs, endTime: endMs, words });
        }
      }

      if (!lines.length) return null;

      // Vérifier qu'on a bien des mots (sinon c'est du LINE déguisé)
      const totalWords = lines.reduce((n, l) => n + (l.words?.length || 0), 0);
      if (totalWords === 0) return null;

      log(`✓ WORD parsé : ${lines.length} lignes, ${totalWords} mots`);
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

  function toMs(val) {
    if (!val) return 0;
    const n = Number(val);
    // SpicyLyrics donne des secondes (ex: 10.5), Spotify donne des ms (ex: 10500)
    // Heuristique : si < 10000 → secondes → convertir en ms
    return n < 10000 ? Math.round(n * 1000) : Math.round(n);
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

    // 1. Spicy-Lyrics v5 word-sync direct (Content[])
    if (Array.isArray(data.Content)) {
      if (CONFIG.preferWordSync) {
        const ws = parseSpicyWordSync(data);
        if (ws) return ws;
      }
      // Fallback LINE immédiat si WORD indisponible ou désactivé
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
      if (lines.length) return { syncType: 'LINE', provider: 'spicylyrics-line', lines };
    }

    // 2. Enveloppé dans queries[]
    if (Array.isArray(data.queries)) {
      for (const q of data.queries) {
        if (q.operation === 'lyrics' && q.result?.data) {
          const r = q.result.data;
          const ws = CONFIG.preferWordSync ? parseSpicyWordSync(r) : null;
          return ws
              || (r.lines && parseLineSync(r.lines, 'spicylyrics'))
              || null;
        }
      }
    }

    // 3. Spotify color-lyrics API
    if (data.lyrics?.lines) return parseLineSync(data.lyrics.lines, 'spotify');

    // 4. Lignes directes
    if (Array.isArray(data.lines)) return parseLineSync(data.lines, 'unknown');

    // 5. Structures imbriquées
    if (data.result?.lines)       return parseLineSync(data.result.lines, 'unknown');
    if (data.data?.lines)         return parseLineSync(data.data.lines, 'unknown');
    if (data.result?.data?.lines) return parseLineSync(data.result.data.lines, 'spicylyrics');

    return null;
  }

  /* ═══════════════════════════════════════════════════════════
     SAUVEGARDE
  ═══════════════════════════════════════════════════════════ */
  async function saveLyrics(trackInfo, lyricsData) {
    const wordCount = lyricsData.lines.reduce((s, l) => s + (l.words?.length || 0), 0);
    const output = {
      metadata: {
        track       : trackInfo.trackName,
        artist      : trackInfo.artistName,
        album       : trackInfo.albumName,
        trackId     : trackInfo.trackId,
        downloadedAt: new Date().toISOString(),
        syncType    : lyricsData.syncType,
        provider    : lyricsData.provider || 'unknown',
        lineCount   : lyricsData.lines.length,
        wordCount,
        songWriters : lyricsData.songWriters || [],
        duration    : lyricsData.duration || null,
      },
      lyrics: lyricsData,
    };

    const filename = `${sanitize(trackInfo.artistName)} - ${sanitize(trackInfo.trackName)}.json`;
    const blob     = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const a        = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 300);

    state.savedTrackIds.add(trackInfo.trackId);
    state.totalSaved++;
    state.retryCount = 0;

    const st = document.getElementById('lsSyncType');
    if (st) st.textContent = lyricsData.syncType;

    log(`✓ ${filename} (${output.metadata.lineCount} lignes, ${wordCount} mots)`);
    uiAddLog(`✓ ${trackInfo.artistName} — ${trackInfo.trackName} [${lyricsData.syncType}]`, 'success');
    uiSetStatus('idle');
    uiUpdateStats();
    Spicetify?.showNotification?.(`[Lyrics] ✓ ${trackInfo.trackName} (${lyricsData.syncType})`);

    if (CONFIG.autoSkipAfterSave && state.queueMode) {
      uiAddLog(`⏭ Skip dans ${CONFIG.autoSkipDelay}ms…`, 'info');
      setTimeout(() => Spicetify?.Player?.next?.(), CONFIG.autoSkipDelay);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     TRAITEMENT PAYLOAD
  ═══════════════════════════════════════════════════════════ */
  async function processPayload(raw, { force = false } = {}) {
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
    if (CONFIG.deduplicateByTrackId && state.savedTrackIds.has(ti.trackId)) return;

    uiSetStatus('parsing');
    const lyrics = autoDetect(data);
    if (!lyrics) { uiSetStatus(state.queueMode ? 'active' : 'idle'); return; }

    const id = ti.trackId;

    if (lyrics.syncType === 'WORD') {
      // WORD reçu → annuler timer d'attente + sauvegarder immédiatement
      if (state.pending[id]) {
        clearTimeout(state.pending[id].timer);
        delete state.pending[id];
      }
      if (state.savedTrackIds.has(id)) return;
      log(`► WORD pour ${ti.trackName}`);
      uiAddLog(`🔤 WORD reçu — ${ti.trackName}`, 'info');
      await saveLyrics(ti, lyrics);

    } else {
      // LINE/NONE
      if (state.savedTrackIds.has(id)) return;

      // En mode force (bouton "Piste actuelle") : sauvegarder immédiatement sans attendre WORD
      if (force) {
        if (state.pending[id]) { clearTimeout(state.pending[id].timer); delete state.pending[id]; }
        uiAddLog(`↓ ${lyrics.syncType} (force) — ${ti.trackName}`, 'info');
        await saveLyrics(ti, lyrics);
        return;
      }

      // Sinon → mettre en attente pour laisser une chance au WORD
      if (state.pending[id]) {
        // Déjà en attente : garder le meilleur (LINE > NONE)
        if (lyrics.syncType === 'LINE' && state.pending[id].bestLyrics?.syncType === 'NONE') {
          state.pending[id].bestLyrics = lyrics;
        }
        return;
      }

      uiAddLog(`⏳ ${ti.trackName} — attente WORD (${CONFIG.spicyWaitMs / 1000}s)…`, 'info');

      const timer = setTimeout(async () => {
        const best = state.pending[id]?.bestLyrics || lyrics;
        delete state.pending[id];
        if (state.savedTrackIds.has(id)) return;
        uiAddLog(`↓ Fallback ${best.syncType} pour ${ti.trackName}`, 'info');
        await saveLyrics(ti, best);
      }, CONFIG.spicyWaitMs);

      state.pending[id] = { timer, bestLyrics: lyrics };
    }
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 1 — Fetch
  ═══════════════════════════════════════════════════════════ */
  const PATTERNS = [
    'spicylyrics',
    'beautiful-lyrics',   // domaine réel de Spicy-Lyrics v5
    'socalifornian',      // domaine réel de Spicy-Lyrics v5
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
        res.clone().text().then(processPayload).catch(() => {});
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
        this.addEventListener('load', function () {
          try { processPayload(this.responseText); } catch {}
        });
      }
      return origSend.apply(this, args);
    };
    log('✓ XHR hooké');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 3 — Polling + hook objet global SpicyLyrics
  ═══════════════════════════════════════════════════════════ */

  // Chemins possibles pour accéder aux données de paroles dans SpicyLyrics v5
  function getSpicyLyricsPayload() {
    const candidates = [
      () => window.SpicyLyrics?.CurrentTrackLyrics,
      () => window.SpicyLyrics?.currentLyrics,
      () => window.SpicyLyrics?.lyrics,
      () => window.spicyLyrics?.CurrentTrackLyrics,
      () => window.spicyLyrics?.currentLyrics,
      () => window.spicyLyrics?.NowBar?.currentLyrics,
      () => window.spicyLyrics?.Pages?.lyrics,
      // Spicy-Lyrics v5 peut stocker dans Spicetify.Platform ou modules internes
      () => window._spicyLyricsData,
      () => window.__spicyLyricsCache,
    ];
    for (const fn of candidates) {
      try { const v = fn(); if (v) return v; } catch {}
    }
    return null;
  }

  // Tenter d'accrocher l'objet SpicyLyrics dès qu'il apparaît (defineProperty trap)
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
    // Tenter de proxifier CurrentTrackLyrics
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
    state.pollingTimer = setInterval(() => {
      const ti = getCurrentTrackInfo();
      if (!ti?.trackId) return;
      if (CONFIG.deduplicateByTrackId && state.savedTrackIds.has(ti.trackId)) return;

      // Gestion skip automatique si aucune parole après 2x spicyWaitMs
      if (state.queueMode && !state.pending[ti.trackId]) {
        const trackSeen = state.trackSeenAt[ti.trackId];
        if (trackSeen && Date.now() - trackSeen > CONFIG.spicyWaitMs * 2) {
          uiAddLog(`⏭ Aucune parole détectée — skip (${ti.trackName})`, 'warn');
          state.savedTrackIds.add(ti.trackId);
          setTimeout(() => Spicetify?.Player?.next?.(), 500);
          return;
        }
        if (!trackSeen) state.trackSeenAt[ti.trackId] = Date.now();
      }

      // Polling objet global SpicyLyrics
      const payload = getSpicyLyricsPayload();
      if (payload) {
        log('Données via window.SpicyLyrics polling');
        processPayload(payload);
        return;
      }

      // DOM data-attribute
      const el = document.querySelector('[data-spicy-lyrics],[data-lyrics-content]');
      if (el) {
        try {
          const raw = el.getAttribute('data-spicy-lyrics')
                   || el.getAttribute('data-lyrics-content')
                   || el.textContent;
          if (raw) processPayload(JSON.parse(raw));
        } catch {}
      }
    }, CONFIG.pollingInterval);
    log('✓ Polling démarré');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPTION 4 — CustomEvents SpicyLyrics
     Spicy-Lyrics v5 peut dispatcher des événements DOM
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
    state.retryCount = 0;
    uiAddLog(`↻ Force: ${ti.artistName} — ${ti.trackName}`, 'info');
    uiSetStatus('active');

    // 1. Tentative via API Spotify color-lyrics directe
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
            await processPayload(data, { force: true });
            if (state.savedTrackIds.has(ti.trackId)) return;
          }
        }
      } catch (e) { log('API directe Spotify échouée:', e); }
    }

    // 2. Polling manuel des données SpicyLyrics disponibles
    const payload = getSpicyLyricsPayload();
    if (payload) {
      log('Données SpicyLyrics disponibles localement');
      await processPayload(payload, { force: true });
      if (state.savedTrackIds.has(ti.trackId)) return;
    }

    // 3. Seek à 0 pour forcer le rechargement par Spicy-Lyrics
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
      if (ti) { state.savedTrackIds.delete(ti.trackId); Spicetify?.Player?.seek?.(0); }
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

      // Annuler les timers des pistes précédentes
      for (const id of Object.keys(state.pending)) {
        if (id !== ti.trackId) {
          clearTimeout(state.pending[id].timer);
          delete state.pending[id];
        }
      }
      delete state.trackSeenAt[ti.trackId];

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
      clearSaved : () => { state.savedTrackIds.clear(); uiAddLog('Cache vidé', 'info'); },
      // Outil de diagnostic : dump les données SpicyLyrics brutes dans la console
      dumpRaw    : () => {
        const p = getSpicyLyricsPayload();
        console.log('[LyricsSaver] Raw SpicyLyrics data:', p);
        return p;
      },
    };
  }

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  function activateAll() {
    buildUI();
    hookSpicyLyricsObject(); // avant hookFetch pour capter l'objet global en premier
    hookFetch();
    hookXHR();
    hookSpicyEvents();
    startPolling();
    setupPlayerEvents();
    setupAPI();
    state.interceptActive = true;
    uiSetStatus('active');
    uiAddLog('fetch + XHR + events + polling activés', 'success');
    Spicetify?.showNotification?.('[LyricsSaver] Extension prête ✓');
    log('✓ Toutes les méthodes d\'interception actives');
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
      hookSpicyLyricsObject();
      hookFetch();
      hookXHR();
      hookSpicyEvents();
      startPolling();
      uiAddLog('⚠ Spicetify non détecté — mode dégradé', 'warn');
    }
  }, 500);

})();
