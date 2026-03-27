// spotify-line-lyrics.js — v1.0
// Paroles LINE-sync via endpoint natif Spotify | Sortie : .json | Auto à chaque piste

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
     LOG
  ═══════════════════════════════════════════════════════════ */
  const log = (...a) => CONFIG.debug &&
    console.log('%c[LineLyrics]', 'color:#1DB954;font-weight:bold', ...a);

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
    } catch { return null; }
  }

  async function getToken() {
    try {
      const res = await Spicetify?.CosmosAsync?.get('sp://oauth/v2/token');
      return res?.accessToken
        || Spicetify?.Platform?.AuthorizationAPI?.getState?.()?.token
        || null;
    } catch { return null; }
  }

  /* ═══════════════════════════════════════════════════════════
     FETCH — endpoint natif Spotify color-lyrics v2
  ═══════════════════════════════════════════════════════════ */
  async function fetchLyrics(trackId) {
    const token = await getToken();
    if (!token) { uiAddLog('⚠ Token indisponible', 'warn'); return null; }

    try {
      const res = await fetch(
        `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false`,
        { headers: { 'Authorization': `Bearer ${token}`, 'App-Platform': 'WebPlayer' } }
      );
      if (!res.ok) { uiAddLog(`⚠ HTTP ${res.status}`, 'warn'); return null; }
      return parseLyrics(await res.json());
    } catch (e) {
      log('fetchLyrics erreur:', e);
      uiAddLog('⚠ Erreur réseau', 'warn');
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PARSER
  ═══════════════════════════════════════════════════════════ */
  function parseLyrics(data) {
    const raw = data?.lyrics;
    if (!raw?.lines?.length) return null;

    const lines = raw.lines
      .map(l => ({
        text     : (l.words || '').trim(),
        startTime: toMs(l.startTimeMs ?? 0),
        endTime  : toMs(l.endTimeMs   ?? 0),
      }))
      .filter(l => l.text && l.text !== '♪');

    if (!lines.length) return null;

    return {
      syncType: raw.syncType || 'LINE_SYNCED',
      provider: 'spotify-color-lyrics',
      language: raw.language || null,
      lines,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     EXPORT JSON
  ═══════════════════════════════════════════════════════════ */
  function exportJSON(trackInfo, lyrics) {
    const output = {
      metadata: {
        track    : trackInfo.trackName,
        artist   : trackInfo.artistName,
        album    : trackInfo.albumName,
        trackId  : trackInfo.trackId,
        savedAt  : new Date().toISOString(),
        syncType : lyrics.syncType,
        provider : lyrics.provider,
        language : lyrics.language,
        lineCount: lyrics.lines.length,
      },
      lyrics: lyrics.lines,
    };

    const filename = `${sanitize(trackInfo.artistName)} - ${sanitize(trackInfo.trackName)}.json`;
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 300);
  }

  /* ═══════════════════════════════════════════════════════════
     PIPELINE
  ═══════════════════════════════════════════════════════════ */
  async function processTrack(ti, { force = false } = {}) {
    if (!force && CONFIG.deduplicateByTrack && state.savedTrackIds.has(ti.trackId)) return;

    uiSetStatus('fetching');
    const lyrics = await fetchLyrics(ti.trackId);

    if (!lyrics) {
      uiAddLog(`✗ Pas de paroles — ${ti.trackName}`, 'warn');
      uiSetStatus('idle');
      return;
    }

    exportJSON(ti, lyrics);
    state.savedTrackIds.add(ti.trackId);
    state.totalSaved++;

    const st = document.getElementById('llSyncType');
    if (st) st.textContent = lyrics.syncType === 'LINE_SYNCED' ? 'LINE' : 'NONE';

    uiAddLog(`✓ ${ti.artistName} — ${ti.trackName}`, 'success');
    uiSetStatus('idle');
    uiUpdateCount();
    Spicetify?.showNotification?.(`[LineLyrics] ✓ ${ti.trackName}`);
    log(`✓ ${ti.artistName} — ${ti.trackName} [${lyrics.syncType}]`);
  }

  /* ═══════════════════════════════════════════════════════════
     ÉVÉNEMENTS PLAYER
  ═══════════════════════════════════════════════════════════ */
  function setupPlayerEvents() {
    Spicetify.Player.addEventListener('songchange', () => {
      const ti = getCurrentTrackInfo();
      if (!ti) return;
      uiAddLog(`♪ ${ti.artistName} — ${ti.trackName}`, 'info');
      const st = document.getElementById('llSyncType');
      if (st) st.textContent = '…';
      processTrack(ti);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     INTERFACE
  ═══════════════════════════════════════════════════════════ */
  let uiPanel, uiLogEl;

  const CSS = `
    #llPanel{position:fixed;bottom:90px;right:20px;width:300px;
      background:#111;border:1px solid #2a2a2a;border-radius:14px;
      box-shadow:0 12px 48px rgba(0,0,0,.85);
      font-family:'Circular Sp','Helvetica Neue',sans-serif;font-size:13px;
      color:#aaa;z-index:99999;overflow:hidden;transition:opacity .2s,transform .2s}
    #llPanel.ll-hidden{opacity:0;pointer-events:none;transform:translateY(12px)}
    #llHeader{display:flex;align-items:center;justify-content:space-between;
      padding:12px 16px;background:#171717;border-bottom:1px solid #2a2a2a;cursor:move}
    #llHeader h2{margin:0;font-size:14px;font-weight:700;color:#fff}
    #llHeader h2 span{color:#1DB954}
    #llClose{background:none;border:none;color:#666;cursor:pointer;font-size:17px;line-height:1;padding:0}
    #llClose:hover{color:#fff}
    #llStatus{display:flex;align-items:center;gap:8px;padding:8px 16px;
      background:#141414;border-bottom:1px solid #222;font-size:11.5px}
    #llDot{width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:background .3s;background:#444}
    #llDot.idle{background:#444}
    #llDot.fetching{background:#3b82f6;animation:llPulse .7s infinite}
    @keyframes llPulse{0%,100%{opacity:1}50%{opacity:.35}}
    #llStats{display:flex;border-bottom:1px solid #222}
    .ll-stat{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 0;border-right:1px solid #222}
    .ll-stat:last-child{border-right:none}
    .ll-stat .ll-num{font-size:20px;font-weight:700;color:#fff;line-height:1}
    .ll-stat .ll-lbl{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
    #llConfigRow{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid #222;background:#131313}
    .ll-toggle{display:flex;align-items:center;gap:5px;font-size:11px;color:#888;cursor:pointer}
    .ll-toggle input{accent-color:#1DB954;cursor:pointer}
    #llLog{height:130px;overflow-y:auto;padding:4px 0;scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
    .ll-entry{padding:3px 16px;font-size:11px;border-left:2px solid transparent;line-height:1.55}
    .ll-entry.success{border-color:#1DB954;color:#888}
    .ll-entry.warn{border-color:#f59e0b;color:#f59e0b}
    .ll-entry.info{border-color:#333;color:#555}
    #llFooter{padding:8px 16px;border-top:1px solid #222;background:#161616;display:flex;gap:8px}
    .ll-btn{flex:1;padding:7px 0;border-radius:7px;border:none;font-size:11px;font-weight:600;cursor:pointer;transition:background .15s}
    .ll-btn-grey{background:#252525;color:#fff}
    .ll-btn-grey:hover{background:#303030}
    #llFloatBtn{position:fixed;bottom:90px;right:20px;width:44px;height:44px;
      border-radius:50%;background:#1DB954;border:none;cursor:pointer;
      display:none;align-items:center;justify-content:center;
      box-shadow:0 4px 18px rgba(29,185,84,.45);z-index:99998;font-size:19px;transition:transform .15s}
    #llFloatBtn:hover{transform:scale(1.1)}
    #llFloatBtn.visible{display:flex}
  `;

  function buildUI() {
    if (document.getElementById('llPanel')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    uiPanel = document.createElement('div');
    uiPanel.id = 'llPanel';
    uiPanel.innerHTML = `
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
    document.body.appendChild(uiPanel);

    const floatBtn = document.createElement('button');
    floatBtn.id = 'llFloatBtn';
    floatBtn.textContent = '🎵';
    floatBtn.title = 'LineLyrics (Ctrl+Shift+L)';
    document.body.appendChild(floatBtn);

    uiLogEl = document.getElementById('llLog');

    document.getElementById('llClose').onclick    = () => { uiPanel.classList.add('ll-hidden'); floatBtn.classList.add('visible'); };
    floatBtn.onclick                              = () => { uiPanel.classList.remove('ll-hidden'); floatBtn.classList.remove('visible'); };
    document.getElementById('llNowBtn').onclick   = () => {
      const ti = getCurrentTrackInfo();
      if (!ti) return;
      state.savedTrackIds.delete(ti.trackId);
      processTrack(ti, { force: true });
    };
    document.getElementById('llClearBtn').onclick = () => {
      state.savedTrackIds.clear();
      uiAddLog('Cache vidé', 'info');
    };
    document.getElementById('llCbDedup').onchange = e => { CONFIG.deduplicateByTrack = e.target.checked; };

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        const hidden = uiPanel.classList.toggle('ll-hidden');
        floatBtn.classList.toggle('visible', hidden);
      }
    });

    try {
      if (Spicetify?.Topbar?.Button) {
        new Spicetify.Topbar.Button(
          'LineLyrics',
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`,
          () => { const h = uiPanel.classList.toggle('ll-hidden'); floatBtn.classList.toggle('visible', h); }
        );
      } else {
        floatBtn.classList.add('visible');
      }
    } catch { floatBtn.classList.add('visible'); }

    makeDraggable(uiPanel, document.getElementById('llHeader'));
    log('✓ UI montée');
  }

  function makeDraggable(el, handle) {
    let ox, oy, sx, sy;
    handle.addEventListener('mousedown', e => {
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      const mv = e => {
        el.style.right = 'auto'; el.style.bottom = 'auto';
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
    uiAddLog('Prêt — auto-save activé', 'success');
    Spicetify?.showNotification?.('[LineLyrics] Prêt ✓');
    window.LineLyrics = {
      config    : CONFIG,
      state,
      forceNow  : () => { const ti = getCurrentTrackInfo(); if (ti) { state.savedTrackIds.delete(ti.trackId); processTrack(ti, { force: true }); } },
      clearSaved: () => { state.savedTrackIds.clear(); uiAddLog('Cache vidé', 'info'); },
    };
    log('✓ LineLyrics actif');
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
      uiAddLog('⚠ Spicetify non détecté — mode dégradé', 'warn');
    }
  }, 500);

})();