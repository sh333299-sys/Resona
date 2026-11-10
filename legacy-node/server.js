/**
 * Resona — a self-contained music & video streaming app.
 *
 * All playback and downloads are proxied through this server, so the browser
 * never needs an embedded third-party player or an external link.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Readable } = require('stream');
const yts = require('yt-search');
const { Ytdl, chooseFormat, Quality } = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TV_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';

const ytdl = new Ytdl();

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true, maxAge: 0 }));

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const cache = new Map();
const inflight = new Map();

async function memoize(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const task = Promise.resolve()
    .then(fn)
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

// Keep the cache from growing without bound in long-running sessions.
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache) {
    if (item.expires <= now && cache.size > 500) cache.delete(key);
  }
}, 10 * 60 * 1000).unref();

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

function thumbUrl(id, size = 'hq') {
  return `/api/thumb?id=${encodeURIComponent(id)}&size=${size}`;
}

function cleanTrackTitle(title = '') {
  return String(title)
    .replace(/\((?:official|lyrics?|audio|video|music|hd|4k|remaster(?:ed)?|visualizer)[^)]*\)/gi, ' ')
    .replace(/\[(?:official|lyrics?|audio|video|music|hd|4k|remaster(?:ed)?|visualizer)[^\]]*\]/gi, ' ')
    .replace(/[\(\[\{].*?[\)\]\}]/g, ' ')
    .replace(
      /\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|full\s*video|video\s*song|audio\s*song|hd|4k|8k|remaster(?:ed)?|visuali[sz]er)\b/gi,
      ' '
    )
    .replace(/\s*[-–—|]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistName(artist = '') {
  return String(artist)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*(VEVO|Official)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapSearchVideo(video) {
  const id = video.videoId || video.id;
  if (!id) return null;
  const views = Number(video.views) || 0;
  return {
    id,
    title: video.title || 'Unknown title',
    artist: (video.author && video.author.name) || video.author || 'Unknown artist',
    duration: video.timestamp || formatDuration(video.seconds),
    seconds: Number(video.seconds) || 0,
    thumbnail: thumbUrl(id),
    views,
    viewsLabel: compactNumber(views),
    ago: video.ago || '',
    video: true,
  };
}

function pickLargestThumb(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  return thumbnails[thumbnails.length - 1].url;
}

function mapSummary(video) {
  if (!video || !video.id) return null;
  const views = Number(video.viewCount) || 0;
  return {
    id: video.id,
    title: video.title || 'Unknown title',
    artist: (video.author && video.author.name) || 'Unknown artist',
    duration: formatDuration(video.lengthSeconds),
    seconds: Number(video.lengthSeconds) || 0,
    thumbnail: thumbUrl(video.id),
    views,
    viewsLabel: compactNumber(views),
    ago: '',
    video: true,
  };
}

function dedupeTracks(tracks, excludeId) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    if (!track || !track.id) continue;
    if (track.id === excludeId) continue;
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

function sanitizeFilename(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'track'
  );
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

const HOME_SHELVES = [
  {
    id: 'trending',
    title: 'Trending now',
    subtitle: 'The tracks everyone has on repeat',
    query: 'top hits 2026 official music video',
    accent: '#22e07a',
  },
  {
    id: 'bollywood',
    title: 'Bollywood heat',
    subtitle: 'Big screen energy, all day',
    query: 'Bollywood hit songs official video',
    accent: '#ff4d8d',
  },
  {
    id: 'lofi',
    title: 'Lo-fi & chill',
    subtitle: 'Soft beats for deep focus',
    query: 'lofi chill beats to study',
    accent: '#8b5cf6',
  },
  {
    id: 'pop',
    title: 'Pop pulse',
    subtitle: 'Bright hooks and huge choruses',
    query: 'pop hits official music video',
    accent: '#38bdf8',
  },
  {
    id: 'hiphop',
    title: 'Hip-hop nation',
    subtitle: 'Bars, beats and anthems',
    query: 'hip hop rap hits official video',
    accent: '#f59e0b',
  },
  {
    id: 'rock',
    title: 'Rock classics',
    subtitle: 'Turn it up and sing along',
    query: 'classic rock songs official',
    accent: '#ef4444',
  },
  {
    id: 'edm',
    title: 'EDM & dance',
    subtitle: 'Festival-sized drops',
    query: 'EDM dance music official video',
    accent: '#06b6d4',
  },
];

const GENRES = [
  { id: 'bollywood', name: 'Bollywood', query: 'Bollywood hit songs official video', icon: 'fa-film', colors: ['#ff512f', '#dd2476'] },
  { id: 'pop', name: 'Pop', query: 'pop hits official music video', icon: 'fa-wand-magic-sparkles', colors: ['#38bdf8', '#6366f1'] },
  { id: 'hiphop', name: 'Hip-Hop', query: 'hip hop rap hits official video', icon: 'fa-microphone-lines', colors: ['#f59e0b', '#ef4444'] },
  { id: 'rock', name: 'Rock', query: 'classic rock songs official', icon: 'fa-guitar', colors: ['#ef4444', '#7c3aed'] },
  { id: 'edm', name: 'EDM / Dance', query: 'EDM dance music official video', icon: 'fa-bolt', colors: ['#06b6d4', '#8b5cf6'] },
  { id: 'lofi', name: 'Lo-Fi', query: 'lofi chill beats to study', icon: 'fa-mug-hot', colors: ['#14b8a6', '#0f766e'] },
  { id: 'acoustic', name: 'Acoustic', query: 'acoustic songs official video', icon: 'fa-leaf', colors: ['#84cc16', '#15803d'] },
  { id: 'rnb', name: 'R&B / Soul', query: 'rnb soul songs official', icon: 'fa-heart', colors: ['#ec4899', '#8b5cf6'] },
  { id: 'punjabi', name: 'Punjabi', query: 'punjabi songs official video', icon: 'fa-drum', colors: ['#f97316', '#eab308'] },
  { id: 'kpop', name: 'K-Pop', query: 'kpop songs official video', icon: 'fa-star', colors: ['#a855f7', '#ec4899'] },
  { id: 'romance', name: 'Romance', query: 'romantic songs official video', icon: 'fa-heart-circle-bolt', colors: ['#fb7185', '#e11d48'] },
  { id: 'workout', name: 'Workout', query: 'workout motivation music official', icon: 'fa-dumbbell', colors: ['#22c55e', '#0ea5e9'] },
  { id: 'sad', name: 'Sad songs', query: 'sad songs official video', icon: 'fa-cloud-rain', colors: ['#64748b', '#334155'] },
  { id: 'indie', name: 'Indie', query: 'indie music official video', icon: 'fa-compact-disc', colors: ['#f472b6', '#7c3aed'] },
];

function isLikelyTrack(video) {
  const seconds = Number(video.seconds) || 0;
  // Avoid shorts and hour-long compilations on discovery shelves.
  return seconds === 0 || (seconds >= 30 && seconds <= 1500);
}

async function searchCatalog(query, limit = 20) {
  const key = `search:${query}:${limit}`;
  return memoize(key, 10 * 60 * 1000, async () => {
    let videos = [];
    try {
      const result = await yts(query);
      videos = result.videos || [];
    } catch (err) {
      console.warn('Primary search failed:', err.message);
    }

    if (videos.length === 0) {
      try {
        const fallback = await ytdl.search(query, { limit: Math.max(limit, 20) });
        videos = fallback.map((v) => ({
          videoId: v.id,
          title: v.title,
          author: v.author ? { name: v.author.name } : undefined,
          timestamp: formatDuration(v.lengthSeconds),
          seconds: v.lengthSeconds,
          views: v.viewCount,
          ago: '',
        }));
      } catch (err) {
        console.warn('Fallback search failed:', err.message);
      }
    }

    const mapped = videos.map(mapSearchVideo).filter(Boolean);
    const tracks = mapped.filter(isLikelyTrack);
    return (tracks.length >= Math.min(6, limit) ? tracks : mapped).slice(0, limit);
  });
}

/* ------------------------------------------------------------------ */
/* Spotify playlist import                                             */
/* ------------------------------------------------------------------ */

