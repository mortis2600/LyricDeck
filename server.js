require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Disk persistence (user corrections survive restarts) ----------
const DATA_DIR = path.join(__dirname, 'data');
const PERSIST_PATH = path.join(DATA_DIR, 'persist.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let persisted = { manualOverrides: {}, syncOffsets: {}, partyQueue: [] };
try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    persisted = Object.assign(persisted, JSON.parse(raw));
} catch (e) { /* first run, nothing persisted yet */ }

let saveTimer = null;
function savePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(PERSIST_PATH, JSON.stringify(persisted, null, 2));
        } catch (e) { console.error('[Persist] save failed:', e.message); }
    }, 500);
}

const localPlexAgent = new https.Agent({ rejectUnauthorized: false });

// ---------- Kuroshiro (romaji) ----------
let kuroshiro = null;
let kuroshiroReady = false;
try {
    const Kuroshiro = require("kuroshiro");
    const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");
    kuroshiro = new (Kuroshiro.default || Kuroshiro)();
    kuroshiro.init(new KuromojiAnalyzer())
        .then(() => { kuroshiroReady = true; console.log('[Kuroshiro] ready'); })
        .catch(e => console.error("[Kuroshiro] Init error:", e.message));
} catch(e) {}

const trackCache = new Map();
const romajiCache = new Map();
let manualOverrides = persisted.manualOverrides || {};
let syncOffsets = persisted.syncOffsets || {};
let partyQueue = persisted.partyQueue || [];
let lastNowPlaying = { playing: false };

// Origins allowed through /api/image (Spotify CDN + known media servers).
// Plex server origins are learned as clients connect.
const knownServerOrigins = new Set();
function originOf(u) { try { return new URL(u).origin; } catch (e) { return null; } }
if (process.env.JELLYFIN_URL) {
    const o = originOf(process.env.JELLYFIN_URL);
    if (o) knownServerOrigins.add(o);
}

function parseSentences(text) {
    if (!text) return [];
    return (text.match(/[^.!?]+[.!?]+/g) || [])
        .map(s => s.trim())
        .filter(s => s.length > 35 && s.length < 200);
}

async function fetchTrivia(title, artist, trackId) {
    let cacheEntry = trackCache.get(trackId);
    if (!cacheEntry) return;

    try {
        let facts = [];

        // Genius annotations first (music-specific), Wikipedia as fallback.
        try {
            const geniusFacts = await fetchGeniusFacts(title, artist);
            if (geniusFacts.length > 0) facts.push(...geniusFacts);
        } catch (e) {}

        let trackLink = null;
        let artistLink = null;

        const trackSearch = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'search', srsearch: `${title} ${artist} song`, utf8: '', format: 'json' },
            headers: { 'User-Agent': 'LyricDeck/1.0' }, timeout: 3000
        });

        if (trackSearch.data?.query?.search?.length > 0) {
            const pageTitle = trackSearch.data.query.search[0].title;
            const summary = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`, {
                headers: { 'User-Agent': 'LyricDeck/1.0' }, timeout: 3000
            });
            if (summary.data?.content_urls?.desktop?.page) trackLink = summary.data.content_urls.desktop.page;
            const sentences = parseSentences(summary.data?.extract);
            if (sentences.length > 1) facts.push(...sentences.slice(1, 3));
            else if (sentences.length === 1) facts.push(sentences[0]);
        }

        const artistSearch = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'search', srsearch: `${artist} musician band`, utf8: '', format: 'json' },
            headers: { 'User-Agent': 'LyricDeck/1.0' }, timeout: 3000
        });

        if (artistSearch.data?.query?.search?.length > 0) {
            const artistPageTitle = artistSearch.data.query.search[0].title;
            const artistSummary = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artistPageTitle)}`, {
                headers: { 'User-Agent': 'LyricDeck/1.0' }, timeout: 3000
            });
            if (artistSummary.data?.content_urls?.desktop?.page) artistLink = artistSummary.data.content_urls.desktop.page;
            const sentences = parseSentences(artistSummary.data?.extract);
            if (sentences.length > 1) facts.push(...sentences.slice(1, 3));
            else if (sentences.length === 1) facts.push(sentences[0]);
        }

        cacheEntry.trivia = [...new Set(facts)].slice(0, 5);
        cacheEntry.wikiLinks = { track: trackLink, artist: artistLink };
    } catch (e) {}
}

