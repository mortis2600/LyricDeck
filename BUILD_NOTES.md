# LyricDeck v2 Build Notes

Built overnight 2026-10-09. Base: Dan's pasted code (the newer "LyricDeck" version with Spotify support), not the live Funnel deployment.

## Base version decision

Dan's live site at https://plexlyrics.tailf8ec44.ts.net was fetched and compared. It is the OLDER Plex-only build (title "Plex Synced Lyrics", function names like `initializeApp`/`logoutFromPlex`/`verifyPin`, no Spotify code). The pasted code is the newer in-development version ("LyricDeck" title, Spotify auth, `startApp`/`logoutSession`/`verifyPlexPin`). The live version has no features the pasted code lacks, so v2 is scaffolded from the pasted code. When Dan deploys v2 it will supersede the Funnel deployment.

The Gemini performance patches (WebGL `powerPreference: "high-performance"` with stripped alpha/depth/antialias buffers, and the 150ms deferred ColorThief processing on track change) were verified present in the base and kept.

## What was built

### New pages
- `public/party.html` (`/party`): fullscreen karaoke display. Huge current lyric line, dimmed upcoming line preview, small track header. Polls `/api/party/state` every 2s, syncs locally via requestAnimationFrame. Cursor hidden for TV use.
- `public/remote.html` (`/remote`): phone-friendly remote. Shows now playing, LRCLib search with "Queue" buttons, party queue list with remove/clear, optional name field.
- `public/overlay.html` (`/overlay`): transparent-background overlay for OBS browser sources. Current lyric line plus small track info, nothing else.

### Backend (server.js)
- **Jellyfin source**: `GET /api/jellyfin/now-playing` mirrors the Plex endpoint response shape (artist, title, album, offsetMs, durationMs, thumb, nextTrack, syncedLyrics, trivia, wikiLinks, availableSessions, activePlayerId, savedSyncOffsetMs). Server-side auth via `JELLYFIN_URL` + `JELLYFIN_API_KEY`. Sessions filtered to audio now-playing; queue resolved via `/Items` lookups for next-track and prefetch. "Continue with Jellyfin" button added to the auth screen (no client login needed).
- **Genius annotations**: `fetchGeniusFacts()` tries the Genius API first (song `description_plain` plus up to 5 referent annotations, `text_format=plain`), then Wikipedia fills the rest. Exposed directly via `GET /api/annotations?title=&artist=`. Gracefully returns empty when `GENIUS_ACCESS_TOKEN` is unset.
- **Romaji**: `POST /api/romaji` accepts `{ text }` or `{ texts: [] }` plus optional `trackId` for cache scoping. Returns 503 until kuroshiro finishes init. Frontend toggle button transliterates displayed lines on demand, caches per track, restores originals on toggle-off.
- **Disk persistence**: `data/persist.json` stores `manualOverrides`, `syncOffsets`, and `partyQueue`. Saved on change (debounced), loaded on startup. `/api/override` now persists. New `GET/POST /api/sync-offset` endpoints; frontend sends sync adjustments to the server and falls back to the server value when no localStorage offset exists.
- **Image proxy lockdown**: `/api/image` now allowlists only `i.scdn.co` / `*.scdn.co` and origins of known media servers (Jellyfin URL from env, plus Plex server origins learned from `/api/now-playing` calls). Everything else gets 403. Non-http(s) protocols rejected.
- **Gapless prefetch**: `primeTrackCache()` returns `{ entry, isNew }`; when a track is new, the Plex handler prefetches the next 3 play-queue items and the Jellyfin handler resolves and prefetches the next queue items.
- **Party state**: every now-playing handler (Plex/Jellyfin/Spotify) updates `lastNowPlaying`, served via `GET /api/party/state` (includes the party queue). Party queue endpoints: `GET/POST /api/party/queue`, `POST /api/party/queue/remove`, `POST /api/party/queue/clear`.

### Frontend (index.html)
Transcribed from Dan's pasted code with surgical v2 additions: Jellyfin login button + `loginWithJellyfin()`, Jellyfin branch in `fetchNowPlaying()` (including session selector support and proxied thumbs), romaji toggle button + `toggleRomaji()`/`applyRomaji()`/`restoreOriginalLyrics()` with hooks on both lyric render paths, `savedSyncOffsetMs` fallback on track change, and `persistSyncOffset()` calls in `adjustSync()`/`resetSync()`. All existing Plex/Spotify flows untouched. `parseLRC()` included (called by the base code).

## New env vars
`GENIUS_ACCESS_TOKEN`, `JELLYFIN_URL`, `JELLYFIN_API_KEY` (all documented in `.env.example` and README).

## Verified
`npm install` clean, `node server.js` starts on :3000 with kuroshiro ready. HTTP 200 on `/`, `/party`, `/remote`, `/overlay`. `/api/party/state`, `/api/party/queue` (add/get/remove/clear), `/api/sync-offset`, `/api/override` all round-trip and persist to `data/persist.json`. `/api/image` returns 403 for non-allowlisted hosts. `/api/jellyfin/now-playing` correctly reports unconfigured without env vars. `/api/romaji` converts Japanese to romaji (tested: "konnichiwa sekai"). `/api/annotations` returns empty facts without a Genius token.

## Open items / known limits
- No live Plex/Jellyfin/Spotify available in this environment, so the now-playing handlers were code-reviewed but not live-tested. Dan should smoke-test against his real servers.
- Genius integration untested without a token.
- The `rejectUnauthorized: false` Plex agent from the original code is kept (needed for self-signed local Plex).
- Spotify queue prefetch intentionally left out (Plex-first scope).
- Dan's tarball of his current project files had not arrived when this build finished; if it differs, his files win on conflicts.
