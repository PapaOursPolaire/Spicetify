// @name         LyricsBear Enhanced v166 - Paroles Synchronisées Améliorées
// @namespace    spicetify
// @description  Extension de paroles synchronisées avec recherche automatique et téléchargement par défaut
// @version      166
// @author       PapaOursPolaire - user on GitHub
// @match        https://open.spotify.com/*

(function() {
    'use strict';

    console.log('[LyricsBear] Démarrage version améliorée 166...');

    function waitForSpicetify() {
        if (!window.Spicetify?.Platform?.History || !window.Spicetify?.Player) {
            setTimeout(waitForSpicetify, 100);
            return;
        }
        console.log('Spicetify détecté, initialisation...');
        initializeLyricsBear();
    }

    function initializeLyricsBear() {
        const CONFIG = {
            API_ENDPOINTS: {
                LRCLIB: 'https://lrclib.net/api/get',
                BEAUTIFUL_LYRICS: 'https://beautiful-lyrics.socalifornian.live/lyrics/',
                SPOTIFY_BATCH: '/color-lyrics/v2/track/'
            },
            UPDATE_INTERVAL: 30,
            REQUEST_TIMEOUT: 10000,
            CACHE_DURATION: 3600000, 
            DOWNLOAD_PATH: 'C:/LyricsBear',
            FALLBACK_ENABLED: true,
            AUTO_DOWNLOAD_DEFAULT: true 
        };

        let state = {
            container: null,
            button: null,
            isVisible: false,
            currentTrack: null,
            lyrics: [],
            wordSyncData: null,
            updateInterval: null,
            lastActiveIndex: -1,
            lastActiveWordIndex: -1,
            manager: null,
            currentSource: 'network-batch',
            isLoading: false,
            interceptedData: new Map(),
            downloadEnabled: CONFIG.AUTO_DOWNLOAD_DEFAULT, 
            loadingQueue: new Set(),
            cachedTracks: new Map(),
            fallbackAttempts: new Map(),
            sourceStatuses: {
                'network-batch': 'idle',
                'beautiful-lyrics': 'idle',
                'lrclib': 'idle'
            }
        };

        const modernCSS = `
            .synclyrics-root {
                --sl-primary: #1ed760;
                --sl-primary-hover: #1db954;
                --sl-bg: rgba(0, 0, 0, 0.95);
                --sl-surface: rgba(15, 15, 15, 0.98);
                --sl-surface-hover: rgba(25, 25, 25, 0.95);
                --sl-text: #ffffff;
                --sl-text-muted: rgba(255, 255, 255, 0.7);
                --sl-text-dim: rgba(255, 255, 255, 0.45);
                --sl-border: rgba(255, 255, 255, 0.1);
                --sl-radius: 16px;
                --sl-gradient: linear-gradient(135deg, var(--sl-primary) 0%, #1db954 100%);
            }

            #synclyrics-panel {
                position: fixed !important;
                top: 70px !important;
                right: 20px !important;
                width: 480px !important;
                max-height: calc(100vh - 140px) !important;
                background: var(--sl-bg) !important;
                backdrop-filter: blur(25px) saturate(150%) !important;
                border: 1px solid var(--sl-border) !important;
                border-radius: var(--sl-radius) !important;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 8px 32px rgba(0, 0, 0, 0.2) !important;
                z-index: 9999 !important;
                transform: translateX(calc(100% + 40px)) !important;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
                font-family: 'Circular Std', 'SF Pro Display', -apple-system, sans-serif !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
            }

            #synclyrics-panel.visible {
                transform: translateX(0) !important;
            }

            .sl-header {
                padding: 24px;
                background: var(--sl-surface);
                border-bottom: 1px solid var(--sl-border);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }

            .sl-title {
                background: var(--sl-gradient);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                font-size: 20px;
                font-weight: 800;
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .sl-controls {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .sl-download-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                color: var(--sl-text-muted);
                font-weight: 500;
            }

            .sl-switch {
                position: relative;
                width: 44px;
                height: 24px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                cursor: pointer;
                transition: all 0.3s ease;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }

            .sl-switch.active {
                background: var(--sl-gradient);
                border-color: transparent;
            }

            .sl-switch::before {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 18px;
                height: 18px;
                background: white;
                border-radius: 50%;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            }

            .sl-switch.active::before {
                transform: translateX(20px);
            }

            .sl-btn {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.15);
                padding: 10px 14px;
                border-radius: 10px;
                color: var(--sl-text);
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                transition: all 0.2s ease;
                backdrop-filter: blur(10px);
            }

            .sl-btn:hover {
                background: rgba(255, 255, 255, 0.15);
                transform: translateY(-1px);
            }

            .sl-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            .sl-track-section {
                padding: 24px;
                background: var(--sl-surface);
                border-bottom: 1px solid var(--sl-border);
            }

            .sl-track-info {
                display: flex;
                gap: 18px;
                align-items: center;
            }

            .sl-cover {
                width: 72px;
                height: 72px;
                border-radius: 12px;
                background: var(--sl-surface-hover);
                flex-shrink: 0;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
                position: relative;
            }

            .sl-cover::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255, 255, 255, 0.1) 50%, transparent 70%);
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            .sl-cover:hover::after {
                opacity: 1;
            }

            .sl-cover img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .sl-track-details {
                flex: 1;
                min-width: 0;
            }

            .sl-track-title {
                color: var(--sl-text);
                font-size: 18px;
                font-weight: 700;
                margin-bottom: 6px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                line-height: 1.2;
            }

            .sl-track-artist {
                color: var(--sl-text-muted);
                font-size: 15px;
                font-weight: 500;
                margin-bottom: 16px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .sl-source-selector {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin-bottom: 12px;
            }

            .sl-source-btn {
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                background: rgba(255, 255, 255, 0.05);
                color: var(--sl-text-muted);
                letter-spacing: 0.8px;
                position: relative;
                overflow: hidden;
            }

            .sl-source-btn::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: var(--sl-gradient);
                transition: left 0.3s ease;
                z-index: -1;
            }

            .sl-source-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: var(--sl-text);
                transform: translateY(-2px);
            }

            .sl-source-btn.active {
                background: var(--sl-gradient);
                border-color: transparent;
                color: white;
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(30, 215, 96, 0.3);
            }

            .sl-source-btn.active::before {
                left: 0;
            }

            .sl-source-btn.loading {
                background: linear-gradient(45deg, #ff6b35, #ffa500);
                border-color: transparent;
                color: white;
                cursor: wait;
                animation: pulse 2s infinite;
            }

            .sl-source-btn.error {
                background: linear-gradient(45deg, #ff4444, #cc3333);
                border-color: transparent;
                color: white;
            }

            .sl-source-btn.success {
                background: var(--sl-gradient);
                border-color: transparent;
                color: white;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.7; }
            }

            .sl-status-info {
                font-size: 10px;
                color: var(--sl-text-dim);
                margin-top: 8px;
                padding: 8px 12px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                border-left: 3px solid var(--sl-primary);
            }

            .sl-content {
                flex: 1;
                overflow-y: auto;
                padding: 8px 0;
                background: var(--sl-bg);
            }

            .sl-content::-webkit-scrollbar {
                width: 8px;
            }

            .sl-content::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 4px;
            }

            .sl-content::-webkit-scrollbar-thumb {
                background: var(--sl-gradient);
                border-radius: 4px;
                transition: all 0.3s ease;
            }

            .sl-content::-webkit-scrollbar-thumb:hover {
                background: var(--sl-primary-hover);
            }

            .sl-lyrics-container {
                padding: 20px 24px;
                max-width: 100%;
            }

            .sl-lyrics-line {
                padding: 16px 0;
                color: var(--sl-text-dim);
                font-size: 18px;
                line-height: 1.8;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                cursor: pointer;
                position: relative;
                border-radius: 12px;
                margin: 4px 0;
                font-weight: 400;
                letter-spacing: 0.2px;
            }

            .sl-lyrics-line:hover {
                background: rgba(255, 255, 255, 0.03);
                color: var(--sl-text-muted);
                transform: translateX(8px);
            }

            .sl-lyrics-line.active {
                color: var(--sl-text);
                background: linear-gradient(90deg, rgba(30, 215, 96, 0.15) 0%, rgba(30, 215, 96, 0.05) 50%, transparent 100%);
                font-weight: 600;
                transform: translateX(12px) scale(1.02);
                border-left: 4px solid var(--sl-primary);
                padding-left: 20px;
                box-shadow: 0 4px 20px rgba(30, 215, 96, 0.1);
            }

            .sl-lyrics-line.active::before {
                content: '';
                position: absolute;
                left: -4px;
                top: 0;
                bottom: 0;
                width: 4px;
                background: var(--sl-gradient);
                border-radius: 2px;
                box-shadow: 0 0 12px var(--sl-primary);
            }

            .sl-word {
                display: inline;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                padding: 2px 4px;
                border-radius: 6px;
                margin: 0 2px;
                position: relative;
                font-weight: inherit;
            }

            .sl-word.active {
                color: var(--sl-primary);
                background: rgba(30, 215, 96, 0.2);
                font-weight: 800;
                transform: scale(1.1);
                text-shadow: 0 0 8px rgba(30, 215, 96, 0.5);
            }

            .sl-word.sung {
                color: var(--sl-text);
                opacity: 0.9;
                font-weight: 600;
            }

            .sl-no-lyrics, .sl-loading, .sl-error-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 240px;
                color: var(--sl-text-dim);
                text-align: center;
                padding: 32px;
            }

            .sl-loading-icon {
                width: 32px;
                height: 32px;
                margin-bottom: 20px;
                position: relative;
            }

            .sl-spinner {
                width: 32px;
                height: 32px;
                border: 3px solid rgba(255, 255, 255, 0.1);
                border-top: 3px solid var(--sl-primary);
                border-radius: 50%;
                animation: spin 1.2s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .sl-retry-actions {
                display: flex;
                gap: 12px;
                margin-top: 20px;
                flex-wrap: wrap;
                justify-content: center;
            }

            .synclyrics-topbar-button {
                background: none !important;
                border: none !important;
                color: var(--text-subdued, #a7a7a7) !important;
                cursor: pointer !important;
                padding: 10px !important;
                margin: 0 4px !important;
                border-radius: 8px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
                min-width: 36px !important;
                height: 36px !important;
                position: relative !important;
                overflow: hidden !important;
            }

            .synclyrics-topbar-button::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: var(--sl-gradient);
                opacity: 0;
                transition: opacity 0.3s ease;
                border-radius: 8px;
            }

            .synclyrics-topbar-button:hover::before {
                opacity: 0.1;
            }

            .synclyrics-topbar-button:hover {
                color: white !important;
                transform: translateY(-2px) !important;
            }

            .synclyrics-topbar-button.active {
                color: var(--sl-primary) !important;
                background-color: rgba(30, 215, 96, 0.15) !important;
            }

            @media (max-width: 768px) {
                #synclyrics-panel {
                    right: 10px;
                    left: 10px;
                    width: auto;
                    max-width: calc(100vw - 20px);
                }
                
                .sl-lyrics-line {
                    font-size: 16px;
                }
            }

            .sl-download-status {
                font-size: 10px;
                color: var(--sl-primary);
                margin-top: 4px;
                opacity: 0.8;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
        `;

        class LyricsBearManager {
            constructor() {
                console.log('[LyricsBear] Initialisation du manager amélioré v166...');
                this.initializeStyles();
                this.setupNetworkInterception();
                this.createInterface();
                this.setupEventListeners();
                this.createTopbarButton();
                this.loadSettings();
                this.initialize();
            }

            initializeStyles() {
                if (document.getElementById('synclyrics-styles')) return;
                const styleEl = document.createElement('style');
                styleEl.id = 'synclyrics-styles';
                styleEl.textContent = modernCSS;
                document.head.appendChild(styleEl);
                console.log('[LyricsBear] Styles améliorés injectés');
            }

            loadSettings() {
                try {
                    const saved = localStorage.getItem('synclyrics-settings');
                    if (saved) {
                        const settings = JSON.parse(saved);
                        state.downloadEnabled = settings.downloadEnabled !== undefined ? settings.downloadEnabled : CONFIG.AUTO_DOWNLOAD_DEFAULT;
                    } else {
                        // Première utilisation : définir par défaut sur activé
                        state.downloadEnabled = CONFIG.AUTO_DOWNLOAD_DEFAULT;
                        this.saveSettings();
                    }
                    console.log('[LyricsBear] Paramètres chargés - Téléchargement:', state.downloadEnabled);
                } catch (error) {
                    console.warn('[LyricsBear] Erreur chargement paramètres:', error);
                    state.downloadEnabled = CONFIG.AUTO_DOWNLOAD_DEFAULT;
                }
            }

            saveSettings() {
                try {
                    const settings = {
                        downloadEnabled: state.downloadEnabled
                    };
                    localStorage.setItem('synclyrics-settings', JSON.stringify(settings));
                    console.log('[LyricsBear] Paramètres sauvegardés');
                } catch (error) {
                    console.warn('[LyricsBear] Erreur sauvegarde paramètres:', error);
                }
            }

            setupNetworkInterception() {
                console.log('[LyricsBear] Configuration interception réseau optimisée...');
                
                // NOUVEAU : Bloquer les vérifications de version Beautiful Lyrics
                const originalFetch = window.fetch;
                window.fetch = async function(...args) {
                    const [url] = args;
                    
                    // Bloquer les requêtes de version Beautiful Lyrics
                    if (typeof url === 'string' && url.includes('extensions.socalifornian.live/version')) {
                        console.log('[LyricsBear] ⛔ Requête de version Beautiful Lyrics bloquée');
                        // Retourner une fausse réponse pour éviter les erreurs
                        return new Response(JSON.stringify({ version: '1.0.0' }), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    try {
                        const response = await originalFetch.apply(this, args);
                        
                        if (state.manager && state.manager.isLyricsRequest(url)) {
                            console.log('[LyricsBear] Requête fetch lyrics détectée:', url);
                            const clonedResponse = response.clone();
                            const responseText = await clonedResponse.text();
                            state.manager.handleLyricsResponse(responseText, url);
                        }
                        
                        return response;
                    } catch (error) {
                        console.error('[LyricsBear] Erreur fetch:', error);
                        throw error;
                    }
                };
                
                // XHR interception reste identique
                const originalXHR = window.XMLHttpRequest.prototype.open;
                window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
                    // Bloquer aussi les XHR de version
                    if (typeof url === 'string' && url.includes('extensions.socalifornian.live/version')) {
                        console.log('[LyricsBear] ⛔ Requête XHR de version Beautiful Lyrics bloquée');
                        this._blocked = true;
                    }
                    
                    this._url = url;
                    this._method = method;
                    return originalXHR.apply(this, [method, url, ...args]);
                };

                const originalSend = window.XMLHttpRequest.prototype.send;
                window.XMLHttpRequest.prototype.send = function(data) {
                    if (this._blocked) {
                        // Simuler une réponse réussie
                        setTimeout(() => {
                            Object.defineProperty(this, 'status', { value: 200 });
                            Object.defineProperty(this, 'responseText', { value: '{"version":"1.0.0"}' });
                            if (this.onload) this.onload();
                        }, 0);
                        return;
                    }
                    
                    if (state.manager && state.manager.isLyricsRequest(this._url)) {
                        console.log('[LyricsBear] Requête XHR lyrics détectée:', this._url);
                        
                        const originalOnLoad = this.onload;
                        this.onload = function(e) {
                            try {
                                if (this.status === 200 && this.responseText) {
                                    state.manager.handleLyricsResponse(this.responseText, this._url);
                                }
                            } catch (error) {
                                console.error('[LyricsBear] Erreur traitement XHR:', error);
                            }
                            if (originalOnLoad) originalOnLoad.call(this, e);
                        };
                    }
                    
                    return originalSend.apply(this, arguments);
                };
            }

            convertSpicyLyrics(data) {
                console.log('[LyricsBear] 🌶️ Conversion Spicy Lyrics');
                
                const lines = [];
                
                if (data.queries && data.queries[0] && data.queries[0].result && data.queries[0].result.data) {
                    const lyricsData = data.queries[0].result.data;
                    
                    if (lyricsData.Content && Array.isArray(lyricsData.Content)) {
                        lyricsData.Content.forEach((item) => {
                            if (item.Type === 'Vocal' && item.Lead && item.Lead.Syllables) {
                                const words = item.Lead.Syllables.map(syl => ({
                                    text: syl.Text,
                                    startTime: syl.StartTime * 1000,
                                    endTime: syl.EndTime * 1000
                                }));
                                
                                const text = words.map(w => w.text).join(' ');
                                
                                lines.push({
                                    startTime: item.Lead.StartTime * 1000,
                                    endTime: item.Lead.EndTime * 1000,
                                    text: text,
                                    words: words
                                });
                            }
                        });
                    }
                }
                
                return {
                    lines: lines,
                    wordSync: lines,
                    source: 'spicy-lyrics',
                    hasWordSync: true
                };
            }

            isLyricsRequest(url) {
                if (!url || typeof url !== 'string') return false;
                
                // Exclure les vérifications de version
                if (url.includes('/version')) {
                    return false;
                }
                
                const lyricsPatterns = [
                    // 🌶️ SPICY LYRICS - LE TRÉSOR !!!
                    'api.spicylyrics.org',
                    'spicylyrics.org/query',
                    
                    // Reste...
                    'beautiful-lyrics.socalifornian.live/lyrics/',
                    '/color-lyrics/v2/track/',
                    'spclient.wg.spotify.com/color-lyrics',
                    'spicy-lyrics',
                    'lyrics-plus',
                    '/batch',
                    'lyrics.spotify.com'
                ];
                
                return lyricsPatterns.some(pattern => url.includes(pattern));
            }

            
            async handleLyricsResponse(responseText, url) {
                try {
                    let data;
                    
                    try {
                        data = JSON.parse(responseText);
                    } catch (e) {
                        console.warn('[LyricsBear] Réponse non-JSON:', url);
                        return;
                    }

                    const processedData = this.processLyricsData(data, url);
                    
                    if (processedData && processedData.lines && processedData.lines.length > 0) {
                        const trackId = this.extractTrackId(url, data);
                        
                        // NOUVEAU : Détecter la source
                        let detectedSource = 'network-batch';
                        if (url.includes('beautiful-lyrics')) {
                            detectedSource = 'beautiful-lyrics';
                            console.log('[LyricsBear] 🎵 Beautiful Lyrics intercepté !');
                        } else if (url.includes('lrclib')) {
                            detectedSource = 'lrclib';
                        }
                        
                        if (trackId) {
                            const cacheData = {
                                data: processedData,
                                timestamp: Date.now(),
                                sourceUrl: url,
                                originalData: data,
                                detectedSource: detectedSource
                            };
                            
                            state.interceptedData.set(trackId, cacheData);
                            
                            if (state.downloadEnabled && state.currentTrack) {
                                await this.downloadOriginalLyrics(state.currentTrack, data, detectedSource);
                            }
                            
                            if (this.isCurrentTrackId(trackId)) {
                                state.lyrics = processedData.lines;
                                state.wordSyncData = processedData.wordSync;
                                state.currentSource = detectedSource;
                                
                                if (state.isVisible) {
                                    this.displayLyrics(state.lyrics);
                                }
                                
                                this.updateSourceStatus(detectedSource, 'success');
                                this.updateStatusInfo(`Paroles ${detectedSource} synchronisées ${processedData.hasWordSync ? 'mot par mot' : 'ligne par ligne'}`);
                            }
                        }
                    }
                } catch (error) {
                    console.error('[LyricsBear] Erreur traitement réponse:', error);
                }
            }

            async downloadOriginalLyrics(track, originalData, source) {
                if (!state.downloadEnabled || !track || !originalData) return;

                try {
                    const artist = track.artists?.[0]?.name || 'Unknown Artist';
                    const title = track.name || 'Unknown Title';
                    const filename = `${this.sanitizeFilename(artist)} - ${this.sanitizeFilename(title)}`;
                    
                    const existingFile = await this.checkExistingFile(filename);
                    if (existingFile) {
                        console.log('[LyricsBear] Fichier déjà téléchargé:', filename);
                        return;
                    }

                    const downloadData = {
                        title: title,
                        artist: artist,
                        source: source,
                        hasWordSync: true,
                        timestamp: new Date().toISOString(),
                        originalData: originalData,
                        downloadedBy: 'LyricsBear v166'
                    };

                    const content = JSON.stringify(downloadData, null, 2);
                    const extension = 'json';

                    this.simulateDownload(filename, content, extension);
                    this.markAsDownloaded(filename, true);
                    
                    console.log('[LyricsBear] Données originales téléchargées:', `${filename}.${extension}`);
                    this.showDownloadStatus(`Téléchargé: ${filename}.${extension}`);
                    
                } catch (error) {
                    console.error('[LyricsBear] Erreur téléchargement:', error);
                }
            }

            extractTrackId(url, data) {
                let trackId = null;
                
                let match = url.match(/\/lyrics\/([^\/\?&]+)/);
                if (match) return match[1];
                
                match = url.match(/track\/([^\/\?&]+)/);
                if (match) return match[1];
                
                if (data) {
                    if (data.jobs && Array.isArray(data.jobs)) {
                        for (const job of data.jobs) {
                            if (job.result && job.result.responseData && job.result.responseData.id) {
                                return job.result.responseData.id;
                            }
                        }
                    }
                    
                    if (data.id) return data.id;
                    if (data.trackId) return data.trackId;
                }
                
                return null;
            }

            isCurrentTrackId(trackId) {
                if (!state.currentTrack || !trackId) return false;
                
                const currentId = state.currentTrack.id;
                if (!currentId) return false;
                
                const cleanTrackId = trackId.replace(/^spotify:track:/, '');
                const cleanCurrentId = currentId.replace(/^spotify:track:/, '');
                
                return cleanCurrentId === cleanTrackId || 
                       cleanCurrentId.includes(cleanTrackId) ||
                       cleanTrackId.includes(cleanCurrentId);
            }

            processLyricsData(data, sourceUrl) {
                console.log('[LyricsBear] processLyricsData, sourceUrl:', sourceUrl);
                
                if (sourceUrl && sourceUrl.includes('spicylyrics.org')) {
                    console.log('[LyricsBear] 🌶️ SPICY LYRICS DÉTECTÉ !');
                    return this.convertSpicyLyrics(data);
                }
                
                // Batch Spotify
                if (data.jobs && Array.isArray(data.jobs)) {
                    for (const job of data.jobs) {
                        if (job.handler === 'LYRICS_ID' && job.result && job.result.responseData) {
                            return this.convertBatchToLyrics(job.result.responseData);
                        }
                    }
                }
                
                if (data.Content && Array.isArray(data.Content)) {
                    return this.convertBatchToLyrics(data);
                }
                
                // Beautiful Lyrics
                if (data.lyrics || data.lines) {
                    return this.convertBeautifulLyrics(data);
                }
                
                return null;
            }

            convertBatchToLyrics(lyricsData) {
                try {
                    if (!lyricsData.Content || !Array.isArray(lyricsData.Content)) {
                        return null;
                    }

                    const lines = [];

                    for (const contentItem of lyricsData.Content) {
                        if (contentItem.Type !== 'Vocal' || !contentItem.Lead || !contentItem.Lead.Syllables) {
                            continue;
                        }

                        const syllables = contentItem.Lead.Syllables;
                        const startTime = contentItem.Lead.StartTime * 1000;
                        const endTime = contentItem.Lead.EndTime * 1000;

                        const lineText = syllables.map(syl => syl.Text).join('');
                        
                        const words = syllables.map(syllable => ({
                            text: syllable.Text,
                            startTime: syllable.StartTime * 1000,
                            endTime: syllable.EndTime * 1000
                        }));

                        const lineData = {
                            startTime: startTime,
                            endTime: endTime,
                            text: lineText.trim(),
                            words: words
                        };

                        lines.push(lineData);
                    }

                    return {
                        lines: lines,
                        wordSync: lines,
                        source: 'network-batch',
                        hasWordSync: true
                    };
                } catch (error) {
                    console.error('[LyricsBear] Erreur conversion batch:', error);
                    return null;
                }
            }

            convertBeautifulLyrics(data) {
                const lines = [];
                
                if (data.lyrics && Array.isArray(data.lyrics)) {
                    data.lyrics.forEach((line, index) => {
                        if (line.words && Array.isArray(line.words)) {
                            const words = line.words.map(word => ({
                                text: word.string || word.text,
                                startTime: (word.time || 0) * 1000
                            }));
                            
                            lines.push({
                                startTime: (line.time || index * 3000),
                                text: words.map(w => w.text).join(' '),
                                words: words
                            });
                        } else {
                            lines.push({
                                startTime: line.time || index * 3000,
                                text: line.string || line.text || '',
                                words: []
                            });
                        }
                    });
                }
                
                return {
                    lines: lines,
                    wordSync: lines.some(l => l.words.length > 0) ? lines : null,
                    source: 'beautiful-lyrics',
                    hasWordSync: lines.some(l => l.words.length > 0)
                };
            }

            async performAutomaticSearch(track) {
                console.log('[LyricsBear] Recherche automatique démarrée pour:', track.name);
                
                const sources = ['network-batch', 'lrclib', 'beautiful-lyrics'];
                let lastError = null;
                
                for (const source of sources) {
                    try {
                        console.log('[LyricsBear] Tentative source:', source);
                        this.updateSourceStatus(source, 'loading');
                        
                        // TIMEOUT ADAPTÉ à chaque source
                        const timeout = source === 'network-batch' ? 8000 : CONFIG.REQUEST_TIMEOUT;
                        
                        const lyricsData = await Promise.race([
                            this.fetchLyricsFromSource(track, source),
                            new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('Timeout')), timeout)
                            )
                        ]);
                        
                        if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
                            console.log('[LyricsBear] ✅ Paroles trouvées via:', source);
                            this.updateSourceStatus(source, 'success');
                            this.updateStatusInfo(`Paroles trouvées via ${source} - ${lyricsData.hasWordSync ? 'Sync mot par mot' : 'Sync ligne par ligne'}`);
                            
                            if (state.downloadEnabled) {
                                await this.downloadLyrics(track, lyricsData, source);
                            }
                            
                            return lyricsData;
                        }
                        
                    } catch (error) {
                        console.warn('[LyricsBear] Erreur source', source, ':', error.message);
                        this.updateSourceStatus(source, 'error');
                        lastError = error;
                        // CONTINUER vers la source suivante au lieu d'abandonner
                    }
                }
                
                this.updateStatusInfo('Aucune parole trouvée sur toutes les sources');
                throw lastError || new Error('Toutes les sources ont échoué');
            }

            async downloadLyrics(track, lyricsData, source) {
                if (!state.downloadEnabled || !track || !lyricsData) return;

                try {
                    const artist = track.artists?.[0]?.name || 'Unknown Artist';
                    const title = track.name || 'Unknown Title';
                    const filename = `${this.sanitizeFilename(artist)} - ${this.sanitizeFilename(title)}`;
                    
                    const existingFile = await this.checkExistingFile(filename);
                    if (existingFile && (!lyricsData.hasWordSync || existingFile.hasWordSync)) {
                        console.log('[LyricsBear] Fichier déjà téléchargé:', filename);
                        return;
                    }

                    let content, extension;
                    
                    if (source === 'lrclib' && lyricsData.source === 'lrclib') {
                        content = this.convertToLRC(lyricsData);
                        extension = 'lrc';
                    } else {
                        content = JSON.stringify({
                            title: title,
                            artist: artist,
                            source: source,
                            hasWordSync: lyricsData.hasWordSync || false,
                            timestamp: new Date().toISOString(),
                            lines: lyricsData.lines,
                            wordSync: lyricsData.wordSync,
                            downloadedBy: 'LyricsBear v166'
                        }, null, 2);
                        extension = 'json';
                    }

                    this.simulateDownload(filename, content, extension);
                    this.markAsDownloaded(filename, lyricsData.hasWordSync || false);
                    
                    console.log('[LyricsBear] Paroles téléchargées:', `${filename}.${extension}`);
                    this.showDownloadStatus(`Téléchargé: ${filename}.${extension}`);
                    
                } catch (error) {
                    console.error('[LyricsBear] Erreur téléchargement:', error);
                }
            }

            sanitizeFilename(filename) {
                return filename.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
            }

            async checkExistingFile(filename) {
                try {
                    const downloaded = JSON.parse(localStorage.getItem('synclyrics-downloaded') || '{}');
                    return downloaded[filename] || null;
                } catch {
                    return null;
                }
            }

            markAsDownloaded(filename, hasWordSync) {
                try {
                    const downloaded = JSON.parse(localStorage.getItem('synclyrics-downloaded') || '{}');
                    downloaded[filename] = {
                        timestamp: Date.now(),
                        hasWordSync: hasWordSync
                    };
                    localStorage.setItem('synclyrics-downloaded', JSON.stringify(downloaded));
                } catch (error) {
                    console.warn('[LyricsBear] Erreur marquage téléchargé:', error);
                }
            }

            convertToLRC(lyricsData) {
                if (!lyricsData.lines) return '';
                
                let lrc = '[ti:' + (state.currentTrack?.name || '') + ']\n';
                lrc += '[ar:' + (state.currentTrack?.artists?.[0]?.name || '') + ']\n';
                lrc += '[by:LyricsBear v166]\n\n';
                
                for (const line of lyricsData.lines) {
                    const time = this.millisecondsToLRC(line.startTime);
                    lrc += `[${time}]${line.text}\n`;
                }
                
                return lrc;
            }

            millisecondsToLRC(ms) {
                const minutes = Math.floor(ms / 60000);
                const seconds = Math.floor((ms % 60000) / 1000);
                const centiseconds = Math.floor((ms % 1000) / 10);
                return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
            }

            simulateDownload(filename, content, extension) {
                const blob = new Blob([content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = `${filename}.${extension}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            showDownloadStatus(message) {
                const statusEl = document.querySelector('.sl-download-status');
                if (statusEl) {
                    statusEl.textContent = message;
                    statusEl.style.opacity = '1';
                    setTimeout(() => {
                        statusEl.style.opacity = '0.8';
                    }, 3000);
                }
            }

            updateStatusInfo(message) {
                const statusEl = document.querySelector('.sl-status-info');
                if (statusEl) {
                    statusEl.textContent = message;
                } else if (state.isVisible) {
                    // Créer l'élément s'il n'existe pas
                    const trackDetails = document.querySelector('.sl-track-details');
                    if (trackDetails) {
                        const statusDiv = document.createElement('div');
                        statusDiv.className = 'sl-status-info';
                        statusDiv.textContent = message;
                        trackDetails.appendChild(statusDiv);
                    }
                }
            }

            createInterface() {
                if (state.container) return;

                state.container = document.createElement('div');
                state.container.id = 'synclyrics-panel';
                state.container.className = 'synclyrics-root';
                
                state.container.innerHTML = `
                    <div class="sl-header">
                        <div class="sl-title">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                            </svg>
                            LyricsBear v166
                        </div>
                        <div class="sl-controls">
                            <div class="sl-download-toggle">
                                <span>Téléchargement</span>
                                <div class="sl-switch ${state.downloadEnabled ? 'active' : ''}" id="sl-download-switch" title="Télécharger automatiquement les paroles">
                                </div>
                            </div>
                            <button class="sl-btn" id="sl-refresh" title="Actualiser">⟳</button>
                            <button class="sl-btn" id="sl-close" title="Fermer">✕</button>
                        </div>
                    </div>
                    <div class="sl-track-section" id="sl-track-section" style="display: none;">
                        <div class="sl-track-info">
                            <div class="sl-cover" id="sl-cover">
                                <div style="color: rgba(255,255,255,0.3); font-size: 28px;">♫</div>
                            </div>
                            <div class="sl-track-details">
                                <div class="sl-track-title" id="sl-track-title">Titre inconnu</div>
                                <div class="sl-track-artist" id="sl-track-artist">Artiste inconnu</div>
                                <div class="sl-source-selector">
                                    <button class="sl-source-btn" data-source="network-batch">RÉSEAU</button>
                                    <button class="sl-source-btn" data-source="lrclib">LRCLIB</button>
                                    <button class="sl-source-btn" data-source="beautiful-lyrics">BEAUTIFUL</button>
                                </div>
                                <div class="sl-status-info">Recherche automatique activée</div>
                                <div class="sl-download-status" style="opacity: 0.8;"></div>
                            </div>
                        </div>
                    </div>
                    <div class="sl-content" id="sl-content">
                        <div class="sl-no-lyrics">
                            <div class="sl-loading-icon">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity: 0.3;">
                                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                                </svg>
                            </div>
                            <p>En attente d'une chanson...</p>
                            <small style="opacity: 0.6;">Recherche automatique sur toutes les sources</small>
                        </div>
                    </div>
                `;

                document.body.appendChild(state.container);
                console.log('[LyricsBear] Interface améliorée créée v166');
            }

            createTopbarButton() {
                console.log('[LyricsBear] Création bouton topbar amélioré...');
                
                const buttonElement = document.createElement('button');
                buttonElement.className = 'synclyrics-topbar-button';
                buttonElement.setAttribute('title', 'LyricsBear Enhanced v166 (Ctrl+Shift+L)');
                buttonElement.setAttribute('aria-label', 'LyricsBear Enhanced v166');
                
                buttonElement.innerHTML = `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                    </svg>
                `;
                
                buttonElement.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('[LyricsBear] Clic bouton topbar');
                    try {
                        this.toggle();
                    } catch (error) {
                        console.error('[LyricsBear] Erreur toggle depuis bouton:', error);
                    }
                });

                const insertButton = () => {
                    const selectors = [
                        '.main-topBar-topbarContentRight',
                        '[data-testid="topbar-content-wrapper"] .main-topBar-topbarContentRight',
                        '.Root__top-container header [class*="topbarContentRight"]',
                        '.main-topBar-container .main-topBar-topbarContentRight'
                    ];

                    for (const selector of selectors) {
                        const container = document.querySelector(selector);
                        if (container && !container.querySelector('.synclyrics-topbar-button')) {
                            container.appendChild(buttonElement);
                            state.button = buttonElement;
                            console.log('[LyricsBear] Bouton inséré dans:', selector);
                            return true;
                        }
                    }
                    return false;
                };

                let attempts = 0;
                const maxAttempts = 50;
                
                const tryInsert = () => {
                    attempts++;
                    if (insertButton()) {
                        console.log('[LyricsBear] Bouton topbar créé avec succès');
                        return;
                    }
                    
                    if (attempts < maxAttempts) {
                        setTimeout(tryInsert, 200);
                    } else {
                        console.warn('[LyricsBear] Impossible de créer le bouton topbar après', maxAttempts, 'tentatives');
                    }
                };

                tryInsert();
            }

            setupEventListeners() {
                console.log('[LyricsBear] Configuration événements améliorés...');
                
                const setupButton = (id, handler) => {
                    const button = document.getElementById(id);
                    if (button) {
                        button.addEventListener('click', handler);
                    }
                };

                setupButton('sl-close', () => this.hide());
                setupButton('sl-refresh', () => this.refreshLyrics());
                
                // Switch de téléchargement
                const downloadSwitch = document.getElementById('sl-download-switch');
                if (downloadSwitch) {
                    downloadSwitch.addEventListener('click', () => {
                        state.downloadEnabled = !state.downloadEnabled;
                        downloadSwitch.classList.toggle('active', state.downloadEnabled);
                        this.saveSettings();
                        console.log('[LyricsBear] Téléchargement automatique:', state.downloadEnabled);
                        this.updateStatusInfo(`Téléchargement automatique ${state.downloadEnabled ? 'activé' : 'désactivé'}`);
                    });
                }
                
                // Sélecteur de source - NOUVEAU : permet de réessayer
                document.addEventListener('click', (e) => {
                    if (e.target.classList.contains('sl-source-btn')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const sourceId = e.target.dataset.source;
                        console.log('[LyricsBear] Source sélectionnée manuellement:', sourceId);
                        this.selectSource(sourceId);
                    }
                });

                // Raccourcis clavier
                document.addEventListener('keydown', (e) => {
                    const activeElement = document.activeElement;
                    const isInputField = activeElement && (
                        activeElement.tagName === 'INPUT' ||
                        activeElement.tagName === 'TEXTAREA' ||
                        activeElement.contentEditable === 'true'
                    );
                    
                    if (e.ctrlKey && e.shiftKey && e.key === 'L' && !isInputField) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[LyricsBear] Raccourci détecté');
                        try {
                            this.toggle();
                        } catch (error) {
                            console.error('[LyricsBear] Erreur toggle depuis raccourci:', error);
                        }
                    }
                    
                    if (e.key === 'Escape' && state.isVisible && !isInputField) {
                        e.preventDefault();
                        this.hide();
                    }
                });

                this.setupTrackChangeDetection();
            }

            setupTrackChangeDetection() {
                console.log('[LyricsBear] Configuration détection changement piste optimisée...');
                
                if (window.Spicetify?.Player?.addEventListener) {
                    try {
                        Spicetify.Player.addEventListener('songchange', (e) => {
                            console.log('[LyricsBear] Changement de piste Spicetify:', e?.data?.name);
                            if (e && e.data) {
                                state.loadingQueue.clear();
                                this.handleTrackChange(e.data);
                            }
                        });
                        console.log('[LyricsBear] Événement Spicetify songchange configuré');
                    } catch (error) {
                        console.error('[LyricsBear] Erreur événement songchange:', error);
                    }
                }

                const observer = new MutationObserver(() => {
                    try {
                        const currentTrack = this.getCurrentTrack();
                        if (currentTrack && currentTrack.id !== state.currentTrack?.id) {
                            console.log('[LyricsBear] Observer DOM - nouvelle piste:', currentTrack.name);
                            state.loadingQueue.clear();
                            this.handleTrackChange(currentTrack);
                        }
                    } catch (error) {
                        console.error('[LyricsBear] Erreur observer DOM:', error);
                    }
                });

                const observeElements = () => {
                    const titleSelectors = [
                        '[data-testid="context-item-info-title"]',
                        '.main-nowPlayingBar-left',
                        '.main-trackInfo-name',
                        '.main-nowPlayingWidget-trackInfo'
                    ];

                    titleSelectors.forEach(selector => {
                        const elements = document.querySelectorAll(selector);
                        elements.forEach(element => {
                            observer.observe(element, { 
                                childList: true, 
                                subtree: true, 
                                characterData: true
                            });
                        });
                    });
                };

                observeElements();
                setInterval(observeElements, 10000);

                setInterval(() => {
                    try {
                        const currentTrack = this.getCurrentTrack();
                        if (currentTrack?.id && currentTrack.id !== state.currentTrack?.id && !state.isLoading) {
                            console.log('[LyricsBear] Polling - nouvelle piste:', currentTrack.name);
                            state.loadingQueue.clear();
                            this.handleTrackChange(currentTrack);
                        }
                    } catch (error) {
                        console.error('[LyricsBear] Erreur polling:', error);
                    }
                }, 2000);
            }

            getCurrentTrack() {
                try {
                    let track = null;
                    
                    if (window.Spicetify?.Player?.data) {
                        track = Spicetify.Player.data.item || Spicetify.Player.data.track;
                    }
                    
                    if (!track || !track.name) {
                        const titleElement = document.querySelector('[data-testid="context-item-info-title"]') ||
                                            document.querySelector('.main-trackInfo-name a') ||
                                            document.querySelector('.main-nowPlayingWidget-trackInfo h4');
                        
                        const artistElement = document.querySelector('[data-testid="context-item-info-subtitles"] a') ||
                                            document.querySelector('.main-trackInfo-artists a') ||
                                            document.querySelector('.main-nowPlayingWidget-trackInfo .main-trackInfo-artists');
                        
                        const imageElement = document.querySelector('[data-testid="context-item-image"] img') ||
                                            document.querySelector('.main-nowPlayingWidget-coverArt img');
                        
                        if (titleElement && titleElement.textContent.trim()) {
                            const title = titleElement.textContent.trim();
                            const artist = artistElement ? artistElement.textContent.trim() : 'Unknown Artist';
                            
                            track = {
                                name: title,
                                artists: [{ name: artist }],
                                id: this.generateTrackId(title, artist),
                                images: imageElement?.src ? [{ url: imageElement.src }] : [],
                                uri: `spotify:track:${this.generateTrackId(title, artist)}`
                            };
                        }
                    }

                    return track && track.name && track.name !== 'Unknown' ? track : null;
                } catch (error) {
                    console.error('[LyricsBear] Erreur getCurrentTrack:', error);
                    return null;
                }
            }

            generateTrackId(title, artist) {
                return btoa(encodeURIComponent(`${title}-${artist}`)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 22);
            }

            getCurrentTime() {
                try {
                    return Spicetify?.Player?.getProgress?.() || 0;
                } catch (error) {
                    return 0;
                }
            }

            async initialize() {
                console.log('[LyricsBear] Initialisation terminée v166');
                
                setTimeout(async () => {
                    const currentTrack = this.getCurrentTrack();
                    if (currentTrack) {
                        console.log('[LyricsBear] Piste détectée à l\'initialisation:', currentTrack.name);
                        await this.handleTrackChange(currentTrack);
                    }
                }, 2000);
            }

            toggle() {
                console.log('[LyricsBear] Toggle appelé - isVisible:', state.isVisible);
                if (state.isVisible) {
                    this.hide();
                } else {
                    this.show();
                }
            }

            show() {
                if (!state.container) {
                    console.warn('[LyricsBear] Container non trouvé pour show()');
                    return;
                }
                
                console.log('[LyricsBear] Affichage panneau');
                state.container.classList.add('visible');
                state.isVisible = true;
                
                if (state.button) {
                    state.button.classList.add('active');
                }

                this.startWordSync();
                
                if (state.currentTrack && !state.lyrics.length && !state.isLoading) {
                    console.log('[LyricsBear] Pas de paroles, rechargement...');
                    this.handleTrackChange(state.currentTrack);
                }
            }

            hide() {
                if (!state.container) return;
                
                console.log('[LyricsBear] Masquage panneau');
                state.container.classList.remove('visible');
                state.isVisible = false;
                
                if (state.button) {
                    state.button.classList.remove('active');
                }

                this.stopWordSync();
            }

            startWordSync() {
                if (state.updateInterval) return;
                
                state.updateInterval = setInterval(() => {
                    this.updateWordSync();
                }, CONFIG.UPDATE_INTERVAL);
                
                console.log('[LyricsBear] Synchronisation démarrée');
            }

            stopWordSync() {
                if (state.updateInterval) {
                    clearInterval(state.updateInterval);
                    state.updateInterval = null;
                }
                
                console.log('[LyricsBear] Synchronisation arrêtée');
            }

            // NOUVELLE FONCTIONNALITÉ : Sélection de source avec réessai
            async selectSource(sourceId) {
                if (!sourceId || !state.currentTrack) return;

                console.log('[LyricsBear] Source sélectionnée manuellement:', sourceId);
                
                // Réinitialiser les statuts
                Object.keys(state.sourceStatuses).forEach(key => {
                    state.sourceStatuses[key] = 'idle';
                    this.updateSourceStatus(key, 'idle');
                });
                
                state.currentSource = sourceId;
                state.lyrics = [];
                state.wordSyncData = null;
                state.isLoading = true;
                
                this.updateSourceStatus(sourceId, 'loading');
                this.showLoading(`Recherche via ${sourceId}...`);
                this.updateStatusInfo(`Tentative manuelle via ${sourceId}`);
                
                try {
                    const lyricsData = await this.fetchLyricsFromSource(state.currentTrack, sourceId);
                    
                    if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
                        state.lyrics = lyricsData.lines;
                        state.wordSyncData = lyricsData.wordSync;
                        
                        this.updateSourceStatus(sourceId, 'success');
                        this.updateStatusInfo(`Paroles trouvées via ${sourceId} - ${lyricsData.hasWordSync ? 'Sync mot par mot' : 'Sync ligne par ligne'}`);
                        
                        if (state.isVisible) {
                            this.displayLyrics(state.lyrics);
                        }
                        
                        if (state.downloadEnabled) {
                            await this.downloadLyrics(state.currentTrack, lyricsData, sourceId);
                        }
                    } else {
                        throw new Error('Aucune parole trouvée');
                    }
                    
                } catch (error) {
                    console.error('[LyricsBear] Erreur source manuelle', sourceId, ':', error.message);
                    this.updateSourceStatus(sourceId, 'error');
                    this.displayError(`Erreur ${sourceId}: ${error.message}`, sourceId);
                } finally {
                    state.isLoading = false;
                }
            }

            async refreshLyrics() {
                console.log('[LyricsBear] Actualisation paroles - recherche automatique');
                if (state.currentTrack && !state.isLoading) {
                    // Réinitialiser tout
                    state.lyrics = [];
                    state.wordSyncData = null;
                    state.lastActiveIndex = -1;
                    state.lastActiveWordIndex = -1;
                    state.loadingQueue.clear();
                    
                    // Réinitialiser les statuts des sources
                    Object.keys(state.sourceStatuses).forEach(key => {
                        state.sourceStatuses[key] = 'idle';
                        this.updateSourceStatus(key, 'idle');
                    });
                    
                    await this.handleTrackChange(state.currentTrack);
                }
            }

            async handleTrackChange(track) {
                if (!track) return;
                
                const trackKey = `${track.name}-${track.artists?.[0]?.name}`;
                if (state.loadingQueue.has(trackKey)) {
                    console.log('[LyricsBear] Requête déjà en cours pour:', trackKey);
                    return;
                }
                
                const cleanTrack = {
                    id: track.id || track.uri || this.generateTrackId(track.name, track.artists?.[0]?.name),
                    name: track.name || '',
                    artists: track.artists || [],
                    images: track.images || [],
                    uri: track.uri || ''
                };

                if (!cleanTrack.name || cleanTrack.name === 'Unknown') {
                    console.log('[LyricsBear] Piste invalide ignorée');
                    return;
                }

                // Vérifier le cache récent
                const cachedTrack = state.cachedTracks.get(cleanTrack.id);
                if (cachedTrack && (Date.now() - cachedTrack.timestamp < CONFIG.CACHE_DURATION)) {
                    console.log('[LyricsBear] Utilisation cache pour:', cleanTrack.name);
                    state.currentTrack = cleanTrack;
                    state.lyrics = cachedTrack.lyrics;
                    state.wordSyncData = cachedTrack.wordSync;
                    
                    this.updateTrackInfo();
                    if (state.isVisible) {
                        this.displayLyrics(state.lyrics);
                    }
                    return;
                }

                if (state.currentTrack?.id === cleanTrack.id && !state.isLoading) {
                    return;
                }

                console.log('[LyricsBear] Traitement nouvelle piste:', cleanTrack.name);
                state.currentTrack = cleanTrack;
                state.loadingQueue.add(trackKey);
                this.updateTrackInfo();
                
                // Réinitialiser les statuts des sources
                Object.keys(state.sourceStatuses).forEach(key => {
                    state.sourceStatuses[key] = 'idle';
                    this.updateSourceStatus(key, 'idle');
                });
                
                if (state.isVisible) {
                    this.showLoading('Recherche automatique en cours...');
                }
                
                state.isLoading = true;
                try {
                    // NOUVELLE FONCTIONNALITÉ : Recherche automatique avec fallback
                    const lyricsData = await this.performAutomaticSearch(cleanTrack);
                    
                    if (state.currentTrack?.id !== cleanTrack.id) {
                        console.log('[LyricsBear] Piste changée pendant le chargement, abandon');
                        return;
                    }
                    
                    if (lyricsData && lyricsData.lines && lyricsData.lines.length > 0) {
                        state.lyrics = lyricsData.lines;
                        state.wordSyncData = lyricsData.wordSync;
                        
                        // Mise en cache
                        state.cachedTracks.set(cleanTrack.id, {
                            lyrics: state.lyrics,
                            wordSync: state.wordSyncData,
                            timestamp: Date.now()
                        });
                        
                        console.log('[LyricsBear] Paroles trouvées:', state.lyrics.length, 'lignes, wordSync:', !!state.wordSyncData);
                        
                        if (state.isVisible) {
                            this.displayLyrics(state.lyrics);
                        }
                    } else {
                        throw new Error('Aucune parole trouvée sur toutes les sources');
                    }
                    
                } catch (error) {
                    console.error('[LyricsBear] Échec recherche automatique:', error.message);
                    
                    if (state.isVisible && state.currentTrack?.id === cleanTrack.id) {
                        this.displayError('Aucune parole trouvée sur toutes les sources', 'auto-search');
                    }
                } finally {
                    state.isLoading = false;
                    state.loadingQueue.delete(trackKey);
                }
            }

            updateSourceStatus(sourceId, status) {
                const sourceBtn = document.querySelector(`[data-source="${sourceId}"]`);
                if (sourceBtn) {
                    sourceBtn.classList.remove('loading', 'error', 'success', 'active');
                    if (status === 'success') {
                        sourceBtn.classList.add('success');
                    } else if (status === 'error') {
                        sourceBtn.classList.add('error');
                    } else if (status === 'loading') {
                        sourceBtn.classList.add('loading');
                    }
                }
                
                state.sourceStatuses[sourceId] = status;
            }

            async fetchLyricsFromSource(track, sourceId) {
                switch (sourceId) {
                    case 'network-batch':
                        return await this.fetchFromNetworkBatch(track);
                    case 'beautiful-lyrics':
                        return await this.fetchFromBeautifulLyrics(track);
                    case 'lrclib':
                        return await this.fetchFromLRCLib(track);
                    default:
                        throw new Error(`Source inconnue: ${sourceId}`);
                }
            }

            async fetchFromNetworkBatch(track) {
                console.log('[LyricsBear] 🔥 FORCE FETCH SPOTIFY WORD SYNC pour:', track.name);
                
                const trackId = track.id?.replace(/^spotify:track:/, '') || track.id;
                if (!trackId) {
                    throw new Error('ID manquant');
                }
                
                // ÉTAPE 1 : Vérifier cache
                const cachedData = state.interceptedData.get(trackId);
                if (cachedData && (Date.now() - cachedData.timestamp < CONFIG.CACHE_DURATION)) {
                    console.log('[LyricsBear] ✅ Cache trouvé');
                    return cachedData.data;
                }
                
                // ÉTAPE 2 : FORCE FETCH avec CosmosAsync (API INTERNE SPOTIFY)
                if (window.Spicetify?.CosmosAsync) {
                    try {
                        console.log('[LyricsBear] 💪 Force fetch CosmosAsync...');
                        
                        const response = await Spicetify.CosmosAsync.get(
                            `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}`,
                            {
                                format: 'json',
                                vocalRemoval: false,
                                market: 'from_token'
                            }
                        );
                        
                        console.log('[LyricsBear] Réponse CosmosAsync:', response);
                        
                        if (response && response.lyrics) {
                            console.log('[LyricsBear] ✅✅✅ WORD SYNC TROUVÉ via CosmosAsync !');
                            const converted = this.convertBatchToLyrics(response.lyrics);
                            
                            // Mettre en cache
                            state.interceptedData.set(trackId, {
                                data: converted,
                                timestamp: Date.now(),
                                sourceUrl: 'cosmos-force-fetch',
                                originalData: response.lyrics
                            });
                            
                            return converted;
                        } else {
                            console.warn('[LyricsBear] Réponse CosmosAsync sans lyrics');
                        }
                    } catch (cosmosError) {
                        console.error('[LyricsBear] ❌ CosmosAsync échoué:', cosmosError);
                    }
                } else {
                    console.warn('[LyricsBear] ⚠️ Spicetify.CosmosAsync non disponible !');
                }
                
                // ÉTAPE 3 : Fetch direct avec token (FALLBACK)
                if (window.Spicetify?.Platform?.Session) {
                    try {
                        console.log('[LyricsBear] 💪 Force fetch avec token...');
                        
                        const accessToken = Spicetify.Platform.Session.accessToken;
                        
                        if (!accessToken) {
                            throw new Error('Pas de token disponible');
                        }
                        
                        const response = await fetch(
                            `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
                            {
                                method: 'GET',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
                                    'App-Platform': 'WebPlayer',
                                    'Accept': 'application/json',
                                    'Spotify-App-Version': '1.2.0'
                                }
                            }
                        );
                        
                        console.log('[LyricsBear] Fetch token status:', response.status);
                        
                        if (response.ok) {
                            const data = await response.json();
                            console.log('[LyricsBear] Fetch token data:', data);
                            
                            if (data && data.lyrics) {
                                console.log('[LyricsBear] ✅✅✅ WORD SYNC TROUVÉ via token fetch !');
                                const converted = this.convertBatchToLyrics(data.lyrics);
                                
                                // Mettre en cache
                                state.interceptedData.set(trackId, {
                                    data: converted,
                                    timestamp: Date.now(),
                                    sourceUrl: 'token-force-fetch',
                                    originalData: data.lyrics
                                });
                                
                                return converted;
                            }
                        } else {
                            console.warn('[LyricsBear] Fetch token HTTP', response.status);
                        }
                    } catch (fetchError) {
                        console.error('[LyricsBear] ❌ Fetch token échoué:', fetchError);
                    }
                } else {
                    console.warn('[LyricsBear] ⚠️ Spicetify.Platform.Session non disponible !');
                }
                
                // ÉTAPE 4 : Attendre l'interception passive (dernier recours)
                console.log('[LyricsBear] 🕐 Fallback: attente interception passive (5s)...');
                
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Timeout: aucune parole word sync disponible'));
                    }, 5000);
                    
                    const checkInterval = setInterval(() => {
                        if (state.currentTrack?.id !== track.id) {
                            clearTimeout(timeout);
                            clearInterval(checkInterval);
                            reject(new Error('Track changed'));
                            return;
                        }
                        
                        const newData = state.interceptedData.get(trackId);
                        if (newData && (Date.now() - newData.timestamp < 5000)) {
                            clearTimeout(timeout);
                            clearInterval(checkInterval);
                            resolve(newData.data);
                            return;
                        }
                    }, 100);
                });
            }

            async fetchFromBeautifulLyrics(track) {
                console.log('[LyricsBear] Recherche Beautiful Lyrics pour:', track.name);
                
                const trackId = track.id?.replace(/^spotify:track:/, '') || track.id;
                if (!trackId) {
                    throw new Error('ID de piste manquant');
                }
                
                // ÉTAPE 1 : Vérifier si Beautiful Lyrics a déjà chargé les données
                console.log('[LyricsBear] Vérification cache Beautiful Lyrics...');
                for (const [cachedId, cachedData] of state.interceptedData.entries()) {
                    if (this.trackIdsMatch(trackId, cachedId) && 
                        cachedData.sourceUrl && 
                        cachedData.sourceUrl.includes('beautiful-lyrics')) {
                        console.log('[LyricsBear] ✅ Beautiful Lyrics trouvé en cache');
                        return cachedData.data;
                    }
                }
                
                // ÉTAPE 2 : Beautiful Lyrics n'est PAS installé ou ne fonctionne pas
                // Essayer l'API directement SANS proxy (accepter l'échec CORS)
                console.log('[LyricsBear] Tentative Beautiful Lyrics API directe...');
                
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Beautiful Lyrics non disponible (CORS ou non installé)'));
                    }, 2000);
                    
                    // Vérifier si Beautiful Lyrics va charger dans les 2 prochaines secondes
                    const checkInterval = setInterval(() => {
                        for (const [cachedId, cachedData] of state.interceptedData.entries()) {
                            if (this.trackIdsMatch(trackId, cachedId) && 
                                cachedData.sourceUrl && 
                                cachedData.sourceUrl.includes('beautiful-lyrics')) {
                                clearTimeout(timeout);
                                clearInterval(checkInterval);
                                resolve(cachedData.data);
                                return;
                            }
                        }
                    }, 100);
                });
            }

            // Nouvelle méthode helper pour le proxy en fallback
            async fetchBeautifulLyricsWithProxy(trackId) {
                const originalUrl = `${CONFIG.API_ENDPOINTS.BEAUTIFUL_LYRICS}${trackId}`;
                
                // Proxies CORS fiables et rapides (dans l'ordre de préférence)
                const corsProxies = [
                    { url: 'https://api.allorigins.win/raw?url=', name: 'AllOrigins' },
                    { url: 'https://corsproxy.io/?', name: 'CorsProxy.io' },
                    { url: 'https://api.codetabs.com/v1/proxy?quest=', name: 'CodeTabs' }
                ];
                
                for (const proxy of corsProxies) {
                    try {
                        const proxyUrl = proxy.url + encodeURIComponent(originalUrl);
                        console.log(`[LyricsBear] Tentative proxy ${proxy.name}:`, proxyUrl);
                        
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 8000);
                        
                        const response = await fetch(proxyUrl, {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json'
                            },
                            signal: controller.signal
                        });
                        
                        clearTimeout(timeoutId);
                        
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                        
                        const data = await response.json();
                        const convertedData = this.convertBeautifulLyrics(data);
                        
                        if (!convertedData || !convertedData.lines || convertedData.lines.length === 0) {
                            throw new Error('Aucune parole disponible');
                        }
                        
                        console.log(`[LyricsBear] ✅ Succès avec proxy ${proxy.name}`);
                        return convertedData;
                        
                    } catch (error) {
                        console.warn(`[LyricsBear] Échec proxy ${proxy.name}:`, error.message);
                        // Continuer avec le prochain proxy
                    }
                }
                
                throw new Error('Tous les proxies Beautiful Lyrics ont échoué');
            }

            async fetchFromLRCLib(track) {
                console.log('[LyricsBear] Recherche LRCLib pour:', track.name);
                
                const artist = track.artists?.[0]?.name || '';
                const title = track.name || '';
                
                if (!artist || !title) {
                    throw new Error('Titre ou artiste manquant');
                }
                
                const cleanTitle = title.replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
                const cleanArtist = artist.replace(/\s*[\(\[].*?[\)\]]/g, '').trim();

                try {
                    const response = await fetch(
                        `${CONFIG.API_ENDPOINTS.LRCLIB}?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}`,
                        {
                            headers: {
                                'User-Agent': 'LyricsBear/166'
                            },
                            signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
                        }
                    );

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    
                    const data = await response.json();
                    let convertedData = null;
                    
                    if (data.syncedLyrics) {
                        const parsedLines = this.parseLRC(data.syncedLyrics);
                        convertedData = {
                            lines: parsedLines,
                            wordSync: null,
                            source: 'lrclib',
                            hasWordSync: false
                        };
                    } else if (data.plainLyrics) {
                        const staticLines = this.parseStaticLyrics(data.plainLyrics);
                        convertedData = {
                            lines: staticLines,
                            wordSync: null,
                            source: 'lrclib',
                            hasWordSync: false
                        };
                    }
                    
                    if (!convertedData || !convertedData.lines || convertedData.lines.length === 0) {
                        throw new Error('Aucune parole disponible');
                    }
                    
                    return convertedData;
                    
                } catch (error) {
                    console.error('[LyricsBear] Erreur LRCLib:', error);
                    throw error;
                }
            }

            trackIdsMatch(id1, id2) {
                if (!id1 || !id2) return false;
                if (id1 === id2) return true;
                
                const clean1 = id1.replace(/[^\w]/g, '').toLowerCase();
                const clean2 = id2.replace(/[^\w]/g, '').toLowerCase();
                
                return clean1 === clean2 || 
                       clean1.includes(clean2) || 
                       clean2.includes(clean1);
            }

            parseLRC(lrcContent) {
                if (!lrcContent) return [];
                
                const lines = [];
                const lrcLines = lrcContent.split('\n');
                
                for (const line of lrcLines) {
                    const match = line.match(/\[(\d{1,2}):(\d{2})\.(\d{2,3})\](.*)/);
                    if (match) {
                        const minutes = parseInt(match[1]);
                        const seconds = parseInt(match[2]);
                        const subseconds = parseInt(match[3]);
                        const text = match[4].trim();
                        
                        if (text && text !== '♪') {
                            const multiplier = match[3].length === 3 ? 1 : 10;
                            const startTime = (minutes * 60 + seconds) * 1000 + subseconds * multiplier;
                            
                            lines.push({
                                startTime: startTime,
                                text: text,
                                words: []
                            });
                        }
                    }
                }
                
                return lines.sort((a, b) => a.startTime - b.startTime);
            }

            parseStaticLyrics(lyricsText) {
                if (!lyricsText) return [];
                
                return lyricsText
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line && line !== '♪')
                    .map((line, index) => ({
                        startTime: index * 3000,
                        text: line,
                        words: []
                    }));
            }

            updateWordSync() {
                if (!state.lyrics.length || !state.isVisible) return;

                const currentTime = this.getCurrentTime();
                
                let activeLineIndex = -1;
                for (let i = 0; i < state.lyrics.length; i++) {
                    if (currentTime >= state.lyrics[i].startTime) {
                        activeLineIndex = i;
                    } else {
                        break;
                    }
                }

                if (activeLineIndex !== state.lastActiveIndex) {
                    this.updateActiveLine(activeLineIndex);
                    state.lastActiveIndex = activeLineIndex;
                }

                if (state.wordSyncData && activeLineIndex >= 0 && activeLineIndex < state.wordSyncData.length) {
                    const currentLine = state.wordSyncData[activeLineIndex];
                    if (currentLine.words && currentLine.words.length > 0) {
                        this.updateActiveWords(currentLine.words, currentTime);
                    }
                }
            }

            updateActiveLine(activeIndex) {
                const lines = document.querySelectorAll('.sl-lyrics-line');
                
                lines.forEach((line, index) => {
                    line.classList.remove('active');
                    if (index === activeIndex) {
                        line.classList.add('active');
                        line.scrollIntoView({ 
                            behavior: 'smooth', 
                            block: 'center'
                        });
                    }
                });
            }

            updateActiveWords(words, currentTime) {
                if (!words || words.length === 0) return;

                let activeWordIndex = -1;
                for (let i = 0; i < words.length; i++) {
                    if (currentTime >= words[i].startTime && 
                        (i === words.length - 1 || currentTime < words[i + 1].startTime)) {
                        activeWordIndex = i;
                        break;
                    }
                }

                if (activeWordIndex !== state.lastActiveWordIndex) {
                    const wordElements = document.querySelectorAll('.sl-lyrics-line.active .sl-word');
                    
                    wordElements.forEach((wordEl, index) => {
                        wordEl.classList.remove('active', 'sung');
                        
                        if (index < activeWordIndex) {
                            wordEl.classList.add('sung');
                        } else if (index === activeWordIndex) {
                            wordEl.classList.add('active');
                        }
                    });

                    state.lastActiveWordIndex = activeWordIndex;
                }
            }

            updateTrackInfo() {
                const trackSection = document.getElementById('sl-track-section');
                const titleEl = document.getElementById('sl-track-title');
                const artistEl = document.getElementById('sl-track-artist');
                const coverEl = document.getElementById('sl-cover');
                
                if (!trackSection || !state.currentTrack) return;
                
                const artists = state.currentTrack.artists?.map(a => a.name).join(', ') || 'Artiste inconnu';
                
                if (titleEl) titleEl.textContent = state.currentTrack.name || 'Titre inconnu';
                if (artistEl) artistEl.textContent = artists;
                
                if (coverEl) {
                    const imageUrl = state.currentTrack.images?.[0]?.url;
                    if (imageUrl) {
                        coverEl.innerHTML = `<img src="${imageUrl}" alt="Cover">`;
                    } else {
                        coverEl.innerHTML = '<div style="color: rgba(255,255,255,0.3); font-size: 28px;">♫</div>';
                    }
                }
                
                trackSection.style.display = 'block';
                console.log('[LyricsBear] Interface piste mise à jour');
            }

            displayLyrics(lyrics) {
                const content = document.getElementById('sl-content');
                
                if (!content || !lyrics || lyrics.length === 0) {
                    this.displayError('Aucune parole trouvée');
                    return;
                }

                const lyricsContainer = document.createElement('div');
                lyricsContainer.className = 'sl-lyrics-container';
                
                lyrics.forEach((line, index) => {
                    const lineElement = document.createElement('div');
                    lineElement.className = 'sl-lyrics-line';
                    lineElement.dataset.time = line.startTime;
                    lineElement.dataset.index = index;
                    
                    if (line.words && line.words.length > 0) {
                        lineElement.innerHTML = line.words
                            .map(word => `<span class="sl-word">${this.escapeHtml(word.text)}</span>`)
                            .join(' ');
                    } else {
                        lineElement.textContent = line.text;
                    }
                    
                    lineElement.addEventListener('click', () => {
                        const time = parseInt(lineElement.dataset.time);
                        try {
                            if (Spicetify?.Player?.seek) {
                                Spicetify.Player.seek(time);
                                console.log('[LyricsBear] Navigation vers', time + 'ms');
                            }
                        } catch (error) {
                            console.error('[LyricsBear] Erreur navigation:', error);
                        }
                    });
                    
                    lyricsContainer.appendChild(lineElement);
                });
                
                content.innerHTML = '';
                content.appendChild(lyricsContainer);

                console.log('[LyricsBear] Interface améliorée mise à jour:', lyrics.length, 'lignes');
            }

            showLoading(message = 'Chargement...') {
                const content = document.getElementById('sl-content');
                if (content) {
                    content.innerHTML = `
                        <div class="sl-loading">
                            <div class="sl-loading-icon">
                                <div class="sl-spinner"></div>
                            </div>
                            <div>${message}</div>
                        </div>
                    `;
                }
            }

            displayError(errorMessage, context = null) {
                const content = document.getElementById('sl-content');
                if (!content) return;
                
                let retryButtons = '';
                
                // NOUVELLE FONCTIONNALITÉ : Boutons de réessai par source
                if (context === 'auto-search' || !context) {
                    retryButtons = `
                        <div class="sl-retry-actions">
                            <button class="sl-btn" onclick="window.syncLyricsManager?.selectSource('network-batch')" style="padding: 12px 20px;">
                                Réseau
                            </button>
                            <button class="sl-btn" onclick="window.syncLyricsManager?.selectSource('lrclib')" style="padding: 12px 20px;">
                                LRCLib
                            </button>
                            <button class="sl-btn" onclick="window.syncLyricsManager?.selectSource('beautiful-lyrics')" style="padding: 12px 20px;">
                                Beautiful
                            </button>
                            <button class="sl-btn" onclick="window.syncLyricsManager?.refreshLyrics()" style="padding: 12px 20px; background: var(--sl-gradient); color: white;">
                                Auto Recherche
                            </button>
                        </div>
                    `;
                } else {
                    retryButtons = `
                        <div class="sl-retry-actions">
                            <button class="sl-btn" onclick="window.syncLyricsManager?.selectSource('${context}')" style="padding: 12px 20px;">
                                Réessayer ${context}
                            </button>
                            <button class="sl-btn" onclick="window.syncLyricsManager?.refreshLyrics()" style="padding: 12px 20px; background: var(--sl-gradient); color: white;">
                                Auto Recherche
                            </button>
                        </div>
                    `;
                }
                
                content.innerHTML = `
                    <div class="sl-error-state">
                        <div class="sl-loading-icon">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity: 0.3;">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                            </svg>
                        </div>
                        <p>Aucune parole disponible</p>
                        <small style="opacity: 0.6;">${this.escapeHtml(errorMessage)}</small>
                        ${retryButtons}
                    </div>
                `;
            }

            escapeHtml(text) {
                if (!text) return '';
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            destroy() {
                console.log('[LyricsBear] Destruction manager');
                this.hide();
                this.stopWordSync();
                
                if (state.container) {
                    state.container.remove();
                    state.container = null;
                }
                
                if (state.button) {
                    state.button.remove();
                    state.button = null;
                }
                
                const styles = document.getElementById('synclyrics-styles');
                if (styles) {
                    styles.remove();
                }

                state.interceptedData.clear();
                state.cachedTracks.clear();
                state.loadingQueue.clear();
            }
        }

        const initManager = () => {
            try {
                if (state.manager) {
                    state.manager.destroy();
                }
                state.manager = new LyricsBearManager();
                
                window.syncLyricsManager = state.manager;
                
                console.log('[LyricsBear] Manager amélioré initialisé v166');
            } catch (error) {
                console.error('[LyricsBear] Erreur initialisation:', error);
                setTimeout(initManager, 3000);
            }
        };

        let observer;
        const startObserver = () => {
            observer = new MutationObserver((mutations) => {
                const topbar = document.querySelector('.main-topBar-container') || 
                              document.querySelector('[data-testid="topbar-content-wrapper"]');
                if (topbar && !state.container) {
                    console.log('[LyricsBear] Interface Spotify détectée');
                    observer.disconnect();
                    setTimeout(initManager, 1000);
                }
            });

            if (document.body) {
                observer.observe(document.body, { 
                    childList: true, 
                    subtree: true
                });
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObserver);
        } else if (document.querySelector('.main-topBar-container')) {
            setTimeout(initManager, 500);
        } else {
            startObserver();
        }

        setTimeout(() => {
            if (!state.container && observer) {
                console.log('[LyricsBear] Fallback initialisation après timeout');
                observer.disconnect();
                initManager();
            }
        }, 15000);

        window.addEventListener('beforeunload', () => {
            if (state.manager) {
                state.manager.destroy();
            }
        });

        // API Debug améliorée v166
        window.LyricsBearDebug = {
            getState: () => ({
                isVisible: state.isVisible,
                currentTrack: state.currentTrack,
                lyricsCount: state.lyrics.length,
                hasWordSync: !!state.wordSyncData,
                currentSource: state.currentSource,
                isLoading: state.isLoading,
                downloadEnabled: state.downloadEnabled,
                interceptedDataCount: state.interceptedData.size,
                cachedTracksCount: state.cachedTracks.size,
                loadingQueueSize: state.loadingQueue.size,
                sourceStatuses: state.sourceStatuses
            }),
            toggle: () => state.manager?.toggle(),
            refresh: () => state.manager?.refreshLyrics(),
            getCurrentTrack: () => state.manager?.getCurrentTrack(),
            show: () => state.manager?.show(),
            hide: () => state.manager?.hide(),
            selectSource: (source) => state.manager?.selectSource(source),
            performAutoSearch: () => state.manager?.performAutomaticSearch(state.currentTrack),
            enableDownload: () => {
                state.downloadEnabled = true;
                state.manager?.saveSettings();
                const switchEl = document.getElementById('sl-download-switch');
                if (switchEl) switchEl.classList.add('active');
            },
            disableDownload: () => {
                state.downloadEnabled = false;
                state.manager?.saveSettings();
                const switchEl = document.getElementById('sl-download-switch');
                if (switchEl) switchEl.classList.remove('active');
            },
            getDownloadedFiles: () => {
                try {
                    return JSON.parse(localStorage.getItem('synclyrics-downloaded') || '{}');
                } catch {
                    return {};
                }
            },
            clearDownloadedFiles: () => {
                localStorage.removeItem('synclyrics-downloaded');
                console.log('[LyricsBear] Liste des fichiers téléchargés vidée');
            },
            getInterceptedData: () => {
                const data = {};
                state.interceptedData.forEach((value, key) => {
                    data[key] = {
                        lines: value.data.lines.length,
                        hasWordSync: value.data.hasWordSync,
                        timestamp: new Date(value.timestamp).toLocaleString(),
                        source: value.data.source
                    };
                });
                return data;
            },
            getCachedTracks: () => {
                const data = {};
                state.cachedTracks.forEach((value, key) => {
                    data[key] = {
                        lyricsCount: value.lyrics.length,
                        hasWordSync: !!value.wordSync,
                        timestamp: new Date(value.timestamp).toLocaleString()
                    };
                });
                return data;
            },
            clearCache: () => {
                state.interceptedData.clear();
                state.cachedTracks.clear();
                state.loadingQueue.clear();
                console.log('[LyricsBear] Tous les caches vidés');
            },
            injectTestData: (trackId, lyricsData) => {
                if (state.manager) {
                    console.log('[LyricsBear] Injection données test:', trackId);
                    const jsonData = typeof lyricsData === 'string' ? lyricsData : JSON.stringify(lyricsData);
                    state.manager.handleLyricsResponse(jsonData, `test://injected/${trackId}`);
                }
            },
            simulateTrackChange: (trackName, artistName) => {
                if (state.manager) {
                    const fakeTrack = {
                        name: trackName,
                        artists: [{ name: artistName }],
                        id: state.manager.generateTrackId(trackName, artistName)
                    };
                    console.log('[LyricsBear] Simulation changement piste:', fakeTrack);
                    state.manager.handleTrackChange(fakeTrack);
                }
            },
            testSourceFetch: async (source, trackId) => {
                if (state.manager && state.currentTrack) {
                    console.log('[LyricsBear] Test fetch source:', source);
                    try {
                        const result = await state.manager.fetchLyricsFromSource(state.currentTrack, source);
                        console.log('Résultat:', result);
                        return result;
                    } catch (error) {
                        console.error('Erreur:', error);
                        return { error: error.message };
                    }
                }
            },
            resetSourceStatuses: () => {
                Object.keys(state.sourceStatuses).forEach(key => {
                    state.sourceStatuses[key] = 'idle';
                    state.manager?.updateSourceStatus(key, 'idle');
                });
                console.log('[LyricsBear] Statuts des sources réinitialisés');
            }
        };

        console.log('[LyricsBear] Script Enhanced chargé v166');
        console.log('[LyricsBear] NOUVELLES FONCTIONNALITÉS v166:');
        console.log('Téléchargement automatique ACTIVÉ par défaut');
        console.log('Recherche automatique avec fallback sur toutes les sources');
        console.log('Boutons de réessai par source individuelle');
        console.log('Détection améliorée de Beautiful Lyrics et Spicy Lyrics');
        console.log('Interface de statut en temps réel des sources');
        console.log('Gestion des erreurs avec options de récupération');
        console.log('[LyricsBear] Raccourci: Ctrl+Shift+L');
        console.log('[LyricsBear] Debug: window.LyricsBearDebug');
    }

    try {
        waitForSpicetify();
    } catch (error) {
        console.error('[LyricsBear] Erreur fatale:', error);
        setTimeout(waitForSpicetify, 5000);
    }

})();