function extractSpotifyPlaylistId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const uri = value.match(/^spotify:playlist:([A-Za-z0-9]{22})$/i);
  if (uri) return uri[1];

  const link = value.match(
    /open\.spotify\.com\/(?:(?:intl-[a-z-]+|[a-z]{2}(?:-[a-z]{2})?)\/)?playlist\/([A-Za-z0-9]{22})/i
  );
  if (link) return link[1];

  if (/^[A-Za-z0-9]{22}$/.test(value)) return value;
  return null;
}

function wordsForMatch(value) {
  const stop = new Set(['the', 'and', 'with', 'feat', 'ft', 'from', 'official', 'video', 'music', 'audio', 'song', 'lyrics', 'version', 'remix']);
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !stop.has(word))
  );
}

function scoreImportCandidate(entry, track) {
  const wantedTitle = wordsForMatch(entry.title);
  const wantedArtist = wordsForMatch(entry.subtitle);
  const gotTitle = wordsForMatch(track.title);
  const gotArtist = wordsForMatch(track.artist);

  let score = 0;
  for (const word of wantedTitle) if (gotTitle.has(word)) score += 3;
  for (const word of wantedArtist) if (gotArtist.has(word)) score += 2;

  const wantedSeconds = Number(entry.duration) / 1000;
  if (wantedSeconds > 0 && Number(track.seconds) > 0) {
    score -= Math.min(4, Math.abs(wantedSeconds - Number(track.seconds)) / 30);
  }
  return score;
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await task(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchSpotifyPlaylist(id) {
  const response = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'That Spotify playlist could not be found. Make sure it is public.'
        : 'Spotify did not return this playlist. Try again in a moment.'
    );
  }

  const html = await response.text();
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Could not read this Spotify playlist.');

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Could not read this Spotify playlist.');
  }

  const entity = data && data.props && data.props.pageProps && data.props.pageProps.state &&
    data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new Error('This Spotify playlist is empty or private.');
  }

  const entries = entity.trackList
    .filter((item) => item && item.entityType === 'track' && item.title)
    .slice(0, 100);

  return {
    name: String(entity.name || entity.title || 'Imported Spotify playlist').slice(0, 80),
    owner: String(entity.subtitle || 'Spotify').slice(0, 80),
    entries,
  };
}