async function fetchGeniusFacts(title, artist) {
    const token = process.env.GENIUS_ACCESS_TOKEN;
    if (!token || !title) return [];
    try {
        const search = await axios.get('https://api.genius.com/search', {
            params: { q: `${title} ${artist || ''}`.trim() },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 4000
        });
        const hits = search.data?.response?.hits || [];
        const songHit = hits.find(h => h.type === 'song') || hits[0];
        const songId = songHit?.result?.id;
        if (!songId) return [];

        const facts = [];

        try {
            const songRes = await axios.get(`https://api.genius.com/songs/${songId}`, {
                params: { text_format: 'plain' },
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 4000
            });
            const desc = songRes.data?.response?.song?.description_plain;
            if (desc) facts.push(...parseSentences(desc).slice(0, 2));
        } catch (e) {}

        try {
            const refRes = await axios.get('https://api.genius.com/referents', {
                params: { song_id: songId, text_format: 'plain', per_page: 5 },
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 4000
            });
            const referents = refRes.data?.response?.referents || [];
            for (const ref of referents) {
                for (const ann of (ref.annotations || [])) {
                    const body = ann.body?.plain;
                    if (body) facts.push(...parseSentences(body).slice(0, 1));
                    if (facts.length >= 6) break;
                }
                if (facts.length >= 6) break;
            }
        } catch (e) {}

        return [...new Set(facts)].slice(0, 5);
    } catch (e) {
        return [];
    }
}

async function searchLrcLib(title, artist, album, durationSec, overrideData) {
    if (overrideData && overrideData.lrcId) {
        try {
            const res = await axios.get(`https://lrclib.net/api/get/${overrideData.lrcId}`, { timeout: 3000 });
            if (res.data?.syncedLyrics) return res.data.syncedLyrics;
        } catch (e) {}
        return null;
    }

    try {
        const exactRes = await axios.get('https://lrclib.net/api/get', {
            params: { track_name: title, artist_name: artist, album_name: album, duration: Math.round(durationSec) },
            timeout: 2500
        });
        if (exactRes.data?.syncedLyrics) return exactRes.data.syncedLyrics;
    } catch (e) {}

    const cleanTitle = title.replace(/\b(19|20)\d{2}\b/g, '').replace(/[\(\[].*?[\)\]]/g, '').trim();
    const cleanArtist = artist.trim();
    const queries = [
        { track_name: title, artist_name: artist },
        { track_name: cleanTitle, artist_name: cleanArtist },
        { q: `${cleanArtist} ${cleanTitle}` }
    ];

    for (const qParams of queries) {
        try {
            let res = await axios.get('https://lrclib.net/api/search', { params: qParams, timeout: 2500 });
            if (res.data?.length > 0) {
                const synced = res.data.filter(l => l.syncedLyrics);
                if (synced.length > 0) {
                    synced.sort((a, b) => Math.abs((a.duration || 0) - durationSec) - Math.abs((b.duration || 0) - durationSec));
                    const best = synced[0];
                    const diff = Math.abs((best.duration || 0) - durationSec);
                    if (diff <= 15 || (qParams.track_name && diff <= 40)) return best.syncedLyrics;
                }
            }
        } catch (e) {}
    }
    return null;
}

