# Resona — Music & Video, beautifully simple

Resona is a self-hosted music and video player with a Spotify-style dark interface.
Search for a song, play it instantly in audio or video mode, build a library, follow
the queue, sing along with synced lyrics, and download audio or video for offline use.

Everything plays through the local Resona server. The browser never receives a
third-party media link, an embed URL, or a "watch on another site" redirect.

## Highlights

- **Instant search** across songs, artists and videos, with live suggestions and recent searches.
- **Audio mode** for lightweight listening, **video mode** for the full music video — switch any time without losing your place.
- **Home feed** with curated shelves, genres and a featured track, plus an Explore page.
- **Seven built-in "Made for you" playlists** — Trending now, Bollywood heat, Lo-fi & chill, Pop pulse, Hip-hop nation, Rock classics and EDM & dance — ready to play on first launch.
- **Free downloads** for audio (M4A) and video (MP4), with a download history.
- **Spotify playlist import** — paste a public Spotify playlist link and Resona builds a playable copy in your library.
- **Liked songs**, **your own playlists** (separate from the built-in curated ones), **queue**, and an autoplay radio that keeps similar tracks coming.
- **Synced lyrics** with highlighted lines and click-to-seek, powered by LRCLIB.
- **Full transport controls**: play/pause, previous/next, seek, volume, mute, shuffle and repeat.
- **Now-playing overlay** with queue, lyrics and track details tabs.
- **Persistent library** in `localStorage` — likes, playlists, recents, downloads and preferences survive a refresh.
- **Keyboard shortcuts** for hands-on control.
- **Responsive layout** for desktop, tablet and mobile.

## Requirements

- Python 3.10 or newer
- `pip` (FastAPI, Uvicorn, HTTPX and yt-dlp are installed from `requirements.txt`)
- An internet connection for search, streaming and lyrics

## Run it

```bash
python -m pip install -r requirements.txt
python main.py
```

Open **http://localhost:3000**. You can also run it directly with Uvicorn:

```bash
uvicorn main:app --host 0.0.0.0 --port 3000
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 5 seconds |
| `↑` / `↓` | Volume up / down |
| `M` | Mute / unmute |
| `L` | Like the current track |
| `V` | Toggle audio / video mode |
| `/` | Focus the search box |
| `Esc` | Close the overlay, drawer, menu or dialog |

## How playback works

1. Search and discovery run on the server with **yt-dlp** (`ytsearch`).
2. When a track starts, the server uses yt-dlp to resolve a playable format, picks the
   best muxed 360p video or highest-quality M4A audio, and caches the signed source URL
   for about 45 minutes.
3. The browser only requests:

   | Endpoint | Purpose |
   | --- | --- |
   | `GET /api/stream?id=…&type=audio\|video` | Range-capable media proxy used by the `<video>` element |
   | `GET /api/download?id=…&type=audio\|video&title=…&artist=…` | Attachment download with a clean filename |
   | `GET /api/thumb?id=…&size=hq\|max` | Proxied artwork |
   | `GET /api/search?q=…` | Track search |
   | `GET /api/suggestions?q=…` | Search autocomplete |
   | `GET /api/trending` | Trending tracks |
   | `GET /api/home` | Home shelves and genres |
   | `GET /api/related?id=…` | Autoplay radio / related tracks |
   | `GET /api/lyrics?title=…&artist=…&duration=…` | Synced or plain lyrics |
   | `GET /api/import/spotify?url=…` | Import a public Spotify playlist |
   | `GET /api/health` | Server health check |

4. Media and artwork are proxied, so the page source, network tab and player all stay on
   `localhost`. Range requests are supported for seeking and resumable downloads.

## Importing a Spotify playlist

1. Make sure the playlist is **public** (anyone with the link can open it).
2. In Resona, click the Spotify icon next to **Your library** in the sidebar.
3. Paste a link such as `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M` and click **Import playlist**.

Resona reads the playlist's public embed page, searches its own catalogue for each song,
and keeps the best match. The result is saved as a normal playlist under **Your playlists**,
so you can play, shuffle, reorder and delete it like any other.

- Only public playlists can be imported. Private and account-only playlists are rejected.
- Spotify's embed page exposes at most 100 tracks (usually 50), so very long playlists are
  imported partially.
- Imported entries are **catalogue matches, not Spotify playback**. Resona does not connect
  to a Spotify account, use the Spotify API, or stream from Spotify. Songs that cannot be
  matched are skipped and reported in the import summary.
- Matching results are cached on the server for 12 hours, so re-importing the same playlist
  is fast.

## Backend

The active backend is **FastAPI** (`main.py`), served by Uvicorn:

- **FastAPI** routes and validation
- **HTTPX** async client for streaming, artwork, lyrics and Spotify imports
- **yt-dlp** for YouTube search and stream resolution
- **In-memory TTL caches** for search, home shelves, related tracks, lyrics, Spotify
  matching and signed media URLs — no database

The original Express implementation is archived in `legacy-node/` for reference and is
not used by the running app.

## Project layout

```
Resona/
├─ main.py            FastAPI app: API, search, media resolver and proxies
├─ requirements.txt   Python dependencies
├─ public/
│  ├─ index.html      App shell and views
│  ├─ style.css       Resona dark theme and responsive layout
│  └─ app.js          State, storage, rendering, playback and UI logic
├─ legacy-node/       Original Express backend (unused)
└─ README.md
```

## Local data

Resona keeps your library on your device:

| Key | Contents |
| --- | --- |
| `resona.liked.v1` | Liked songs |
| `resona.recent.v1` | Recently played tracks |
| `resona.playlists.v1` | Playlists |
| `resona.downloads.v1` | Download history |
| `resona.searches.v1` | Recent searches |
| `resona.prefs.v1` | Volume, mute, autoplay and mode |

Clearing download history only clears the list in Resona; files already saved by the
browser stay on your device.

## Notes

- This is a personal, self-hosted project. Respect the rights of artists and the terms
  that apply where you live.
- Stream URLs are resolved on demand and expire; Resona re-resolves automatically if a
  source is rejected.
- No analytics, accounts or external tracking are used.