async function matchSpotifyEntry(entry) {
  const uri = String(entry.uri || entry.title);
  return memoize(`spotify-import:${uri}`, 12 * 60 * 60 * 1000, async () => {
    const query = [entry.title, entry.subtitle].filter(Boolean).join(' ');
    const candidates = await searchCatalog(query, 6);
    if (!candidates.length) return null;

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = scoreImportCandidate(entry, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  });
}

app.get('/api/import/spotify', async (req, res) => {
  try {
    const id = extractSpotifyPlaylistId(req.query.url || req.query.id);
    if (!id) {
      return res.status(400).json({
        error: 'Paste a public Spotify playlist link, for example https://open.spotify.com/playlist/…',
      });
    }

    const playlist = await fetchSpotifyPlaylist(id);
    if (playlist.entries.length === 0) {
      return res.status(422).json({ error: 'This Spotify playlist has no songs to import.' });
    }

    const matched = await mapWithConcurrency(playlist.entries, 8, matchSpotifyEntry);
    const matchedTracks = matched.filter(Boolean);
    const tracks = dedupeTracks(matchedTracks);

    if (tracks.length === 0) {
      return res.status(422).json({
        error: 'None of the songs in this playlist could be matched. Try another public playlist.',
      });
    }

    res.json({
      id,
      name: playlist.name,
      owner: playlist.owner,
      total: playlist.entries.length,
      matched: tracks.length,
      unmatched: Math.max(0, playlist.entries.length - matchedTracks.length),
      tracks,
    });
  } catch (err) {
    console.error('Spotify import error:', err.message);
    res.status(502).json({
      error: err.message || 'Could not import this Spotify playlist. Try again.',
    });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Search query is required' });
    const limit = clampInt(req.query.limit, 1, 40, 28);
    const results = await searchCatalog(query, limit);
    res.json({ query, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Could not load search results right now.' });
  }
});

app.get('/api/suggestions', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ suggestions: [] });
    const suggestions = await memoize(`suggestions:${query}`, 10 * 60 * 1000, async () => {
      try {
        const list = await ytdl.getSuggestions(query);
        return list.slice(0, 8);
      } catch {
        return [];
      }
    });
    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

app.get('/api/trending', async (req, res) => {
  try {
    const category = String(req.query.category || 'top hits 2026').trim();
    const limit = clampInt(req.query.limit, 1, 40, 20);
    const results = await searchCatalog(category, limit);
    res.json({ category, results });
  } catch (err) {
    console.error('Trending error:', err);
    res.status(500).json({ error: 'Could not load trending tracks.' });
  }
});

app.get('/api/home', async (req, res) => {
  try {
    const shelves = await memoize('home:shelves', 12 * 60 * 1000, async () => {
      const settled = await Promise.allSettled(
        HOME_SHELVES.map(async (shelf) => {
          const tracks = await searchCatalog(shelf.query, 14);
          return { ...shelf, tracks };
        })
      );
      return settled
        .filter((item) => item.status === 'fulfilled' && item.value.tracks.length > 0)
        .map((item) => item.value);
    });
    res.json({ shelves, genres: GENRES });
  } catch (err) {
    console.error('Home error:', err);
    res.status(500).json({ error: 'Could not load the home feed.' });
  }
});

app.get('/api/related', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const limit = clampInt(req.query.limit, 1, 40, 20);

    if (!id && !title) return res.status(400).json({ error: 'A track id or title is required' });

    const playlist = await memoize(`related:${id}:${title}:${artist}:${limit}`, 25 * 60 * 1000, async () => {
      let tracks = [];

      if (id) {
        try {
          const related = await ytdl.getRelated(id, { music: true, radioSeed: id });
          tracks = related.map(mapSummary).filter(Boolean);
        } catch (err) {
          console.warn('Related radio lookup failed:', err.message);
        }
      }

      if (tracks.length < 8) {
        const query = [cleanArtistName(artist), cleanTrackTitle(title), 'similar songs']
          .filter(Boolean)
          .join(' ')
          .trim();
        try {
          const fallback = await searchCatalog(query || 'popular songs', limit + 8);
          tracks = tracks.concat(fallback);
        } catch (err) {
          console.warn('Related fallback failed:', err.message);
        }
      }

      return dedupeTracks(tracks, id).slice(0, limit);
    });

    res.json({ playlist });
  } catch (err) {
    console.error('Related error:', err);
    res.status(500).json({ error: 'Could not load related tracks.' });
  }
});

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/thumb', async (req, res) => {
  const id = String(req.query.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return res.status(400).end();
  const size = req.query.size === 'max' ? 'max' : 'hq';
  const names = size === 'max' ? ['maxresdefault', 'sddefault', 'hqdefault'] : ['hqdefault'];

  for (const name of names) {
    try {
      const response = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, {
        headers: { 'User-Agent': DEFAULT_UA },
      });
      if (!response.ok || !response.body) continue;
      res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=21600, immutable');
      Readable.fromWeb(response.body).pipe(res);
      return;
    } catch {
      // try the next size
    }
  }
  return res.status(404).end();
});

