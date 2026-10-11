# LyricDeck

A synced-lyrics display for your music. Connect Plex, Jellyfin, or Spotify and get a beautiful full-screen lyrics view with karaoke-style highlighting, pop-up trivia, and audio-reactive visualizers.

## Features

- **Three playback sources**: Plex, Jellyfin, and Spotify (Plex is the primary focus)
- **Synced lyrics** from LRCLib, with manual search and override when the wrong lyrics load
- **Karaoke party mode** (`/party`): a big-screen display with a huge current line and upcoming line preview, plus a phone remote (`/remote`) where guests can search and queue songs
- **OBS overlay** (`/overlay`): a transparent now-playing and lyrics overlay for streamers
- **Romaji toggle**: transliterates Japanese lyrics to romaji on demand (kuroshiro)
- **Pop-up trivia**: Genius song annotations when available, Wikipedia facts as fallback
- **WebGL visualizers** with album-art color theming
- **Gapless prefetch**: lyrics for the next tracks are fetched before the song changes
- **Persistent corrections**: lyric overrides and sync offsets survive restarts

## Quick start

```bash
npm install
cp .env.example .env   # then fill in what you use
node server.js
```

Open http://localhost:3000 and pick your playback provider.

## Routes

| Route     | What it is                                          |
|-----------|-----------------------------------------------------|
| `/`       | Main lyrics display                                 |
| `/party`  | Fullscreen karaoke display for the TV                |
| `/remote` | Phone-friendly remote: now playing, search, queue    |
| `/overlay`| Transparent lyrics overlay for OBS browser sources   |

## Environment variables

| Variable               | Required | What it does                                              |
|------------------------|----------|-----------------------------------------------------------|
| `PORT`                 | No       | Port to listen on (default 3000)                          |
| `SPOTIFY_CLIENT_ID`    | For Spotify | Spotify app client ID                                  |
| `SPOTIFY_CLIENT_SECRET`| For Spotify | Spotify app client secret                              |
| `GENIUS_ACCESS_TOKEN`  | No       | Genius API token for song annotations (get one at genius.com/api-clients) |
| `JELLYFIN_URL`         | For Jellyfin | Base URL of your Jellyfin server, e.g. http://192.168.1.10:8096 |
| `JELLYFIN_API_KEY`     | For Jellyfin | Jellyfin API key (Dashboard > API Keys)                |

Jellyfin auth is server-side, so the "Continue with Jellyfin" button just works once the env vars are set. Plex uses per-user PIN login as before.

User corrections (lyric overrides, sync offsets, party queue) are stored in `data/persist.json`.

## Donate

LyricDeck is free and open source. If it makes your listening better, you can support its development here:

- [Your donation link here]

## Acknowledgments

LyricDeck stands on the shoulders of open source. Thanks to:

- [Express](https://expressjs.com/) (MIT) — web server
- [Axios](https://axios-http.com/) (MIT) — HTTP client
- [dotenv](https://github.com/motdotla/dotenv) (BSD-2-Clause) — environment config
- [Kuroshiro](https://github.com/hexenq/kuroshiro) (MIT) and [kuroshiro-analyzer-kuromoji](https://github.com/hexenq/kuroshiro-analyzer-kuromoji) (MIT) — Japanese romaji conversion
- [Color Thief](https://lokeshdhakar.com/projects/color-thief/) (MIT) — album-art color extraction
- [LRCLib](https://lrclib.net/) — synced lyrics API
- [Genius](https://genius.com/) — song annotations API

The built-in "MilkDrop" visualizer preset is an original shader written for LyricDeck, named in homage to Ryan Geiss's classic MilkDrop visualizer — it contains no MilkDrop code.

## License

MIT. See [LICENSE](LICENSE).
