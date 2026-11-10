"""
Resona — FastAPI backend.

All playback and downloads are proxied through this server, so the browser
never needs an embedded third-party player or an external link.

Run with:
    python main.py
or:
    uvicorn main:app --host 0.0.0.0 --port 3000

The original Express implementation is kept in legacy-node/ for reference.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import httpx
import uvicorn
import yt_dlp
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("resona")

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("PORT", "3000"))

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

CACHE_TTL_SEARCH = 10 * 60
CACHE_TTL_HOME = 12 * 60 * 60
CACHE_TTL_RELATED = 25 * 60
CACHE_TTL_LYRICS = 6 * 60 * 60
CACHE_TTL_SPOTIFY = 12 * 60 * 60
CACHE_TTL_SOURCE = 45 * 60

HOME_SHELVES = [
    {
        "id": "trending",
        "title": "Trending now",
        "subtitle": "The tracks everyone has on repeat",
        "query": "top hits 2026 official music video",
        "accent": "#22e07a",
    },
    {
        "id": "bollywood",
        "title": "Bollywood heat",
        "subtitle": "Big screen energy, all day",
        "query": "Bollywood hit songs official video",
        "accent": "#ff4d8d",
    },
    {
        "id": "lofi",
        "title": "Lo-fi & chill",
        "subtitle": "Soft beats for deep focus",
        "query": "lofi chill beats to study",
        "accent": "#8b5cf6",
    },
    {
        "id": "pop",
        "title": "Pop pulse",
        "subtitle": "Bright hooks and huge choruses",
        "query": "pop hits official music video",
        "accent": "#38bdf8",
    },
    {
        "id": "hiphop",
        "title": "Hip-hop nation",
        "subtitle": "Bars, beats and anthems",
        "query": "hip hop rap hits official video",
        "accent": "#f59e0b",
    },
    {
        "id": "rock",
        "title": "Rock classics",
        "subtitle": "Turn it up and sing along",
        "query": "classic rock songs official",
        "accent": "#ef4444",
    },
    {
        "id": "edm",
        "title": "EDM & dance",
        "subtitle": "Festival-sized drops",
        "query": "EDM dance music official video",
        "accent": "#06b6d4",
    },
]

GENRES = [
    {"id": "bollywood", "name": "Bollywood", "query": "Bollywood hit songs official video", "icon": "fa-film", "colors": ["#ff512f", "#dd2476"]},
    {"id": "pop", "name": "Pop", "query": "pop hits official music video", "icon": "fa-wand-magic-sparkles", "colors": ["#38bdf8", "#6366f1"]},
    {"id": "hiphop", "name": "Hip-Hop", "query": "hip hop rap hits official video", "icon": "fa-microphone-lines", "colors": ["#f59e0b", "#ef4444"]},
    {"id": "rock", "name": "Rock", "query": "classic rock songs official", "icon": "fa-guitar", "colors": ["#ef4444", "#7c3aed"]},
    {"id": "edm", "name": "EDM / Dance", "query": "EDM dance music official video", "icon": "fa-bolt", "colors": ["#06b6d4", "#8b5cf6"]},
    {"id": "lofi", "name": "Lo-Fi", "query": "lofi chill beats to study", "icon": "fa-mug-hot", "colors": ["#14b8a6", "#0f766e"]},
    {"id": "acoustic", "name": "Acoustic", "query": "acoustic songs official video", "icon": "fa-leaf", "colors": ["#84cc16", "#15803d"]},
    {"id": "rnb", "name": "R&B / Soul", "query": "rnb soul songs official", "icon": "fa-heart", "colors": ["#ec4899", "#8b5cf6"]},
    {"id": "punjabi", "name": "Punjabi", "query": "punjabi songs official video", "icon": "fa-drum", "colors": ["#f97316", "#eab308"]},
    {"id": "kpop", "name": "K-Pop", "query": "kpop songs official video", "icon": "fa-star", "colors": ["#a855f7", "#ec4899"]},
    {"id": "romance", "name": "Romance", "query": "romantic songs official video", "icon": "fa-heart-circle-bolt", "colors": ["#fb7185", "#e11d48"]},
    {"id": "workout", "name": "Workout", "query": "workout motivation music official", "icon": "fa-dumbbell", "colors": ["#22c55e", "#0ea5e9"]},
    {"id": "sad", "name": "Sad songs", "query": "sad songs official video", "icon": "fa-cloud-rain", "colors": ["#64748b", "#334155"]},
    {"id": "indie", "name": "Indie", "query": "indie music official video", "icon": "fa-compact-disc", "colors": ["#f472b6", "#7c3aed"]},
]

SEARCH_STOP_WORDS = {
    "the", "and", "with", "feat", "ft", "from", "official", "video",
    "music", "audio", "song", "lyrics", "version", "remix",
}

TRACK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
SPOTIFY_URI_RE = re.compile(r"^spotify:playlist:([A-Za-z0-9]{22})$", re.I)
SPOTIFY_LINK_RE = re.compile(
    r"open\.spotify\.com/(?:(?:intl-[a-z-]+|[a-z]{2}(?:-[a-z]{2})?)/)?playlist/([A-Za-z0-9]{22})",
    re.I,
)
SPOTIFY_PLAIN_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
NEXT_DATA_RE = re.compile(
    r'<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>', re.I
)
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$", re.I)


# ---------------------------------------------------------------------------
# In-memory TTL cache
# ---------------------------------------------------------------------------

_CACHE: dict[str, tuple[float, Any]] = {}
_INFLIGHT: dict[str, asyncio.Task] = {}
_SOURCE_CACHE: dict[str, dict] = {}
_SOURCE_INFLIGHT: dict[str, asyncio.Task] = {}


async def memoize(key: str, ttl: float, fn):
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        return hit[1]

    task = _INFLIGHT.get(key)
    if task is None:
        async def runner():
            try:
                value = await fn()
                _CACHE[key] = (time.time() + ttl, value)
                return value
            finally:
                _INFLIGHT.pop(key, None)

        task = asyncio.create_task(runner())
        _INFLIGHT[key] = task

    return await asyncio.shield(task)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def clamp_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def format_duration(total_seconds: Any) -> str:
    try:
        total = int(total_seconds or 0)
    except (TypeError, ValueError):
        total = 0
    if total < 0:
        total = 0
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def compact_number(value: Any) -> str:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return ""
    for unit, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if number >= unit:
            scaled = number / unit
            text = f"{scaled:.1f}".rstrip("0").rstrip(".")
            return f"{text}{suffix}"
    return str(int(number))


def thumb_url(video_id: str, size: str = "hq") -> str:
    return f"/api/thumb?id={quote(video_id)}&size={size}"


def clean_track_title(title: Any = "") -> str:
    value = str(title or "")
    value = re.sub(
        r"\((?:official|lyrics?|audio|video|music|hd|4k|remaster(?:ed)?|visualizer)[^)]*\)",
        " ", value, flags=re.I,
    )
    value = re.sub(
        r"\[(?:official|lyrics?|audio|video|music|hd|4k|remaster(?:ed)?|visualizer)[^\]]*\]",
        " ", value, flags=re.I,
    )
    value = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", value)
    value = re.sub(
        r"\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|"
        r"full\s*video|video\s*song|audio\s*song|hd|4k|8k|remaster(?:ed)?|visuali[sz]er)\b",
        " ", value, flags=re.I,
    )
    value = re.sub(r"\s*[-–—|]\s*$", "", value)
    return re.sub(r"\s+", " ", value).strip()


def clean_artist_name(artist: Any = "") -> str:
    value = str(artist or "")
    value = re.sub(r"\s*-\s*Topic$", "", value, flags=re.I)
    value = re.sub(r"\s*(VEVO|Official)$", "", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip()


def sanitize_filename(name: Any) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(name or ""))
    value = re.sub(r"\s+", " ", value).strip()[:120]
    return value or "track"


def dedupe_tracks(tracks: list, exclude_id: str | None = None) -> list:
    seen: set[str] = set()
    out = []
    for track in tracks:
        if not track or not track.get("id"):
            continue
        track_id = str(track["id"])
        if exclude_id and track_id == str(exclude_id):
            continue
        if track_id in seen:
            continue
        seen.add(track_id)
        out.append(track)
    return out


def is_likely_track(track: dict) -> bool:
    seconds = int(track.get("seconds") or 0)
    return seconds == 0 or 30 <= seconds <= 1500


def map_search_video(video: dict) -> dict | None:
    video_id = video.get("id") or video.get("videoId")
    if not video_id:
        return None
    views = video.get("view_count") or video.get("views") or 0
    artist = video.get("channel") or video.get("uploader") or "Unknown artist"
    seconds = video.get("duration") or video.get("seconds") or 0
    title = video.get("title") or "Unknown title"
    return {
        "id": str(video_id),
        "title": title,
        "artist": str(artist),
        "duration": format_duration(seconds),
        "seconds": int(seconds or 0),
        "thumbnail": thumb_url(str(video_id)),
        "views": int(views or 0),
        "viewsLabel": compact_number(views),
        "ago": "",
        "video": True,
    }


def map_summary(video: dict) -> dict | None:
    if not video or not video.get("id"):
        return None
    views = video.get("view_count") or 0
    seconds = video.get("duration") or 0
    return {
        "id": str(video["id"]),
        "title": video.get("title") or "Unknown title",
        "artist": video.get("channel") or video.get("uploader") or "Unknown artist",
        "duration": format_duration(seconds),
        "seconds": int(seconds or 0),
        "thumbnail": thumb_url(str(video["id"])),
        "views": int(views or 0),
        "viewsLabel": compact_number(views),
        "ago": "",
        "video": True,
    }


class _QuietLogger:
    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        logger.debug("yt-dlp: %s", msg)


def _base_ydl_opts() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "logger": _QuietLogger(),
    }


# ---------------------------------------------------------------------------
# YouTube search
# ---------------------------------------------------------------------------

def _search_sync(query: str, limit: int) -> list[dict]:
    fetch_limit = min(max(limit * 2, limit + 6), 50)
    attempts = [
        {},
        {"extractor_args": {"youtube": {"player_client": ["android"]}}},
        {"extractor_args": {"youtube": {"player_client": ["web"]}}},
    ]
    last_error: Exception | None = None

    for attempt in attempts:
        opts = {
            **_base_ydl_opts(),
            "extract_flat": "in_playlist",
            "playlistend": fetch_limit,
            **attempt,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                data = ydl.extract_info(f"ytsearch{fetch_limit}:{query}", download=False)
            entries = [
                entry for entry in (data.get("entries") or [])
                if entry and entry.get("id") and len(str(entry.get("id"))) >= 6
            ]
            mapped = [track for track in (map_search_video(entry) for entry in entries) if track]
            tracks = [track for track in mapped if is_likely_track(track)]
            selected = tracks if len(tracks) >= min(6, limit) else mapped
            return selected[:limit]
        except Exception as exc:  # noqa: BLE001 - try the next client
            last_error = exc
            logger.warning("Search attempt failed (%s): %s", attempt or "default", exc)

    if last_error:
        logger.warning("Search failed for %r: %s", query, last_error)
    return []


async def search_catalog(query: str, limit: int = 20) -> list[dict]:
    key = f"search:{query}:{limit}"
    return await memoize(
        key, CACHE_TTL_SEARCH,
        lambda: asyncio.to_thread(_search_sync, query, limit),
    )


# ---------------------------------------------------------------------------
# Spotify import
# ---------------------------------------------------------------------------

def extract_spotify_playlist_id(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    match = SPOTIFY_URI_RE.match(text)
    if match:
        return match.group(1)
    match = SPOTIFY_LINK_RE.search(text)
    if match:
        return match.group(1)
    if SPOTIFY_PLAIN_ID_RE.match(text):
        return text
    return None


def words_for_match(value: Any) -> set[str]:
    lowered = re.sub(r"[^a-z0-9\s]", " ", str(value or "").lower())
    return {
        word for word in lowered.split()
        if len(word) > 1 and word not in SEARCH_STOP_WORDS
    }


def score_import_candidate(entry: dict, track: dict) -> float:
    wanted_title = words_for_match(entry.get("title"))
    wanted_artist = words_for_match(entry.get("subtitle"))
    got_title = words_for_match(track.get("title"))
    got_artist = words_for_match(track.get("artist"))

    score = 0.0
    score += 3 * len(wanted_title & got_title)
    score += 2 * len(wanted_artist & got_artist)

    wanted_seconds = float(entry.get("duration") or 0) / 1000
    got_seconds = float(track.get("seconds") or 0)
    if wanted_seconds > 0 and got_seconds > 0:
        score -= min(4.0, abs(wanted_seconds - got_seconds) / 30)
    return score


async def fetch_spotify_playlist(playlist_id: str) -> dict:
    response = await http.get(
        f"https://open.spotify.com/embed/playlist/{playlist_id}",
        headers={
            "User-Agent": DEFAULT_UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html",
        },
        timeout=20.0,
    )
    if response.status_code == 404:
        raise ValueError("That Spotify playlist could not be found. Make sure it is public.")
    if response.status_code >= 400:
        raise ValueError("Spotify did not return this playlist. Try again in a moment.")

    match = NEXT_DATA_RE.search(response.text)
    if not match:
        raise ValueError("Could not read this Spotify playlist.")

    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ValueError("Could not read this Spotify playlist.") from exc

    entity = (
        data.get("props", {})
        .get("pageProps", {})
        .get("state", {})
        .get("data", {})
        .get("entity")
    )
    if not entity or not isinstance(entity.get("trackList"), list):
        raise ValueError("This Spotify playlist is empty or private.")

    entries = [
        item for item in entity["trackList"]
        if item and item.get("entityType") == "track" and item.get("title")
    ][:100]

    return {
        "name": str(entity.get("name") or entity.get("title") or "Imported Spotify playlist")[:80],
        "owner": str(entity.get("subtitle") or "Spotify")[:80],
        "entries": entries,
    }


async def match_spotify_entry(entry: dict) -> dict | None:
    uri = str(entry.get("uri") or entry.get("title"))

    async def run():
        query = " ".join(
            part for part in (entry.get("title"), entry.get("subtitle")) if part
        )
        candidates = await search_catalog(query, 6)
        if not candidates:
            return None
        return max(candidates, key=lambda track: score_import_candidate(entry, track))

    return await memoize(f"spotify-import:{uri}", CACHE_TTL_SPOTIFY, run)


async def match_spotify_entries(entries: list[dict]) -> list[dict | None]:
    semaphore = asyncio.Semaphore(8)
    results: list[dict | None] = [None] * len(entries)

    async def worker(index: int, entry: dict):
        async with semaphore:
            try:
                results[index] = await match_spotify_entry(entry)
            except Exception as exc:  # noqa: BLE001 - keep importing the rest
                logger.warning("Spotify match failed for %r: %s", entry.get("title"), exc)

    await asyncio.gather(*(worker(i, entry) for i, entry in enumerate(entries)))
    return results


# ---------------------------------------------------------------------------
# Media source resolution
# ---------------------------------------------------------------------------

def _content_type(ext: str, kind: str) -> str:
    ext = (ext or "").lower()
    if ext == "m4a":
        return "audio/mp4"
    if ext == "webm":
        return "audio/webm" if kind == "audio" else "video/webm"
    if ext == "3gp":
        return "video/3gp"
    if ext == "mp4":
        return "video/mp4"
    return "audio/mp4" if kind == "audio" else "video/mp4"


def _extract_source_sync(video_id: str, kind: str) -> dict:
    if kind == "video":
        attempts = [
            (["android"], "18/best[height<=360][vcodec!=none][acodec!=none]/best[acodec!=none][vcodec!=none]"),
            ([], "18/best[height<=360][vcodec!=none][acodec!=none]/best[acodec!=none][vcodec!=none]"),
            (["ios"], "18/best[height<=360][vcodec!=none][acodec!=none]/best[acodec!=none][vcodec!=none]"),
        ]
    else:
        attempts = [
            ([], "bestaudio[ext=m4a]/bestaudio/best"),
            (["android"], "bestaudio[ext=m4a]/bestaudio/best"),
        ]

    last_error: Exception | None = None
    for clients, fmt in attempts:
        opts = {
            **_base_ydl_opts(),
            "format": fmt,
            "socket_timeout": 30,
        }
        if clients:
            opts["extractor_args"] = {"youtube": {"player_client": clients}}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}", download=False
                )
            direct = info.get("url")
            if not direct:
                raise ValueError("No direct media URL was resolved.")

            raw_headers = info.get("http_headers") or {}
            headers = {
                "User-Agent": raw_headers.get("User-Agent") or DEFAULT_UA,
                "Accept": "*/*",
                "Accept-Encoding": "identity",
            }
            ext = info.get("ext") or ("mp4" if kind == "video" else "m4a")
            total = info.get("filesize") or info.get("filesize_approx")
            expire = 0
            try:
                expire = int(parse_qs(urlparse(direct).query).get("expire", ["0"])[0])
            except (TypeError, ValueError):
                expire = 0

            max_age = CACHE_TTL_SOURCE
            expires_at = time.time() + max_age
            if expire:
                expires_at = min(expire - 60, expires_at)

            return {
                "url": direct,
                "headers": headers,
                "total": int(total) if total else None,
                "content_type": _content_type(ext, kind),
                "expires_at": expires_at,
            }
        except Exception as exc:  # noqa: BLE001 - try the next client/format
            last_error = exc
            logger.warning("Resolve attempt failed (%s %s): %s", kind, clients or "default", exc)

    raise RuntimeError(f"Could not prepare this track for playback: {last_error}")


async def _resolve_and_cache(video_id: str, kind: str) -> dict:
    key = f"{kind}:{video_id}"
    source = await asyncio.to_thread(_extract_source_sync, video_id, kind)

    # Ask for one byte to learn the exact total size and response content type.
    try:
        head = await http.get(
            source["url"],
            headers={**source["headers"], "Range": "bytes=0-0"},
            timeout=15.0,
        )
        if head.status_code in (200, 206):
            content_range = head.headers.get("content-range")
            if content_range and "/" in content_range:
                try:
                    size = int(content_range.rsplit("/", 1)[-1])
                    if size > 0:
                        source["total"] = size
                except (TypeError, ValueError):
                    pass
            content_type = head.headers.get("content-type")
            if content_type:
                source["content_type"] = content_type
        await head.aclose()
    except Exception:  # noqa: BLE001 - streaming can still work without a total
        pass

    _SOURCE_CACHE[key] = source
    return source


async def get_source(video_id: str, kind: str) -> dict:
    key = f"{kind}:{video_id}"
    cached = _SOURCE_CACHE.get(key)
    if cached and cached["expires_at"] > time.time():
        return cached

    task = _SOURCE_INFLIGHT.get(key)
    if task is None:
        task = asyncio.create_task(_resolve_and_cache(video_id, kind))
        _SOURCE_INFLIGHT[key] = task
        task.add_done_callback(lambda _task, k=key: _SOURCE_INFLIGHT.pop(k, None))
    return await asyncio.shield(task)


def parse_range_header(header: str | None, total: int | None):
    if not header or not total:
        return None
    match = RANGE_RE.match(str(header).strip())
    if not match:
        return "invalid"

    start_text, end_text = match.groups()
    start = None if start_text == "" else int(start_text)
    end = None if end_text == "" else int(end_text)

    if start is None and end is None:
        return "invalid"

    if start is None:
        suffix = end
        if not suffix or suffix <= 0:
            return "invalid"
        start = max(0, total - suffix)
        end = total - 1
    else:
        if start < 0 or start >= total:
            return "invalid"
        if end is None or end >= total:
            end = total - 1
        if end < start:
            return "invalid"

    return {"start": start, "end": end}


def _disposition(filename: str) -> str:
    ascii_name = re.sub(r"[^\x20-\x7e]", "_", filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


async def send_media(request: Request, video_id: str, kind: str, attachment_name: str | None = None):
    source = await get_source(video_id, kind)
    parsed_range = parse_range_header(request.headers.get("range"), source.get("total"))

    if parsed_range == "invalid":
        headers = {}
        if source.get("total"):
            headers["Content-Range"] = f"bytes */{source['total']}"
        return Response(status_code=416, headers=headers)

    range_value = None
    if parsed_range:
        range_value = f"bytes={parsed_range['start']}-{parsed_range['end']}"

    async def request_source(src: dict) -> httpx.Response:
        headers = dict(src["headers"])
        if range_value:
            headers["Range"] = range_value
        media_request = http.build_request(
            "GET",
            src["url"],
            headers=headers,
            timeout=httpx.Timeout(connect=15.0, read=60.0, write=30.0, pool=15.0),
        )
        return await http.send(media_request, stream=True)

    upstream = await request_source(source)

    if upstream.status_code in (403, 410):
        await upstream.aclose()
        _SOURCE_CACHE.pop(f"{kind}:{video_id}", None)
        source = await get_source(video_id, kind)
        upstream = await request_source(source)

    if upstream.status_code not in (200, 206):
        status = upstream.status_code
        await upstream.aclose()
        return JSONResponse(
            {"error": f"Media server responded with {status}"},
            status_code=502,
        )

    is_partial = bool(parsed_range) and upstream.status_code == 206
    headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Content-Type": source["content_type"],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if attachment_name:
        headers["Content-Disposition"] = _disposition(attachment_name)

    if is_partial and parsed_range:
        headers["Content-Range"] = upstream.headers.get(
            "content-range",
            f"bytes {parsed_range['start']}-{parsed_range['end']}/{source['total']}",
        )
        headers["Content-Length"] = str(parsed_range["end"] - parsed_range["start"] + 1)
    else:
        content_length = upstream.headers.get("content-length")
        if content_length:
            headers["Content-Length"] = content_length
        elif source.get("total"):
            headers["Content-Length"] = str(source["total"])

    upstream_type = upstream.headers.get("content-type")
    if upstream_type:
        headers["Content-Type"] = upstream_type

    if request.method == "HEAD":
        await upstream.aclose()
        return Response(status_code=206 if is_partial else 200, headers=headers)

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        body(),
        status_code=206 if is_partial else 200,
        headers=headers,
    )


# ---------------------------------------------------------------------------
# HTTP client lifecycle
# ---------------------------------------------------------------------------

http: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http
    http = httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(connect=15.0, read=60.0, write=30.0, pool=15.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=25),
    )
    logger.info("♪  Resona is running")
    logger.info("   http://localhost:%s", PORT)
    try:
        yield
    finally:
        await http.aclose()
        for task in list(_INFLIGHT.values()) + list(_SOURCE_INFLIGHT.values()):
            task.cancel()


app = FastAPI(title="Resona", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def api_error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "app": "Resona",
        "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/api/search")
async def api_search(q: str = "", limit: str = "28"):
    query = q.strip()
    if not query:
        return api_error(400, "Search query is required")
    try:
        results = await search_catalog(query, clamp_int(limit, 1, 40, 28))
        return {"query": query, "results": results}
    except Exception:
        logger.exception("Search error")
        return api_error(500, "Could not load search results right now.")


@app.get("/api/suggestions")
async def api_suggestions(q: str = ""):
    query = q.strip()
    if len(query) < 2:
        return {"suggestions": []}

    async def run():
        try:
            response = await http.get(
                "https://suggestqueries.google.com/complete/search",
                params={"client": "firefox", "ds": "yt", "q": query},
                headers={"User-Agent": DEFAULT_UA},
                timeout=10.0,
            )
            if response.status_code >= 400:
                return []
            payload = response.json()
            if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], list):
                return [str(item) for item in payload[1][:8]]
        except Exception:  # noqa: BLE001 - suggestions are optional
            pass
        return []

    try:
        return {"suggestions": await memoize(f"suggestions:{query}", CACHE_TTL_SEARCH, run)}
    except Exception:
        return {"suggestions": []}


@app.get("/api/trending")
async def api_trending(category: str = "top hits 2026", limit: str = "20"):
    label = category.strip() or "top hits 2026"
    try:
        results = await search_catalog(label, clamp_int(limit, 1, 40, 20))
        return {"category": label, "results": results}
    except Exception:
        logger.exception("Trending error")
        return api_error(500, "Could not load trending tracks.")


@app.get("/api/home")
async def api_home():
    async def build():
        async def shelf_with_tracks(shelf: dict):
            tracks = await search_catalog(shelf["query"], 14)
            return {**shelf, "tracks": tracks}

        results = await asyncio.gather(
            *(shelf_with_tracks(shelf) for shelf in HOME_SHELVES),
            return_exceptions=True,
        )
        shelves = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning("Home shelf failed: %s", result)
                continue
            if result["tracks"]:
                shelves.append(result)
        return shelves

    try:
        shelves = await memoize("home:shelves", CACHE_TTL_HOME, build)
        return {"shelves": shelves, "genres": GENRES}
    except Exception:
        logger.exception("Home error")
        return api_error(500, "Could not load the home feed.")


@app.get("/api/related")
async def api_related(
    id: str = "",
    title: str = "",
    artist: str = "",
    limit: str = "20",
):
    video_id = id.strip()
    track_title = title.strip()
    track_artist = artist.strip()
    max_results = clamp_int(limit, 1, 40, 20)

    if not video_id and not track_title:
        return api_error(400, "A track id or title is required")

    async def build():
        tracks: list[dict] = []

        if video_id:
            try:
                mix_url = (
                    f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
                )
                data = await asyncio.to_thread(_related_mix_sync, mix_url, max_results + 4)
                tracks = [track for track in (map_summary(item) for item in data) if track]
            except Exception as exc:  # noqa: BLE001 - fall back to search
                logger.warning("Related radio lookup failed: %s", exc)

        if len(tracks) < 8:
            query = " ".join(
                part for part in (
                    clean_artist_name(track_artist),
                    clean_track_title(track_title),
                    "similar songs",
                ) if part
            ).strip()
            try:
                fallback = await search_catalog(query or "popular songs", max_results + 8)
                tracks.extend(fallback)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Related fallback failed: %s", exc)

        return dedupe_tracks(tracks, video_id or None)[:max_results]

    try:
        cache_key = f"related:{video_id}:{track_title}:{track_artist}:{max_results}"
        return {"playlist": await memoize(cache_key, CACHE_TTL_RELATED, build)}
    except Exception:
        logger.exception("Related error")
        return api_error(500, "Could not load related tracks.")


def _related_mix_sync(url: str, limit: int) -> list[dict]:
    opts = {
        **_base_ydl_opts(),
        "extract_flat": "in_playlist",
        "playlistend": limit,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        data = ydl.extract_info(url, download=False)
    return data.get("entries") or []


@app.get("/api/thumb")
async def api_thumb(id: str = "", size: str = "hq"):
    video_id = re.sub(r"[^a-zA-Z0-9_-]", "", id)
    if not video_id:
        return Response(status_code=400)

    names = (
        ["maxresdefault", "sddefault", "hqdefault"]
        if size == "max"
        else ["hqdefault"]
    )
    for name in names:
        try:
            response = await http.get(
                f"https://i.ytimg.com/vi/{video_id}/{name}.jpg",
                headers={"User-Agent": DEFAULT_UA},
                timeout=10.0,
            )
            if response.status_code == 200:
                return Response(
                    content=response.content,
                    media_type=response.headers.get("content-type") or "image/jpeg",
                    headers={"Cache-Control": "public, max-age=21600, immutable"},
                )
            await response.aclose()
        except Exception:  # noqa: BLE001 - try the next size
            continue
    return Response(status_code=404)


@app.api_route("/api/stream", methods=["GET", "HEAD"])
async def api_stream(
    request: Request,
    id: str = "",
    kind: str = Query("audio", alias="type"),
):
    video_id = id.strip()
    media_kind = "video" if kind == "video" else "audio"
    if not TRACK_ID_RE.match(video_id):
        return api_error(400, "A valid track id is required.")
    try:
        return await send_media(request, video_id, media_kind)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Stream error")
        return api_error(500, str(exc) or "Could not start playback.")


@app.api_route("/api/download", methods=["GET", "HEAD"])
async def api_download(
    request: Request,
    id: str = "",
    kind: str = Query("audio", alias="type"),
    title: str = "track",
    artist: str = "",
):
    video_id = id.strip()
    media_kind = "video" if kind == "video" else "audio"
    if not TRACK_ID_RE.match(video_id):
        return api_error(400, "A valid track id is required.")

    filename = sanitize_filename(
        f"{artist} - {title}" if artist else title
    ) + (".mp4" if media_kind == "video" else ".m4a")

    try:
        return await send_media(request, video_id, media_kind, filename)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Download error")
        return api_error(500, str(exc) or "Could not start the download.")


@app.get("/api/lyrics")
async def api_lyrics(title: str = "", artist: str = "", duration: str = "0"):
    track_title = title.strip()
    track_artist = artist.strip()
    seconds = clamp_int(duration, 0, 24 * 60 * 60, 0)
    if not track_title:
        return api_error(400, "A track title is required.")

    async def fetch() -> dict | None:
        clean_title = clean_track_title(track_title) or track_title
        clean_artist = clean_artist_name(track_artist)
        attempts = [
            {"track_name": clean_title, "artist_name": clean_artist},
            {"q": f"{clean_title} {clean_artist}".strip()},
            {"q": clean_title},
        ]

        for params in attempts:
            try:
                response = await http.get(
                    "https://lrclib.net/api/search",
                    params=params,
                    headers={"User-Agent": "Resona/1.0 (local music app)"},
                    timeout=10.0,
                )
                if response.status_code >= 400:
                    continue
                items = response.json()
                if not isinstance(items, list) or not items:
                    continue

                def rank(item: dict) -> int:
                    return (2 if item.get("syncedLyrics") else 0) + (-1 if item.get("instrumental") else 0)

                ranked = [
                    item for item in items
                    if item and (item.get("syncedLyrics") or item.get("plainLyrics"))
                ]
                if not ranked:
                    continue
                if seconds:
                    ranked.sort(
                        key=lambda item: (
                            -rank(item),
                            abs(int(item.get("duration") or 0) - seconds),
                        )
                    )
                else:
                    ranked.sort(key=rank, reverse=True)

                best = ranked[0]
                return {
                    "trackName": best.get("trackName") or clean_title,
                    "artistName": best.get("artistName") or clean_artist,
                    "albumName": best.get("albumName") or "",
                    "duration": best.get("duration") or 0,
                    "synced": best.get("syncedLyrics") or "",
                    "plain": best.get("plainLyrics") or "",
                    "instrumental": bool(best.get("instrumental")),
                }
            except Exception:  # noqa: BLE001 - try the next query
                continue
        return None

    try:
        cache_key = f"lyrics:{track_title}:{track_artist}:{seconds}"
        result = await memoize(cache_key, CACHE_TTL_LYRICS, fetch)
        if not result:
            return api_error(404, "No lyrics found for this track.")
        return result
    except Exception:
        logger.exception("Lyrics error")
        return api_error(500, "Could not load lyrics.")


@app.get("/api/import/spotify")
async def api_import_spotify(url: str = "", id: str = ""):
    playlist_id = extract_spotify_playlist_id(url or id)
    if not playlist_id:
        return api_error(
            400,
            "Paste a public Spotify playlist link, for example https://open.spotify.com/playlist/…",
        )

    try:
        playlist = await fetch_spotify_playlist(playlist_id)
        if not playlist["entries"]:
            return api_error(422, "This Spotify playlist has no songs to import.")

        matched = await match_spotify_entries(playlist["entries"])
        matched_tracks = [track for track in matched if track]
        tracks = dedupe_tracks(matched_tracks)

        if not tracks:
            return api_error(
                422,
                "None of the songs in this playlist could be matched. Try another public playlist.",
            )

        return {
            "id": playlist_id,
            "name": playlist["name"],
            "owner": playlist["owner"],
            "total": len(playlist["entries"]),
            "matched": len(tracks),
            "unmatched": max(0, len(playlist["entries"]) - len(matched_tracks)),
            "tracks": tracks,
        }
    except ValueError as exc:
        return api_error(502, str(exc))
    except Exception:
        logger.exception("Spotify import error")
        return api_error(502, "Could not import this Spotify playlist. Try again.")


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def api_not_found(rest: str):
    return api_error(404, "Not found")


# Serve the frontend after API routes so /api/* never falls through to the shell.
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
