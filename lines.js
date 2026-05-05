// spotify-line-lyrics.js — v2.0
// Paroles LINE-sync via endpoint natif Spotify | Sortie : .lrc | Auto à chaque piste
// Panel : haut-droite, réduit par défaut | Logs détaillés dans la console

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════════════════════ */
  const CONFIG = {
    debug             : true,
    deduplicateByTrack: true,
  };

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  const state = {
    savedTrackIds: new Set(),
    totalSaved   : 0,
  };

  /* ═══════════════════════════════════════════════════════════
     LOG CONSOLE (détaillé)
  ═══════════════════════════════════════════════════════════ */
  const log = {
    info : (...a) => CONFIG.debug && console.log   ('%c[LineLyrics]', 'color:#1DB954;font-weight:bold', ...a),
    warn : (...a) =>                 console.warn  ('%c[LineLyrics]', 'color:#f59e0b;font-weight:bold', ...a),
    error: (...a) =>                 console.error ('%c[LineLyrics]', 'color:#ef4444;font-weight:bold', ...a),
    group: (label) => CONFIG.debug && console.group ('%c[LineLyrics] ' + label, 'color:#1DB954;font-weight:bold'),
    end  : ()      => CONFIG.debug && console.groupEnd(),
  };

  /* ═══════════════════════════════════════════════════════════
     UTILS
  ═══════════════════════════════════════════════════════════ */
  function sanitize(s) {
    return s.replace(/[<>:"/\\|?*\[\]\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  }

  function toMs(val) {
    if (!val) return 0;
    const n = Number(val);
    return n < 10000 ? Math.round(n * 1000) : Math.round(n);
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
    } catch (e) { log.error('getCurrentTrackInfo:', e); return null; }
  }

  async function getToken() {
    try {
      const res = await Spicetify?.CosmosAsync?.get('sp://oauth/v2/token');
      const token = res?.accessToken
        || Spicetify?.Platform?.AuthorizationAPI?.getState?.()?.token
        || null;
      if (token) log.info('Token récupéré ✓');
      else       log.warn('Token introuvable — toutes les sources épuisées');
      return token;
    } catch (e) { log.error('getToken:', e); return null; }
  }

  /* ═══════════════════════════════════════════════════════════
     FETCH — endpoint natif Spotify color-lyrics v2
  ═══════════════════════════════════════════════════════════ */
  async function fetchLyrics(trackId) {
    log.info(`fetchLyrics → trackId: ${trackId}`);
    const token = await getToken();
    if (!token) { uiAddLog('⚠ Token indisponible', 'warn'); return null; }

    const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false`;
    log.info('GET', url);

    try {
      // Bypasser le hook fetch de lyrics.js via son origFetch stocké
      const nativeFetch = window.SpotifyLyricsSaver?.state?.origFetch ?? window.fetch;
      const res = await nativeFetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'App-Platform': 'WebPlayer' },
      });
      log.info(`Réponse HTTP: ${res.status} ${res.statusText}`);
      if (!res.ok) {
        log.warn(`HTTP ${res.status} — pas de paroles pour ${trackId}`);
        uiAddLog(`⚠ HTTP ${res.status}`, 'warn');
        return null;
      }
      const data = await res.json();
      log.group('Payload brut');
      log.info(data);
      log.end();
      const parsed = parseLyrics(data);
      return parsed ? { raw: data, parsed } : null;
    } catch (e) {
      log.error('fetchLyrics réseau:', e);
      uiAddLog('⚠ Erreur réseau', 'warn');
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PARSER
  ═══════════════════════════════════════════════════════════ */
  function parseLyrics(data) {
    const raw = data?.lyrics;
    if (!raw) { log.warn('parseLyrics: data.lyrics absent'); return null; }
    if (!raw.lines?.length) { log.warn('parseLyrics: lines[] vide'); return null; }

    log.info(`syncType détecté: ${raw.syncType || '(absent)'} | langue: ${raw.language || '?'} | ${raw.lines.length} lignes brutes`);

    const lines = raw.lines
      .map(l => ({
        text     : (l.words || '').trim(),
        startTime: toMs(l.startTimeMs ?? 0),
        endTime  : toMs(l.endTimeMs   ?? 0),
      }))
      .filter(l => l.text && l.text !== '♪');

    log.info(`Lignes après filtrage: ${lines.length}`);
    if (!lines.length) { log.warn('parseLyrics: aucune ligne exploitable'); return null; }

    return {
      syncType: raw.syncType || 'LINE_SYNCED',
      provider: 'spotify-color-lyrics',
      language: raw.language || null,
      lines,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     EXPORT LRC
     Format standard : [mm:ss.xx]texte
  ═══════════════════════════════════════════════════════════ */
  function exportLRC(trackInfo, lyrics) {
    const header = [
      `[ti:${trackInfo.trackName}]`,
      `[ar:${trackInfo.artistName}]`,
      `[al:${trackInfo.albumName}]`,
      `[by:spotify-line-lyrics]`,
      `[re:spotify-color-lyrics]`,
      '',
    ].join('\n');

    const body = lyrics.lines.map(l => {
      const ms  = l.startTime;
      const min = String(Math.floor(ms / 60000)).padStart(2, '0');
      const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const cs  = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
      return `[${min}:${sec}.${cs}]${l.text}`;
    }).join('\n');

    const content  = header + body;
    const filename = `${sanitize(trackInfo.artistName)} - ${sanitize(trackInfo.trackName)}.lrc`;

    log.group(`Export LRC → ${filename}`);
    log.info(`${lyrics.lines.length} lignes | syncType: ${lyrics.syncType} | langue: ${lyrics.language || '?'}`);
    log.info('Aperçu (5 premières lignes):\n' + lyrics.lines.slice(0, 5).map(l => `  [${l.startTime}ms] ${l.text}`).join('\n'));
    log.end();

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 300);
  }

  /* ═══════════════════════════════════════════════════════════
     EXPORT RAW JSON
     Sauvegarde la réponse brute de l'endpoint Spotify
  ═══════════════════════════════════════════════════════════ */
  function exportRaw(trackInfo, rawData) {
    const filename = `${sanitize(trackInfo.artistName)} - ${sanitize(trackInfo.trackName)}.json`;
    const content  = JSON.stringify(rawData, null, 2);

    log.group(`Export RAW → ${filename}`);
    log.info(`Taille payload: ${content.length} caractères`);
    log.end();

    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 300);
  }


  async function processTrack(ti, { force = false } = {}) {
    log.group(`processTrack: ${ti.artistName} — ${ti.trackName}`);
    log.info(`trackId: ${ti.trackId} | force: ${force} | déjà sauvegardé: ${state.savedTrackIds.has(ti.trackId)}`);

    if (!force && CONFIG.deduplicateByTrack && state.savedTrackIds.has(ti.trackId)) {
      log.info('Dédoublonnage — piste ignorée');
      log.end();
      return;
    }

    uiSetStatus('fetching');
    const result = await fetchLyrics(ti.trackId);

    if (!result) {
      log.warn(`Aucune parole exploitable pour "${ti.trackName}"`);
      log.end();
      uiAddLog(`✗ Pas de paroles — ${ti.trackName}`, 'warn');
      uiSetStatus('idle');
      return;
    }

    const { raw, parsed: lyrics } = result;

    exportRaw(ti, raw);
    exportLRC(ti, lyrics);
    state.savedTrackIds.add(ti.trackId);
    state.totalSaved++;

    log.info(`✓ Sauvegardé | total: ${state.totalSaved}`);
    log.end();

    const st = document.getElementById('llSyncType');
    if (st) st.textContent = lyrics.syncType === 'LINE_SYNCED' ? 'LINE' : 'NONE';

    uiAddLog(`✓ ${ti.artistName} — ${ti.trackName} [${lyrics.syncType}] · .json + .lrc`, 'success');
    uiSetStatus('idle');
    uiUpdateCount();
    Spicetify?.showNotification?.(`[LineLyrics] ✓ ${ti.trackName}`);
  }

  /* ═══════════════════════════════════════════════════════════
     ÉVÉNEMENTS PLAYER
  ═══════════════════════════════════════════════════════════ */
  function setupPlayerEvents() {
    Spicetify.Player.addEventListener('songchange', () => {
      const ti = getCurrentTrackInfo();
      if (!ti) return;
      log.info(`songchange → ${ti.artistName} — ${ti.trackName}`);
      uiAddLog(`♪ ${ti.artistName} — ${ti.trackName}`, 'info');
      const st = document.getElementById('llSyncType');
      if (st) st.textContent = '…';
      processTrack(ti);
    });
    log.info('Événement songchange enregistré');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERFACE — haut-droite, réduite par défaut
  ═══════════════════════════════════════════════════════════ */
  let uiLogEl;

  const CSS = `
    #llFloatBtn{position:fixed;top:16px;right:20px;width:34px;height:34px;
      border-radius:50%;background:#1DB954;border:none;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 14px rgba(29,185,84,.4);z-index:99998;
      font-size:15px;transition:transform .15s,opacity .15s}
    #llFloatBtn:hover{transform:scale(1.1)}
    #llPanel{position:fixed;top:56px;right:20px;width:290px;
      background:#111;border:1px solid #2a2a2a;border-radius:12px;
      box-shadow:0 12px 48px rgba(0,0,0,.85);
      font-family:'Circular Sp','Helvetica Neue',sans-serif;font-size:13px;
      color:#aaa;z-index:99999;overflow:hidden;transition:opacity .2s,transform .2s}
    #llPanel.ll-hidden{opacity:0;pointer-events:none;transform:translateY(-8px)}
    #llHeader{display:flex;align-items:center;justify-content:space-between;
      padding:11px 14px;background:#171717;border-bottom:1px solid #2a2a2a;cursor:move}
    #llHeader h2{margin:0;font-size:13px;font-weight:700;color:#fff}
    #llHeader h2 span{color:#1DB954}
    #llClose{background:none;border:none;color:#666;cursor:pointer;font-size:16px;line-height:1;padding:0}
    #llClose:hover{color:#fff}
    #llStatus{display:flex;align-items:center;gap:8px;padding:7px 14px;
      background:#141414;border-bottom:1px solid #222;font-size:11px}
    #llDot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:#444;transition:background .3s}
    #llDot.idle{background:#444}
    #llDot.fetching{background:#3b82f6;animation:llPulse .7s infinite}
    @keyframes llPulse{0%,100%{opacity:1}50%{opacity:.35}}
    #llStats{display:flex;border-bottom:1px solid #222}
    .ll-stat{flex:1;display:flex;flex-direction:column;align-items:center;padding:8px 0;border-right:1px solid #222}
    .ll-stat:last-child{border-right:none}
    .ll-stat .ll-num{font-size:18px;font-weight:700;color:#fff;line-height:1}
    .ll-stat .ll-lbl{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
    #llConfigRow{display:flex;gap:6px;padding:7px 14px;border-bottom:1px solid #222;background:#131313}
    .ll-toggle{display:flex;align-items:center;gap:5px;font-size:11px;color:#888;cursor:pointer}
    .ll-toggle input{accent-color:#1DB954;cursor:pointer}
    #llLog{height:110px;overflow-y:auto;padding:4px 0;scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
    .ll-entry{padding:2px 14px;font-size:10.5px;border-left:2px solid transparent;line-height:1.5}
    .ll-entry.success{border-color:#1DB954;color:#888}
    .ll-entry.warn{border-color:#f59e0b;color:#f59e0b}
    .ll-entry.info{border-color:#333;color:#555}
    #llFooter{padding:8px 14px;border-top:1px solid #222;background:#161616;display:flex;gap:7px}
    .ll-btn{flex:1;padding:6px 0;border-radius:6px;border:none;font-size:10.5px;font-weight:600;cursor:pointer;transition:background .15s}
    .ll-btn-grey{background:#252525;color:#fff}
    .ll-btn-grey:hover{background:#303030}
  `;

  function buildUI() {
    if (document.getElementById('llPanel')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Bouton flottant (visible par défaut)
    const floatBtn = document.createElement('button');
    floatBtn.id = 'llFloatBtn';
    floatBtn.textContent = '🎵';
    floatBtn.title = 'LineLyrics (Ctrl+Shift+L)';
    document.body.appendChild(floatBtn);

    // Panel (caché par défaut)
    const panel = document.createElement('div');
    panel.id = 'llPanel';
    panel.className = 'll-hidden';
    panel.innerHTML = `
      <div id="llHeader">
        <h2>🎵 Line<span>Lyrics</span></h2>
        <button id="llClose">✕</button>
      </div>
      <div id="llStatus">
        <div id="llDot" class="idle"></div>
        <span id="llStatusText">En attente…</span>
      </div>
      <div id="llStats">
        <div class="ll-stat"><span class="ll-num" id="llCount">0</span><span class="ll-lbl">Sauvegardées</span></div>
        <div class="ll-stat"><span class="ll-num" id="llSyncType">—</span><span class="ll-lbl">Sync</span></div>
      </div>
      <div id="llConfigRow">
        <label class="ll-toggle"><input type="checkbox" id="llCbDedup" ${CONFIG.deduplicateByTrack ? 'checked' : ''}> Dédoublonnage</label>
      </div>
      <div id="llLog"></div>
      <div id="llFooter">
        <button class="ll-btn ll-btn-grey" id="llNowBtn">⬇ Piste actuelle</button>
        <button class="ll-btn ll-btn-grey" id="llClearBtn">🗑 Vider cache</button>
      </div>
    `;
    document.body.appendChild(panel);

    uiLogEl = document.getElementById('llLog');

    floatBtn.onclick = () => { panel.classList.toggle('ll-hidden'); };
    document.getElementById('llClose').onclick    = () => { panel.classList.add('ll-hidden'); };
    document.getElementById('llNowBtn').onclick   = () => {
      const ti = getCurrentTrackInfo();
      if (!ti) return;
      state.savedTrackIds.delete(ti.trackId);
      processTrack(ti, { force: true });
    };
    document.getElementById('llClearBtn').onclick = () => {
      state.savedTrackIds.clear();
      log.info('Cache vidé manuellement');
      uiAddLog('Cache vidé', 'info');
    };
    document.getElementById('llCbDedup').onchange = e => {
      CONFIG.deduplicateByTrack = e.target.checked;
      log.info(`Dédoublonnage: ${CONFIG.deduplicateByTrack}`);
    };

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        panel.classList.toggle('ll-hidden');
      }
    });

    try {
      if (Spicetify?.Topbar?.Button) {
        new Spicetify.Topbar.Button(
          'LineLyrics',
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`,
          () => panel.classList.toggle('ll-hidden')
        );
        log.info('Bouton Topbar enregistré');
      }
    } catch (e) { log.warn('Topbar indisponible:', e); }

    makeDraggable(panel, document.getElementById('llHeader'));
    log.info('UI montée — panel réduit par défaut (haut-droite)');
  }

  function makeDraggable(el, handle) {
    let ox, oy, sx, sy;
    handle.addEventListener('mousedown', e => {
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      const mv = e => {
        el.style.right = 'auto'; el.style.top = 'auto';
        el.style.left  = `${Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  ox + e.clientX - sx))}px`;
        el.style.top   = `${Math.max(0, Math.min(window.innerHeight - el.offsetHeight, oy + e.clientY - sy))}px`;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function uiSetStatus(s) {
    const dot = document.getElementById('llDot');
    const txt = document.getElementById('llStatusText');
    if (dot) dot.className = s;
    if (txt) txt.textContent = s === 'fetching' ? 'Téléchargement…' : 'En attente…';
  }

  function uiAddLog(msg, type = 'info') {
    if (!uiLogEl) return;
    const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const div = Object.assign(document.createElement('div'), {
      className  : `ll-entry ${type}`,
      textContent: `[${t}] ${msg}`,
    });
    uiLogEl.appendChild(div);
    uiLogEl.scrollTop = uiLogEl.scrollHeight;
  }

  function uiUpdateCount() {
    const el = document.getElementById('llCount');
    if (el) el.textContent = state.totalSaved;
  }

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  function activate() {
    buildUI();
    setupPlayerEvents();
    uiSetStatus('idle');
    uiAddLog('Prêt — .json + .lrc auto-save actif', 'success');
    Spicetify?.showNotification?.('[LineLyrics] Prêt ✓');
    window.LineLyrics = {
      config    : CONFIG,
      state,
      forceNow  : () => { const ti = getCurrentTrackInfo(); if (ti) { state.savedTrackIds.delete(ti.trackId); processTrack(ti, { force: true }); } },
      clearSaved: () => { state.savedTrackIds.clear(); log.info('Cache vidé via API'); uiAddLog('Cache vidé', 'info'); },
    };
    log.info('LineLyrics v2.0 actif | panel: haut-droite | formats: .json + .lrc');
  }

  let attempts = 0;
  const wait = setInterval(() => {
    if (Spicetify?.Player && Spicetify?.showNotification) {
      clearInterval(wait);
      activate();
    }
    if (++attempts > 30) {
      clearInterval(wait);
      buildUI();
      log.warn('Spicetify non détecté après 15s — mode dégradé');
      uiAddLog('⚠ Spicetify non détecté — mode dégradé', 'warn');
    }
  }, 500);

})();