/* ------------------------------------------------------------------ */
/* Media resolution + streaming                                        */
/* ------------------------------------------------------------------ */

const sourceCache = new Map();
const sourceInflight = new Map();

function sourceKey(id, kind) {
  return `${kind}:${id}`;
}

/**
 * Resolve a video id into a direct, range-capable media URL.
 * The URL is used only by this server; the browser only ever sees /api/stream.
 */
async function resolveSource(id, kind) {
  const key = sourceKey(id, kind);
  const cached = sourceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (sourceInflight.has(key)) return sourceInflight.get(key);

  const task = (async () => {
    let capturedUrl = null;
    let capturedUA = null;

    // Capture the final, signed media URL that the library resolves for us.
    const trackingFetch = async (url, init = {}) => {
      const response = await fetch(url, init);
      const target = String(url);
      if (target.includes('/videoplayback')) {
        capturedUrl = target;
        const headers = init.headers || {};
        capturedUA = headers['User-Agent'] || headers['user-agent'] || null;
      }
      return response;
    };

    const instance =
      kind === 'video'
        ? new Ytdl({ clients: ['tv', 'web_embedded'], fetch: trackingFetch })
        : new Ytdl({ fetch: trackingFetch });

    const info = await instance.getInfo(id);

    let format;
    if (kind === 'video') {
      format = chooseFormat(info.formats, {
        quality: Quality.Highest,
        filter: (f) => f.hasAudio && f.hasVideo && !f.isDrm,
      });
    } else {
      format = chooseFormat(info.formats, {
        quality: Quality.HighestAudio,
        filter: [
          { hasAudio: true, hasVideo: false, container: 'mp4' },
          { hasAudio: true, hasVideo: false },
          { hasAudio: true },
        ],
      });
    }

    if (!format) throw new Error('No playable format is available for this track.');

    // Force the library to solve the signature / attach its tokens and capture
    // the final URL in the process. A one-byte read is enough.
    const media = instance.open(info, format);
    await new Promise((resolve, reject) => {
      const stream = media.read({ range: { start: 0, end: 0 } });
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('Timed out while preparing this track.')), 45000);
      timer.unref?.();
      stream.once('data', () => {
        clearTimeout(timer);
        finish();
      });
      stream.once('error', (err) => {
        clearTimeout(timer);
        finish(err);
      });
    });

    if (!capturedUrl) throw new Error('Could not prepare this track for playback.');

    const direct = new URL(capturedUrl);
    direct.searchParams.delete('range');

    const headers = {
      'User-Agent': capturedUA || (kind === 'video' ? TV_UA : DEFAULT_UA),
    };

    let total = Number(format.contentLength) || null;
    let contentType = format.mimeType || (kind === 'video' ? 'video/mp4' : 'audio/mp4');

    // Ask for one byte to learn the exact total size and the response headers.
    try {
      const head = await fetch(direct.toString(), {
        method: 'HEAD',
        headers: { ...headers, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(15000),
      });
      if (head.ok) {
        const contentRange = head.headers.get('content-range');
        if (contentRange && contentRange.includes('/')) {
          const size = Number(contentRange.split('/').pop());
          if (Number.isFinite(size) && size > 0) total = size;
        }
        const type = head.headers.get('content-type');
        if (type) contentType = type;
      }
    } catch {
      // The stream can still work without a known total size.
    }

    const expire = Number(direct.searchParams.get('expire'));
    const maxAge = 45 * 60 * 1000;
    const expiresAt = expire
      ? Math.min(expire * 1000 - 60 * 1000, Date.now() + maxAge)
      : Date.now() + maxAge;

    return {
      url: direct.toString(),
      headers,
      total,
      contentType,
      expiresAt,
    };
  })().finally(() => sourceInflight.delete(key));

  sourceInflight.set(key, task);
  task.then((source) => sourceCache.set(key, source)).catch(() => {});
  return task;
}