// Prime the cache for a track. Returns { entry, isNew } so callers can
// trigger gapless prefetch only when a track is genuinely new.
function primeTrackCache(artist, title, album, durationSec, overrideData) {
    const trackId = `${artist} - ${title}`;
    if (trackCache.has(trackId)) return { entry: trackCache.get(trackId), isNew: false };
    if (trackCache.size > 200) trackCache.delete(trackCache.keys().next().value);
    const cacheEntry = { syncedLyrics: null, trivia: [], wikiLinks: { track: null, artist: null } };
    trackCache.set(trackId, cacheEntry);

    searchLrcLib(title, artist, album, durationSec, overrideData).then(lyrics => {
        cacheEntry.syncedLyrics = lyrics;
    });
    fetchTrivia(title, artist, trackId);
    return { entry: cacheEntry, isNew: true };
}

// Proactively fetch lyrics+trivia for upcoming queue items (gapless transitions).
function primeUpcoming(items) {
    for (const t of (items || []).slice(0, 3)) {
        try {
            primeTrackCache(t.artist, t.title, t.album || '', t.durationSec || 0,
                manualOverrides[`${t.artist} - ${t.title}`]);
        } catch (e) {}
    }
}

function getSpotifyRedirectUri(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/auth/spotify/callback`;
}

// ---------- Page routes (party mode, remote, OBS overlay) ----------
app.get('/party', (req, res) => res.sendFile(path.join(__dirname, 'public', 'party.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

// ---------- Party mode state & queue ----------
app.get('/api/party/state', (req, res) => {
    res.json(Object.assign({}, lastNowPlaying, { queue: partyQueue }));
});

app.get('/api/party/queue', (req, res) => {
    res.json({ queue: partyQueue });
});

app.post('/api/party/queue', (req, res) => {
    const { title, artist, lrcId, addedBy } = req.body || {};
    if (!title || !artist) return res.status(400).json({ error: 'Title and artist required' });
    partyQueue.push({
        title: String(title), artist: String(artist),
        lrcId: lrcId || null, addedBy: addedBy || 'guest', addedAt: Date.now()
    });
    persisted.partyQueue = partyQueue;
    savePersist();
    res.json({ success: true, queue: partyQueue });
});

app.post('/api/party/queue/remove', (req, res) => {
    const { index } = req.body || {};
    if (typeof index !== 'number' || index < 0 || index >= partyQueue.length) {
        return res.status(400).json({ error: 'Invalid index' });
    }
    partyQueue.splice(index, 1);
    persisted.partyQueue = partyQueue;
    savePersist();
    res.json({ success: true, queue: partyQueue });
});

app.post('/api/party/queue/clear', (req, res) => {
    partyQueue = [];
    persisted.partyQueue = partyQueue;
    savePersist();
    res.json({ success: true, queue: [] });
});

// ---------- Romaji (kuroshiro) ----------
app.post('/api/romaji', async (req, res) => {
    const { text, texts, trackId } = req.body || {};
    if (!kuroshiroReady) return res.status(503).json({ error: 'Romaji engine not ready' });
    const list = Array.isArray(texts) ? texts : (text ? [text] : []);
    if (list.length === 0) return res.status(400).json({ error: 'Missing text' });
    try {
        const out = [];
        for (const t of list.slice(0, 200)) {
            const key = trackId ? `${trackId}::${t}` : t;
            if (romajiCache.has(key)) { out.push(romajiCache.get(key)); continue; }
            const r = await kuroshiro.convert(t, { to: 'romaji', mode: 'spaced' });
            if (romajiCache.size > 2000) romajiCache.delete(romajiCache.keys().next().value);
            romajiCache.set(key, r);
            out.push(r);
        }
        res.json({ romaji: out });
    } catch (e) {
        res.status(500).json({ error: 'Conversion failed' });
    }
});

// ---------- Genius annotations ----------
app.get('/api/annotations', async (req, res) => {
    const { title, artist } = req.query;
    if (!title && !artist) return res.status(400).json({ error: 'Missing search terms' });
    const facts = await fetchGeniusFacts(title || '', artist || '');
    res.json({ facts });
});

// ---------- Sync offset persistence ----------
app.get('/api/sync-offset', (req, res) => {
    const { trackId } = req.query;
    res.json({ offsetMs: (trackId && syncOffsets[trackId]) || 0 });
});

app.post('/api/sync-offset', (req, res) => {
    const { trackId, offsetMs } = req.body || {};
    if (!trackId || typeof offsetMs !== 'number') {
        return res.status(400).json({ error: 'Invalid parameters' });
    }
    syncOffsets[trackId] = Math.round(offsetMs);
    persisted.syncOffsets = syncOffsets;
    savePersist();
    res.json({ success: true });
});

// SPOTIFY AUTH ROUTES
app.get('/auth/spotify/login', (req, res) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) return res.status(500).send("SPOTIFY_CLIENT_ID is not configured in .env");

    const redirectUri = getSpotifyRedirectUri(req);
    const scope = 'user-read-currently-playing user-read-playback-state';
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
    const code = req.query.code;
    const redirectUri = getSpotifyRedirectUri(req);

    if (!code) return res.redirect('/?error=spotify_access_denied');

    try {
        const authHeader = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
        const tokenRes = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            }).toString(),
            {
                headers: {
                    'Authorization': `Basic ${authHeader}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, refresh_token, expires_in } = tokenRes.data;
        res.redirect(`/?service=spotify&access_token=${access_token}&refresh_token=${refresh_token || ''}&expires_in=${expires_in}`);
    } catch (e) {
        console.error('[Spotify Auth Error]', e.response?.data || e.message);
        res.redirect('/?error=spotify_auth_failed');
    }
});

// SPOTIFY NOW PLAYING
app.get('/api/spotify/now-playing', async (req, res) => {
    let { accessToken, refreshToken } = req.query;
    if (!accessToken) return res.status(400).json({ error: 'Missing access token' });

    let newAccessToken = null;

    async function querySpotify(token) {
        return await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 4000
        });
    }

    let spotifyRes;
    try {
        spotifyRes = await querySpotify(accessToken);
    } catch (err) {
        if (err.response?.status === 401 && refreshToken) {
            try {
                const authHeader = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
                const refreshRes = await axios.post('https://accounts.spotify.com/api/token',
                    new URLSearchParams({
                        grant_type: 'refresh_token',
                        refresh_token: refreshToken
                    }).toString(),
                    {
                        headers: {
                            'Authorization': `Basic ${authHeader}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    }
                );
                newAccessToken = refreshRes.data.access_token;
                spotifyRes = await querySpotify(newAccessToken);
            } catch (refreshErr) {
                return res.status(401).json({ error: 'Session expired' });
            }
        } else {
            return res.json({ playing: false });
        }
    }

    if (!spotifyRes || spotifyRes.status === 204 || !spotifyRes.data || !spotifyRes.data.item) {
        return res.json({ playing: false, newAccessToken });
    }

    const item = spotifyRes.data.item;
    const isPlaying = spotifyRes.data.is_playing;
    const playerState = isPlaying ? 'playing' : 'paused';
    const artist = item.artists.map(a => a.name).join(', ') || "Unknown Artist";
    const title = item.name || "Unknown Title";
    const album = item.album?.name || "";
    const offsetMs = spotifyRes.data.progress_ms || 0;
    const durationMs = item.duration_ms || 0;
    const durationSec = durationMs / 1000;
    const thumb = item.album?.images?.[0]?.url || "";
    const rawTrackKey = `${artist} - ${title}`;
    const trackId = `${artist} - ${title}`;

    const { entry: currentCache } = primeTrackCache(title, artist, album, durationSec, manualOverrides[rawTrackKey]);
    // Note: Spotify queue prefetch would need the /me/player/queue endpoint;
    // left out of v2 to keep the Plex-first focus.

    const payload = {
        playing: true,
        playerState,
        artist,
        album,
        title,
        rawTrackKey,
        offsetMs,
        durationMs,
        genre: "Music",
        thumb,
        nextTrack: null,
        syncedLyrics: currentCache?.syncedLyrics || null,
        trivia: currentCache?.trivia || [],
        wikiLinks: currentCache?.wikiLinks || { track: null, artist: null },
        availableSessions: [],
        activePlayerId: null,
        newAccessToken,
        savedSyncOffsetMs: syncOffsets[trackId] || 0
    };
    lastNowPlaying = Object.assign({}, payload, { source: 'spotify', fetchedAt: Date.now() });
    res.json(payload);
});

// PLEX AND COMMON ROUTES
app.get('/api/search-lyrics', async (req, res) => {
    const { title, artist } = req.query;
    if (!title && !artist) return res.status(400).json({ error: 'Missing search terms' });
    try {
        const query = `${artist || ''} ${title || ''}`.trim();
        const response = await axios.get('https://lrclib.net/api/search', { params: { q: query }, timeout: 8000 });
        res.json(Array.isArray(response.data) ? response.data.filter(t => t.syncedLyrics) : []);
    } catch (e) { res.status(500).json({ error: e.message || 'Search failed' }); }
});

app.post('/api/override', (req, res) => {
    const { rawTrackKey, title, artist, lrcId } = req.body;
    if (rawTrackKey && title && artist && lrcId) {
        manualOverrides[rawTrackKey] = { title, artist, lrcId };
        persisted.manualOverrides = manualOverrides;
        savePersist();
        trackCache.delete(`${artist} - ${title}`);
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid parameters' });
});

app.get('/api/now-playing', async (req, res) => {
    const { serverUrl, token, targetClient } = req.query;
    if (!serverUrl || !token) return res.status(400).json({ error: 'Missing credentials' });

    // Learn this Plex server's origin for the /api/image allowlist.
    const srvOrigin = originOf(serverUrl);
    if (srvOrigin) knownServerOrigins.add(srvOrigin);

    try {
        const plexRes = await axios.get(`${serverUrl}/status/sessions`, {
            headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
            httpsAgent: localPlexAgent,
            timeout: 5000
        });

        const sessions = plexRes.data?.MediaContainer?.Metadata;
        if (!sessions || sessions.length === 0) return res.json({ playing: false });

        const trackSessions = sessions.filter(s => s.type === 'track');
        if (trackSessions.length === 0) return res.json({ playing: false });

        const availableSessions = trackSessions.map(s => ({
            id: s.Player?.machineIdentifier || s.sessionKey,
            name: s.Player?.title || 'Unknown Device',
            user: s.User?.title || 'Unknown User'
        }));

        let track = trackSessions[0];
        if (targetClient) {
            const requested = trackSessions.find(s => (s.Player?.machineIdentifier === targetClient || s.sessionKey === targetClient));
            if (requested) track = requested;
        }

        const activePlayerId = track.Player?.machineIdentifier || track.sessionKey;
        const playerState = track.Player?.state || 'playing';
        const rawArtist = track.grandparentTitle || "Unknown Artist";
        const rawTitle = track.title || "Unknown Title";
        const rawTrackKey = `${rawArtist} - ${rawTitle}`;

        let artist = rawArtist;
        let title = rawTitle;
        let overrideData = null;
        if (manualOverrides[rawTrackKey]) {
            artist = manualOverrides[rawTrackKey].artist;
            title = manualOverrides[rawTrackKey].title;
            overrideData = manualOverrides[rawTrackKey];
        }

        const album = track.parentTitle || "";
        const offsetMs = track.viewOffset || 0;
        const durationMs = track.duration || 0;
        const durationSec = durationMs / 1000;
        const thumb = track.thumb || track.parentThumb || track.grandparentThumb || '';

        let genre = track.Genre?.[0]?.tag || track.parentGenre?.[0]?.tag || track.grandparentGenre?.[0]?.tag || "Unknown";
        const trackId = `${artist} - ${title}`;

        const { entry: currentCache, isNew } = primeTrackCache(artist, title, album, durationSec, overrideData);

        let nextTrack = null;
        let upcomingForPrefetch = [];
        if (track.playQueueID) {
            try {
                const pqRes = await axios.get(`${serverUrl}/playQueues/${track.playQueueID}`, {
                    headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
                    httpsAgent: localPlexAgent,
                    timeout: 1500
                });
                const pq = pqRes.data?.MediaContainer?.Metadata;
                if (pq) {
                    const idx = pq.findIndex(i => i.playQueueItemID === track.playQueueItemID);
                    if (idx !== -1 && idx + 1 < pq.length) {
                        nextTrack = { title: pq[idx + 1].title, artist: pq[idx + 1].grandparentTitle || artist };
                        if (isNew) {
                            upcomingForPrefetch = pq.slice(idx + 1, idx + 4).map(i => ({
                                artist: i.grandparentTitle || artist,
                                title: i.title || 'Unknown Title',
                                album: i.parentTitle || '',
                                durationSec: (i.duration || 0) / 1000
                            }));
                        }
                    }
                }
            } catch (e) {}
        }
        if (upcomingForPrefetch.length > 0) primeUpcoming(upcomingForPrefetch);

        const payload = {
            playing: true, playerState, artist, album, title, rawTrackKey, offsetMs, durationMs, genre, thumb, nextTrack,
            syncedLyrics: currentCache?.syncedLyrics || null,
            trivia: currentCache?.trivia || [],
            wikiLinks: currentCache?.wikiLinks || { track: null, artist: null },
            availableSessions, activePlayerId,
            savedSyncOffsetMs: syncOffsets[trackId] || 0
        };
        lastNowPlaying = Object.assign({}, payload, { source: 'plex', fetchedAt: Date.now() });
        res.json(payload);
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

// ---------- JELLYFIN NOW PLAYING (mirrors the Plex endpoint shape) ----------
app.get('/api/jellyfin/now-playing', async (req, res) => {
    const jellyfinUrl = (process.env.JELLYFIN_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.JELLYFIN_API_KEY;
    const { targetClient } = req.query;
    if (!jellyfinUrl || !apiKey) {
        return res.status(400).json({ error: 'Jellyfin not configured (set JELLYFIN_URL and JELLYFIN_API_KEY)' });
    }

    try {
        const sessRes = await axios.get(`${jellyfinUrl}/Sessions`, {
            params: { api_key: apiKey },
            timeout: 5000
        });

        const sessions = (sessRes.data || []).filter(s => s.NowPlayingItem && s.NowPlayingItem.MediaType === 'Audio');
        if (sessions.length === 0) return res.json({ playing: false });

        const availableSessions = sessions.map(s => ({
            id: s.Id,
            name: s.DeviceName || 'Unknown Device',
            user: s.UserName || 'Unknown User'
        }));

        let sess = sessions[0];
        if (targetClient) {
            const requested = sessions.find(s => s.Id === targetClient);
            if (requested) sess = requested;
        }

        const activePlayerId = sess.Id;
        const item = sess.NowPlayingItem;
        const playerState = sess.PlayState?.IsPaused ? 'paused' : 'playing';

        const artist = (item.Artists && item.Artists.length > 0 ? item.Artists.join(', ') : null)
            || item.AlbumArtist || 'Unknown Artist';
        const title = item.Name || 'Unknown Title';
        const album = item.Album || '';
        const rawTrackKey = `${artist} - ${title}`;

        let finalArtist = artist;
        let finalTitle = title;
        let overrideData = null;
        if (manualOverrides[rawTrackKey]) {
            finalArtist = manualOverrides[rawTrackKey].artist;
            finalTitle = manualOverrides[rawTrackKey].title;
            overrideData = manualOverrides[rawTrackKey];
        }

        const offsetMs = Math.round((sess.PlayState?.PositionTicks || 0) / 10000);
        const durationMs = Math.round((item.RunTimeTicks || 0) / 10000);
        const durationSec = durationMs / 1000;
        const thumb = item.Id ? `${jellyfinUrl}/Items/${item.Id}/Images/Primary?fillWidth=400&api_key=${apiKey}` : '';
        const genre = (item.Genres && item.Genres[0]) || 'Unknown';
        const trackId = `${finalArtist} - ${finalTitle}`;

        const { entry: currentCache, isNew } = primeTrackCache(finalArtist, finalTitle, album, durationSec, overrideData);

        // Resolve the upcoming queue for nextTrack + gapless prefetch (only on new tracks).
        let nextTrack = null;
        if (isNew) {
            try {
                const queue = (sess.NowPlayingQueue || []).filter(q => q && q.Id && q.Id !== item.Id);
                const upcomingIds = queue.slice(0, 4).map(q => q.Id);
                if (upcomingIds.length > 0) {
                    const details = await Promise.all(upcomingIds.map(id =>
                        axios.get(`${jellyfinUrl}/Items/${id}`, { params: { api_key: apiKey }, timeout: 2000 })
                            .then(r => r.data).catch(() => null)
                    ));
                    const valid = details.filter(d => d && d.Name);
                    if (valid.length > 0) {
                        const first = valid[0];
                        nextTrack = {
                            title: first.Name,
                            artist: (first.Artists && first.Artists.join(', ')) || first.AlbumArtist || finalArtist
                        };
                        primeUpcoming(valid.slice(0, 3).map(d => ({
                            artist: (d.Artists && d.Artists.join(', ')) || d.AlbumArtist || finalArtist,
                            title: d.Name,
                            album: d.Album || '',
                            durationSec: Math.round((d.RunTimeTicks || 0) / 10000) / 1000
                        })));
                    }
                }
            } catch (e) {}
        } else {
            // Cheap nextTrack guess without extra calls when the track is not new.
            try {
                const queue = (sess.NowPlayingQueue || []).filter(q => q && q.Id && q.Id !== item.Id);
                if (queue.length > 0 && queue[0].Name) {
                    nextTrack = { title: queue[0].Name, artist: finalArtist };
                }
            } catch (e) {}
        }

        const payload = {
            playing: true, playerState, artist: finalArtist, album, title: finalTitle,
            rawTrackKey, offsetMs, durationMs, genre, thumb, nextTrack,
            syncedLyrics: currentCache?.syncedLyrics || null,
            trivia: currentCache?.trivia || [],
            wikiLinks: currentCache?.wikiLinks || { track: null, artist: null },
            availableSessions, activePlayerId,
            savedSyncOffsetMs: syncOffsets[trackId] || 0
        };
        lastNowPlaying = Object.assign({}, payload, { source: 'jellyfin', fetchedAt: Date.now() });
        res.json(payload);
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

// ---------- Image proxy (locked down: allowlist only) ----------
app.get('/api/image', async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).end();

    let parsed;
    try { parsed = new URL(target); }
    catch (e) { return res.status(400).end(); }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(403).end();

    const host = parsed.hostname.toLowerCase();
    const isSpotifyCdn = host === 'i.scdn.co' || host.endsWith('.scdn.co');
    if (!isSpotifyCdn && !knownServerOrigins.has(parsed.origin)) return res.status(403).end();

    try {
        const response = await axios({ url: target, responseType: 'stream', httpsAgent: localPlexAgent, timeout: 10000 });
        if (response.headers['content-type']) res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (e) { res.status(500).end(); }
});

app.listen(PORT, () => console.log(`LyricDeck v2 running on port ${PORT}`));