function parseRangeHeader(header, total) {
  if (!header || !total) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match) return 'invalid';

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) return 'invalid';

  if (start === null) {
    // bytes=-500 → last 500 bytes
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return 'invalid';
    if (start >= total) return 'invalid';
    if (end === null || !Number.isFinite(end) || end >= total) end = total - 1;
    if (end < start) return 'invalid';
  }

  return { start, end };
}

async function sendMedia(req, res, id, kind, attachmentName) {
  let source = await resolveSource(id, kind);
  const range = parseRangeHeader(req.headers.range, source.total);

  if (range === 'invalid') {
    res.status(416);
    if (source.total) res.setHeader('Content-Range', `bytes */${source.total}`);
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const requestSource = async (src) => {
    const headers = { ...src.headers };
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    return fetch(src.url, { headers, signal: controller.signal });
  };

  let upstream = await requestSource(source);

  // Signed media URLs can expire or be rejected. Re-resolve once and retry.
  if (upstream.status === 403 || upstream.status === 410) {
    sourceCache.delete(sourceKey(id, kind));
    source = await resolveSource(id, kind);
    upstream = await requestSource(source);
  }

  if (!upstream.ok && upstream.status !== 206) {
    const message = `Media server responded with ${upstream.status}`;
    upstream.body?.cancel().catch(() => {});
    if (!res.headersSent) res.status(502).json({ error: message });
    else res.end();
    return;
  }

  const isPartial = range && upstream.status === 206;
  if (range && !isPartial) {
    // The origin ignored the range request; serve the full body instead.
    upstream.body?.cancel().catch(() => {});
    upstream = await requestSource({ ...source, headers: source.headers, url: source.url });
  }

  res.status(isPartial ? 206 : 200);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', source.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (attachmentName) {
    const ascii = attachmentName.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachmentName)}`
    );
  }

  if (isPartial) {
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${source.total}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else if (source.total) {
    res.setHeader('Content-Length', String(source.total));
  }

  if (req.method === 'HEAD') {
    upstream.body?.cancel().catch(() => {});
    return res.end();
  }

  if (!upstream.body) {
    return res.status(502).json({ error: 'The media stream was empty.' });
  }

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (err) => {
    if (err.name === 'AbortError') return;
    console.error('Media proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'The media stream failed.' });
    else res.destroy();
  });
  stream.pipe(res);
}

app.get('/api/stream', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const kind = req.query.type === 'video' ? 'video' : 'audio';
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: 'A valid track id is required.' });
  }
  try {
    await sendMedia(req, res, id, kind);
  } catch (err) {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Could not start playback.' });
    else res.destroy();
  }
});

app.get('/api/download', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const kind = req.query.type === 'video' ? 'video' : 'audio';
  const title = String(req.query.title || 'track');
  const artist = String(req.query.artist || '');
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: 'A valid track id is required.' });
  }

  const fileName = sanitizeFilename(`${artist ? `${artist} - ` : ''}${title}`) + (kind === 'video' ? '.mp4' : '.m4a');
  try {
    await sendMedia(req, res, id, kind, fileName);
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Could not start the download.' });
    else res.destroy();
  }
});

/* ------------------------------------------------------------------ */
/* Lyrics                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/lyrics', async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const duration = Number(req.query.duration) || 0;
    if (!title) return res.status(400).json({ error: 'A track title is required.' });

    const key = `lyrics:${title}:${artist}:${duration}`;
    const result = await memoize(key, 6 * 60 * 60 * 1000, async () => {
      const cleanTitle = cleanTrackTitle(title) || title;
      const cleanArtist = cleanArtistName(artist);
      const attempts = [
        { track_name: cleanTitle, artist_name: cleanArtist },
        { q: `${cleanTitle} ${cleanArtist}`.trim() },
        { q: cleanTitle },
      ];

      for (const params of attempts) {
        try {
          const url = `https://lrclib.net/api/search?${new URLSearchParams(params).toString()}`;
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Resona/1.0 (local music app)' },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) continue;
          const items = await response.json();
          if (!Array.isArray(items) || items.length === 0) continue;

          const ranked = items
            .filter((item) => item && (item.syncedLyrics || item.plainLyrics))
            .sort((a, b) => {
              const aScore = (a.syncedLyrics ? 2 : 0) + (a.instrumental ? -1 : 0);
              const bScore = (b.syncedLyrics ? 2 : 0) + (b.instrumental ? -1 : 0);
              if (aScore !== bScore) return bScore - aScore;
              if (duration) {
                return Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration);
              }
              return 0;
            });

          const best = ranked[0];
          if (best) {
            return {
              trackName: best.trackName || cleanTitle,
              artistName: best.artistName || cleanArtist,
              albumName: best.albumName || '',
              duration: best.duration || 0,
              synced: best.syncedLyrics || '',
              plain: best.plainLyrics || '',
              instrumental: Boolean(best.instrumental),
            };
          }
        } catch (err) {
          // try the next query
        }
      }
      return null;
    });

    if (!result) return res.status(404).json({ error: 'No lyrics found for this track.' });
    res.json(result);
  } catch (err) {
    console.error('Lyrics error:', err);
    res.status(500).json({ error: 'Could not load lyrics.' });
  }
});

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'Resona', time: new Date().toISOString() });
});

// JSON 404 for unknown API routes, app shell for everything else.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('');
  console.log('  ♪  Resona is running');
  console.log(`     http://localhost:${PORT}`);
  console.log('');
});
