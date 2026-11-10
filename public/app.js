/* ==========================================================================
   Resona — front-end
   Streams audio and video through the local server only.
   ========================================================================== */

'use strict';

const KEYS = {
  liked: 'resona.liked.v1',
  recent: 'resona.recent.v1',
  playlists: 'resona.playlists.v1',
  downloads: 'resona.downloads.v1',
  searches: 'resona.searches.v1',
  prefs: 'resona.prefs.v1',
};

const FALLBACK_ART =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1a1a2b"/><stop offset="0.55" stop-color="#121220"/><stop offset="1" stop-color="#0a2b1c"/>
      </linearGradient></defs>
      <rect width="320" height="320" fill="url(#g)"/>
      <circle cx="160" cy="160" r="74" fill="rgba(37,224,124,0.10)" stroke="rgba(37,224,124,0.35)" stroke-width="2"/>
      <path d="M142 200V126l56-14v72" fill="none" stroke="#25e07c" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="132" cy="202" r="13" fill="#25e07c"/>
      <circle cx="188" cy="186" r="13" fill="#25e07c"/>
    </svg>`
  );

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                            */
/* -------------------------------------------------------------------------- */

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* storage can be unavailable in private mode */
  }
}

function sanitizeTrack(value) {
  if (!value || typeof value !== 'object' || !value.id) return null;
  return {
    id: String(value.id),
    title: String(value.title || 'Unknown title'),
    artist: String(value.artist || 'Unknown artist'),
    duration: String(value.duration || '0:00'),
    seconds: Number(value.seconds) || 0,
    thumbnail: String(value.thumbnail || ''),
    views: Number(value.views) || 0,
    viewsLabel: String(value.viewsLabel || ''),
    ago: String(value.ago || ''),
    video: value.video !== false,
  };
}

function sanitizeTracks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const track = sanitizeTrack(item);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

const storedPrefs = readStore(KEYS.prefs, {});

function normalizeSearches(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const entry =
      typeof item === 'string'
        ? { q: item, label: item }
        : item && typeof item === 'object'
          ? { q: String(item.q || item.label || ''), label: String(item.label || item.q || '') }
          : null;
    if (!entry || !entry.q || seen.has(entry.q)) continue;
    seen.add(entry.q);
    out.push(entry);
  }
  return out.slice(0, 10);
}

function normalizePlaylists(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((pl) => pl && pl.id && pl.name)
    .map((pl) => ({
      id: String(pl.id),
      name: String(pl.name).slice(0, 80),
      createdAt: Number(pl.createdAt) || Date.now(),
      tracks: sanitizeTracks(pl.tracks),
    }));
}

function normalizeDownloads(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && item.trackId)
    .map((item) => ({
      key: String(item.key || `${item.trackId}:${item.type || 'audio'}`),
      trackId: String(item.trackId),
      title: String(item.title || 'Unknown title'),
      artist: String(item.artist || 'Unknown artist'),
      duration: String(item.duration || '0:00'),
      seconds: Number(item.seconds) || 0,
      thumbnail: String(item.thumbnail || ''),
      type: item.type === 'video' ? 'video' : 'audio',
      at: Number(item.at) || Date.now(),
      track: sanitizeTrack(item.track),
    }));
}

/* -------------------------------------------------------------------------- */
/* Application state                                                          */
/* -------------------------------------------------------------------------- */

const state = {
  view: 'home',
  mode: storedPrefs.mode === 'video' ? 'video' : 'audio',
  autoplay: storedPrefs.autoplay !== false,
  volume: Math.min(1, Math.max(0, Number(storedPrefs.volume ?? 0.8))),
  muted: Boolean(storedPrefs.muted),

  current: null,
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off',
  playing: false,
  loading: false,
  loadToken: 0,
  retried: false,
  pendingSeek: 0,

  liked: sanitizeTracks(readStore(KEYS.liked, [])),
  recent: sanitizeTracks(readStore(KEYS.recent, [])),
  playlists: normalizePlaylists(readStore(KEYS.playlists, [])),
  curated: [],
  downloads: normalizeDownloads(readStore(KEYS.downloads, [])),
  searches: normalizeSearches(readStore(KEYS.searches, [])),

  homeShelves: [],
  genres: [],
  heroTrack: null,
  heroListId: null,
  homeLoading: false,

  searchQuery: '',
  searchLabel: '',
  searchResults: [],
  searchTab: 'all',
  searchLoading: false,

  currentPlaylist: null,
  npTab: 'queue',
  lyrics: null,
  lyricsLoading: false,
  lyricsFor: null,
};

const trackStore = new Map();
const listStore = new Map();
const lyricsCache = new Map();
const radioFetched = new Set();

let menuState = null;
let activeLyricsKey = '';
let dragProgress = null;
let searchTimer = null;
let suggestTimer = null;

/* -------------------------------------------------------------------------- */
/* DOM references                                                             */
/* -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const ui = {
  sidebar: $('sidebar'),
  mobileMenu: $('mobile-menu-btn'),

  searchInput: $('search-input'),
  searchClear: $('search-clear'),
  suggestions: $('suggestions'),

  modeToggle: $('mode-toggle'),
  modeIcon: $('mode-icon'),
  modeLabel: $('mode-label'),
  topDownload: $('top-download'),

  heroArt: $('hero-art'),
  heroTitle: $('hero-title'),
  heroSubtitle: $('hero-subtitle'),
  heroPlay: $('hero-play'),
  heroVideo: $('hero-video'),
  heroLike: $('hero-like'),
  heroGlow: $('hero-glow'),
  homeShelves: $('home-shelves'),
  homeGenres: $('home-genres'),

  searchTabs: $('search-tabs'),
  searchResults: $('search-results'),
  searchMeta: $('search-meta'),
  searchSubtitle: $('search-subtitle'),
  searchEmpty: $('search-empty'),
  recentSearches: $('recent-searches'),
  recentSearchChips: $('recent-search-chips'),
  clearRecentSearches: $('clear-recent-searches'),

  genreGrid: $('genre-grid'),

  likedList: $('liked-list'),
  likedEmpty: $('liked-empty'),
  likedCount: $('liked-count'),
  likedDuration: $('liked-duration'),
  likedPlay: $('liked-play'),
  likedShuffle: $('liked-shuffle'),
  likedNavCount: $('liked-nav-count'),

  downloadsList: $('downloads-list'),
  downloadsEmpty: $('downloads-empty'),
  downloadsSubtitle: $('downloads-subtitle'),
  clearDownloads: $('clear-downloads'),

  playlistList: $('playlist-list'),
  playlistTitle: $('playlist-title'),
  playlistSubtitle: $('playlist-subtitle'),
  playlistTracks: $('playlist-tracks'),
  playlistEmpty: $('playlist-empty'),
  playlistArt: $('playlist-art'),
  playlistPlay: $('playlist-play'),
  playlistShuffle: $('playlist-shuffle'),
  playlistRename: $('playlist-rename'),
  playlistDelete: $('playlist-delete'),
  createPlaylistBtn: $('create-playlist-btn'),
  importPlaylistBtn: $('import-playlist-btn'),

  videoStageTitle: $('video-stage-title'),
  videoStageArtist: $('video-stage-artist'),
  videoStageMount: $('video-stage-mount'),
  videoPlaceholder: $('video-placeholder'),
  videoLoading: $('video-loading'),
  videoUpnext: $('video-upnext'),
  videoDownload: $('video-download'),
  videoAudioMode: $('video-audio-mode'),
  videoQueueOpen: $('video-queue-open'),

  playerArt: $('player-art'),
  playerTitle: $('player-title'),
  playerArtist: $('player-artist'),
  playerLike: $('player-like'),
  playerExpand: $('player-expand'),
  playBtn: $('play-btn'),
  playIcon: $('play-icon'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  shuffleBtn: $('shuffle-btn'),
  repeatBtn: $('repeat-btn'),
  repeatBadge: $('repeat-badge'),
  progressContainer: $('progress-container'),
  progressFill: $('progress-fill'),
  progressBuffer: $('progress-buffer'),
  progressKnob: $('progress-knob'),
  currentTime: $('current-time'),
  totalTime: $('total-time'),

  lyricsBtn: $('lyrics-btn'),
  queueBtn: $('queue-btn'),
  videoBtn: $('video-btn'),
  volumeBtn: $('volume-btn'),
  volumeIcon: $('volume-icon'),
  volumeSlider: $('volume-slider'),

  mediaHost: $('media-host'),
  autoplaySwitch: $('autoplay-switch'),

  nowPlaying: $('now-playing'),
  npBg: $('np-bg'),
  npArt: $('np-art'),
  npTitle: $('np-title'),
  npArtist: $('np-artist'),
  npLike: $('np-like'),
  npVideo: $('np-video'),
  npDownload: $('np-download'),
  npAdd: $('np-add'),
  npTabs: $('np-tabs'),
  npPanel: $('np-panel'),
  npClose: $('np-close'),
  npProgress: $('np-progress'),
  npFill: $('np-fill'),
  npBuffer: $('np-buffer'),
  npKnob: $('np-knob'),
  npCurrent: $('np-current'),
  npTotal: $('np-total'),
  npPlay: $('np-play'),
  npPlayIcon: $('np-play-icon'),
  npPrev: $('np-prev'),
  npNext: $('np-next'),
  npShuffle: $('np-shuffle'),
  npRepeat: $('np-repeat'),
  npRepeatBadge: $('np-repeat-badge'),
  npMute: $('np-mute'),
  npVolume: $('np-volume'),
  npVolumeIcon: $('np-volume-icon'),
  visualizer: $('visualizer'),

  queueDrawer: $('queue-drawer'),
  queueClose: $('queue-close'),
  queueClear: $('queue-clear'),
  queueNow: $('queue-now'),
  queueList: $('queue-list'),

  lyricsDrawer: $('lyrics-drawer'),
  lyricsTitle: $('lyrics-title'),
  lyricsArtist: $('lyrics-artist'),
  lyricsBody: $('lyrics-body'),
  lyricsClose: $('lyrics-close'),

  contextMenu: $('context-menu'),
  modalRoot: $('modal-root'),
  toastContainer: $('toast-container'),
};

const media = $('media');

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMinutes(seconds) {
  const mins = Math.round((Number(seconds) || 0) / 60);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function thumbFor(track, size) {
  if (!track || !track.id) return FALLBACK_ART;
  return `/api/thumb?id=${encodeURIComponent(track.id)}&size=${size === 'max' ? 'max' : 'hq'}`;
}

function viewsLabel(track) {
  if (!track) return '';
  if (track.viewsLabel) return `${track.viewsLabel} views`;
  if (track.views) {
    try {
      return `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(track.views)} views`;
    } catch (err) {
      return `${track.views} views`;
    }
  }
  return 'Resona';
}

function relativeDay(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function debounce(fn, wait) {
  return function debounced(...args) {
    clearTimeout(fn.__timer);
    fn.__timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = 'toast' + (type === 'error' ? ' is-error' : '');
  const icon =
    type === 'error' ? 'fa-circle-exclamation' : type === 'info' ? 'fa-circle-info' : 'fa-circle-check';
  node.innerHTML = `<i class="fa-solid ${icon}"></i><span>${esc(message)}</span>`;
  ui.toastContainer.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 280);
  }, 3400);
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (err) {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json();
}

/* -------------------------------------------------------------------------- */
/* Track / list registry                                                      */
/* -------------------------------------------------------------------------- */

function registerTracks(tracks) {
  if (!Array.isArray(tracks)) return;
  for (const track of tracks) {
    if (track && track.id) trackStore.set(String(track.id), track);
  }
}

function registerList(id, tracks) {
  const clean = sanitizeTracks(tracks);
  registerTracks(clean);
  listStore.set(id, clean);
  return clean;
}

function getTrack(id) {
  if (!id) return null;
  if (state.current && String(state.current.id) === String(id)) return state.current;
  return trackStore.get(String(id)) || null;
}

function getList(id) {
  if (!id) return [];
  if (listStore.has(id)) return listStore.get(id);
  if (id === 'liked') return state.liked;
  if (id === 'queue') return state.queue;
  if (id.startsWith('playlist:')) {
    const playlist = state.playlists.find((pl) => pl.id === id.slice(9));
    return playlist ? playlist.tracks : [];
  }
  return [];
}

function isLiked(id) {
  return state.liked.some((track) => String(track.id) === String(id));
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function savePrefs() {
  writeStore(KEYS.prefs, {
    mode: state.mode,
    autoplay: state.autoplay,
    volume: state.volume,
    muted: state.muted,
  });
}

function saveLiked() {
  writeStore(KEYS.liked, state.liked);
}

function savePlaylists() {
  writeStore(KEYS.playlists, state.playlists);
}

function saveDownloads() {
  writeStore(KEYS.downloads, state.downloads);
}

function saveSearches() {
  writeStore(KEYS.searches, state.searches);
}

function addRecent(track) {
  if (!track || !track.id) return;
  state.recent = [track, ...state.recent.filter((item) => String(item.id) !== String(track.id))].slice(0, 40);
  writeStore(KEYS.recent, state.recent);
}

function rememberSearch(query, label) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return;
  const display = String(label || cleanQuery).trim() || cleanQuery;
  state.searches = [
    { q: cleanQuery, label: display },
    ...state.searches.filter((item) => item.q !== cleanQuery),
  ].slice(0, 10);
  saveSearches();
  renderRecentSearches();
}

/* -------------------------------------------------------------------------- */
/* Shared renderers                                                           */
/* -------------------------------------------------------------------------- */

function likeIcon(liked) {
  return liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
}

function syncLikeUI() {
  const currentLiked = state.current ? isLiked(state.current.id) : false;

  ui.playerLike.classList.toggle('is-liked', currentLiked);
  ui.playerLike.innerHTML = `<i class="${likeIcon(currentLiked)}"></i>`;
  ui.npLike.classList.toggle('is-liked', currentLiked);
  ui.npLike.innerHTML = `<i class="${likeIcon(currentLiked)}"></i>`;

  const heroLiked = state.heroTrack ? isLiked(state.heroTrack.id) : false;
  ui.heroLike.innerHTML = `<i class="${likeIcon(heroLiked)}"></i>`;
  ui.heroLike.classList.toggle('is-liked', heroLiked);

  document.querySelectorAll('[data-action="like"][data-track-id]').forEach((button) => {
    const liked = isLiked(button.dataset.trackId);
    button.classList.toggle('is-liked', liked);
    const icon = button.querySelector('i');
    if (icon) icon.className = likeIcon(liked);
    button.setAttribute('title', liked ? 'Remove from liked songs' : 'Like song');
  });

  ui.likedNavCount.textContent = String(state.liked.length);
  ui.likedCount.textContent = `${state.liked.length} ${state.liked.length === 1 ? 'song' : 'songs'}`;
  const totalSeconds = state.liked.reduce((sum, track) => sum + (Number(track.seconds) || 0), 0);
  ui.likedDuration.textContent = formatMinutes(totalSeconds);
}

function syncPlayingUI() {
  const playing = state.playing;
  const iconClass = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  ui.playIcon.className = iconClass;
  ui.npPlayIcon.className = iconClass;

  const currentId = state.current ? String(state.current.id) : '';

  document.querySelectorAll('.track-card[data-track-id]').forEach((card) => {
    const isCurrent = currentId && card.dataset.trackId === currentId;
    card.classList.toggle('is-playing', Boolean(isCurrent));
    const icon = card.querySelector('.card-play i');
    if (icon) icon.className = isCurrent && playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  });

  document.querySelectorAll('.track-row[data-track-id]').forEach((row) => {
    row.classList.toggle('is-playing', Boolean(currentId && row.dataset.trackId === currentId));
  });

  document.querySelectorAll('.upnext-item[data-track-id]').forEach((item) => {
    item.classList.toggle('is-playing', Boolean(currentId && item.dataset.trackId === currentId));
  });

  ui.shuffleBtn.classList.toggle('active', state.shuffle);
  ui.npShuffle.classList.toggle('active', state.shuffle);
  ui.repeatBtn.classList.toggle('active', state.repeat !== 'off');
  ui.npRepeat.classList.toggle('active', state.repeat !== 'off');
  ui.repeatBadge.hidden = state.repeat !== 'one';
  ui.npRepeatBadge.hidden = state.repeat !== 'one';
  ui.repeatBtn.classList.toggle('is-one', state.repeat === 'one');
  ui.npRepeat.classList.toggle('is-one', state.repeat === 'one');

  ui.playerTitle.textContent = state.current ? state.current.title : 'Select a track';
  ui.playerArtist.textContent = state.current ? state.current.artist : 'Resona';
  ui.playerArt.src = state.current ? thumbFor(state.current, 'hq') : FALLBACK_ART;
  ui.playerArt.alt = state.current ? state.current.title : '';
  ui.topDownload.disabled = !state.current;
  ui.videoDownload.disabled = !state.current;

  if (state.current) {
    ui.npTitle.textContent = state.current.title;
    ui.npArtist.textContent = state.current.artist;
    ui.npArt.src = thumbFor(state.current, 'max');
    ui.npArt.alt = state.current.title;
    ui.npBg.style.backgroundImage = `url("${thumbFor(state.current, 'max')}")`;
    ui.videoStageTitle.textContent = state.current.title;
    ui.videoStageArtist.textContent = state.current.artist;
  } else {
    ui.videoStageTitle.textContent = 'Select a track to watch';
    ui.videoStageArtist.textContent = 'Video plays right here — no redirects, no pop-ups.';
  }
}

function cardHTML(track, listId) {
  const liked = isLiked(track.id);
  const isCurrent = state.current && String(state.current.id) === String(track.id);
  const duration = track.duration || formatTime(track.seconds);
  const badge = track.video === false ? 'AUDIO' : 'VIDEO';
  return `
    <article class="track-card${isCurrent ? ' is-playing' : ''}" data-track-id="${esc(track.id)}" data-list="${esc(listId)}">
      <div class="card-art">
        <img src="${thumbFor(track, 'hq')}" alt="${esc(track.title)}" loading="lazy">
        <span class="card-duration">${esc(duration)}</span>
        <button class="card-like${liked ? ' is-liked' : ''}" data-action="like" data-track-id="${esc(track.id)}" title="${liked ? 'Remove from liked songs' : 'Like song'}">
          <i class="${likeIcon(liked)}"></i>
        </button>
        <button class="card-more" data-action="menu" data-track-id="${esc(track.id)}" data-list="${esc(listId)}" title="More options">
          <i class="fa-solid fa-ellipsis"></i>
        </button>
        <button class="card-play" data-action="play" data-track-id="${esc(track.id)}" data-list="${esc(listId)}" title="Play">
          <i class="${isCurrent && state.playing ? 'fa-solid fa-pause' : 'fa-solid fa-play'}"></i>
        </button>
      </div>
      <div class="card-title" title="${esc(track.title)}">${esc(track.title)}</div>
      <div class="card-artist" title="${esc(track.artist)}">${esc(track.artist)}</div>
      <div class="card-foot">
        <span>${esc(viewsLabel(track))}</span>
        <span class="card-badge">${badge}</span>
      </div>
    </article>`;
}

function rowHTML(track, index, listId, options = {}) {
  const liked = isLiked(track.id);
  const isCurrent = state.current && String(state.current.id) === String(track.id);
  const duration = track.duration || formatTime(track.seconds);
  const album = options.album || track.ago || 'Single';
  return `
    <div class="track-row${isCurrent ? ' is-playing' : ''}" data-track-id="${esc(track.id)}" data-list="${esc(listId)}" data-index="${index}">
      <span class="row-index">${index + 1}</span>
      <img class="row-art" src="${thumbFor(track, 'hq')}" alt="" loading="lazy">
      <div class="row-meta">
        <strong title="${esc(track.title)}">${esc(track.title)}</strong>
        <span title="${esc(track.artist)}">${esc(track.artist)}</span>
      </div>
      <span class="row-album" title="${esc(album)}">${esc(album)}</span>
      <span class="row-time">${esc(duration)}</span>
      <button class="row-like${liked ? ' is-liked' : ''}" data-action="like" data-track-id="${esc(track.id)}" title="${liked ? 'Unlike' : 'Like'}">
        <i class="${likeIcon(liked)}"></i>
      </button>
      <button class="row-more" data-action="menu" data-track-id="${esc(track.id)}" data-list="${esc(listId)}${options.playlistId ? `" data-playlist-id="${esc(options.playlistId)}` : ''}${options.downloadKey ? `" data-download-key="${esc(options.downloadKey)}` : ''}" title="More options">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
    </div>`;
}

function downloadRowHTML(entry, index) {
  const track =
    entry.track ||
    sanitizeTrack({
      id: entry.trackId,
      title: entry.title,
      artist: entry.artist,
      duration: entry.duration,
      seconds: entry.seconds,
      thumbnail: entry.thumbnail,
    });
  if (track) trackStore.set(String(track.id), track);
  const isCurrent = state.current && String(state.current.id) === String(entry.trackId);
  return `
    <div class="track-row${isCurrent ? ' is-playing' : ''}" data-track-id="${esc(entry.trackId)}" data-list="downloads" data-download-key="${esc(entry.key)}">
      <span class="row-index"><i class="fa-solid ${entry.type === 'video' ? 'fa-film' : 'fa-music'}"></i></span>
      <img class="row-art" src="${thumbFor({ id: entry.trackId }, 'hq')}" alt="" loading="lazy">
      <div class="row-meta">
        <strong title="${esc(entry.title)}">${esc(entry.title)}</strong>
        <span title="${esc(entry.artist)}">${esc(entry.artist)}</span>
      </div>
      <span class="row-album">${entry.type === 'video' ? 'MP4 video' : 'M4A audio'}</span>
      <span class="row-time">${esc(relativeDay(entry.at))}</span>
      <button class="row-like" data-action="download" data-track-id="${esc(entry.trackId)}" data-type="${entry.type}" title="Download again">
        <i class="fa-solid fa-download"></i>
      </button>
      <button class="row-more" data-action="menu" data-track-id="${esc(entry.trackId)}" data-list="downloads" data-download-key="${esc(entry.key)}" title="More options">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
    </div>`;
}

function renderCardGrid(container, tracks, listId, limit) {
  registerList(listId, tracks);
  const list = Number.isFinite(limit) ? tracks.slice(0, limit) : tracks;
  container.innerHTML = list.map((track) => cardHTML(track, listId)).join('');
}

function renderRows(container, tracks, listId, options = {}) {
  registerList(listId, tracks);
  container.innerHTML = tracks
    .map((track, index) => rowHTML(track, index, listId, { ...options, playlistId: options.playlistId }))
    .join('');
}

function renderShelf(shelf) {
  const listId = `shelf:${shelf.id}`;
  registerList(listId, shelf.tracks);
  const cards = shelf.tracks.slice(0, 10).map((track) => cardHTML(track, listId)).join('');
  return `
    <section class="shelf" data-shelf-id="${esc(shelf.id)}">
      <div class="shelf-head">
        <div>
          <h2>${esc(shelf.title)}</h2>
          <p>${esc(shelf.subtitle || '')}</p>
        </div>
        <div class="shelf-tools">
          <button class="text-btn" data-action="shelf-play" data-shelf-id="${esc(shelf.id)}">
            <i class="fa-solid fa-play"></i> Play all
          </button>
          <button class="text-btn" data-action="shelf-more" data-shelf-id="${esc(shelf.id)}">
            View all <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>
      </div>
      <div class="card-grid">${cards}</div>
    </section>`;
}

function renderShelves(shelves) {
  if (!Array.isArray(shelves) || shelves.length === 0) {
    ui.homeShelves.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon"><i class="fa-solid fa-satellite-dish"></i></span>
        <h3>Nothing loaded yet</h3>
        <p>The music feed could not be reached. Try searching for a song instead.</p>
      </div>`;
    return;
  }
  ui.homeShelves.innerHTML = shelves.map(renderShelf).join('');
}

function renderGenres(target, genres, compact) {
  if (!target) return;
  if (!Array.isArray(genres) || genres.length === 0) {
    target.innerHTML = '';
    return;
  }
  const list = compact ? genres.slice(0, 8) : genres;
  target.innerHTML = list
    .map((genre) => {
      const colors = Array.isArray(genre.colors) && genre.colors.length >= 2 ? genre.colors : ['#25e07c', '#0f766e'];
      return `
        <button class="genre-tile" data-action="genre" data-genre-id="${esc(genre.id)}"
          style="--g1:${esc(colors[0])};--g2:${esc(colors[1])}">
          <i class="fa-solid ${esc(genre.icon || 'fa-music')}"></i>
          <strong>${esc(genre.name)}</strong>
          <small>Explore</small>
        </button>`;
    })
    .join('');
}

function playlistItemHTML(playlist) {
  const cover = playlist.tracks[0];
  const thumb = cover
    ? `<img src="${thumbFor(cover, 'hq')}" alt="" loading="lazy">`
    : '<i class="fa-solid fa-list-music"></i>';
  const count = `${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}`;
  const note = playlist.curated ? `${count} • curated` : count;
  return `
    <button class="playlist-item${state.currentPlaylist === playlist.id ? ' is-active' : ''}"
      data-nav="playlist" data-playlist-id="${esc(playlist.id)}" title="${esc(playlist.name)}">
      <span class="playlist-thumb">${thumb}</span>
      <span>${esc(playlist.name)}<small>${note}</small></span>
    </button>`;
}

function renderPlaylistSidebar() {
  const curated = state.curated || [];
  const user = state.playlists;

  if (curated.length === 0 && user.length === 0) {
    ui.playlistList.innerHTML = '';
    return;
  }

  const groups = [];
  if (curated.length) {
    groups.push('<div class="playlist-group-label">Made for you</div>');
    groups.push(...curated.map(playlistItemHTML));
  }
  if (user.length) {
    groups.push('<div class="playlist-group-label">Your playlists</div>');
    groups.push(...user.map(playlistItemHTML));
  }
  ui.playlistList.innerHTML = groups.join('');
}

function renderRecentSearches() {
  if (state.searches.length === 0) {
    ui.recentSearches.hidden = true;
    ui.recentSearchChips.innerHTML = '';
    return;
  }
  ui.recentSearches.hidden = false;
  ui.recentSearchChips.innerHTML = state.searches
    .map(
      (entry) => `
      <button class="chip" data-action="recent-search" data-query="${esc(entry.q)}" data-label="${esc(entry.label)}">
        <i class="fa-solid fa-clock-rotate-left"></i> ${esc(entry.label)}
      </button>`
    )
    .join('');
}

function renderHero(track, listId) {
  state.heroTrack = track || null;
  state.heroListId = listId || null;
  if (!track) {
    ui.heroArt.removeAttribute('src');
    ui.heroTitle.textContent = 'Your next favourite song is one tap away.';
    ui.heroSubtitle.textContent =
      'Stream music and videos instantly, build playlists, and download tracks for offline listening.';
    syncLikeUI();
    return;
  }
  ui.heroArt.src = thumbFor(track, 'max');
  ui.heroArt.alt = track.title;
  ui.heroTitle.textContent = track.title;
  ui.heroSubtitle.textContent = `${track.artist} • ${viewsLabel(track)}${track.ago ? ` • ${track.ago}` : ''}`;
  ui.heroLike.disabled = false;
  syncLikeUI();
}

/* -------------------------------------------------------------------------- */
/* Media playback engine                                                      */
/* -------------------------------------------------------------------------- */

function getDuration() {
  if (Number.isFinite(media.duration) && media.duration > 0) return media.duration;
  if (state.current && Number(state.current.seconds) > 0) return Number(state.current.seconds);
  return 0;
}

function updateProgressUI() {
  const duration = getDuration();
  const current = Math.max(0, Number(media.currentTime) || 0);
  const pct = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;
  const percent = pct * 100;

  ui.progressFill.style.width = `${percent}%`;
  ui.npFill.style.width = `${percent}%`;
  ui.progressKnob.style.left = `${percent}%`;
  ui.npKnob.style.left = `${percent}%`;
  ui.currentTime.textContent = formatTime(current);
  ui.totalTime.textContent = formatTime(duration);
  ui.npCurrent.textContent = formatTime(current);
  ui.npTotal.textContent = formatTime(duration);

  let buffered = 0;
  try {
    if (media.buffered && media.buffered.length && duration > 0) {
      buffered = Math.min(1, media.buffered.end(media.buffered.length - 1) / duration);
    }
  } catch (err) {
    buffered = 0;
  }
  ui.progressBuffer.style.width = `${buffered * 100}%`;
  ui.npBuffer.style.width = `${buffered * 100}%`;

  updateLyricsHighlight(current);
}

function moveMediaElement() {
  const target = state.mode === 'video' ? ui.videoStageMount : ui.mediaHost;
  if (media.parentElement !== target) target.appendChild(media);
  media.controls = state.mode === 'video';
}

function updateModeUI() {
  const isVideo = state.mode === 'video';
  ui.modeToggle.classList.toggle('is-video', isVideo);
  ui.modeIcon.className = isVideo ? 'fa-solid fa-film' : 'fa-solid fa-headphones';
  ui.modeLabel.textContent = isVideo ? 'Video' : 'Audio';
  ui.modeToggle.title = isVideo ? 'Switch to audio mode' : 'Switch to video mode';
  moveMediaElement();
  updateVideoStage();
}

function updateVideoStage() {
  const hasVideo = Boolean(state.current) && state.mode === 'video';
  ui.videoPlaceholder.hidden = hasVideo;
  ui.videoLoading.hidden = !(state.loading && state.mode === 'video');
  if (!state.current) {
    ui.videoStageTitle.textContent = 'Select a track to watch';
    ui.videoStageArtist.textContent = 'Video plays right here — no redirects, no pop-ups.';
  }
  renderVideoUpnext();
}

function queueItemHTML(track, index, options = {}) {
  const isCurrent = state.current && String(state.current.id) === String(track.id) && !options.alwaysPlay;
  const badge = options.badge || track.duration || formatTime(track.seconds);
  const className = options.className || 'np-queue-item';
  return `
    <button class="${className}${isCurrent ? ' is-playing' : ''}" data-action="queue-play" data-index="${index}" data-track-id="${esc(track.id)}" title="${esc(track.title)}">
      <img src="${thumbFor(track, 'hq')}" alt="" loading="lazy">
      <div>
        <strong>${esc(track.title)}</strong>
        <span>${esc(track.artist)}</span>
      </div>
      <span class="queue-badge">${esc(badge)}</span>
    </button>`;
}

function renderQueueDrawer() {
  if (!state.queue.length) {
    ui.queueNow.innerHTML = '';
    ui.queueList.innerHTML = `
      <div class="queue-empty">
        <i class="fa-solid fa-list"></i>
        <span>Your queue is empty.<br>Play something to get started.</span>
      </div>`;
    return;
  }

  const current = state.current || state.queue[state.index] || null;
  ui.queueNow.innerHTML = current ? queueItemHTML(current, Math.max(0, state.index), { alwaysPlay: true }) : '';

  const items = state.queue
    .map((track, index) => {
      if (current && String(track.id) === String(current.id) && index === state.index) return '';
      return queueItemHTML(track, index);
    })
    .filter(Boolean)
    .join('');

  ui.queueList.innerHTML =
    items ||
    `<div class="queue-empty"><i class="fa-solid fa-hourglass-half"></i><span>Nothing else queued.</span></div>`;
}

function renderVideoUpnext() {
  if (!ui.videoUpnext) return;
  if (!state.queue.length) {
    ui.videoUpnext.innerHTML = `
      <div class="queue-empty">
        <i class="fa-solid fa-list"></i>
        <span>Pick a track to build the queue.</span>
      </div>`;
    return;
  }
  const start = state.index >= 0 ? state.index + 1 : 0;
  const items = [];
  for (let i = 0; i < state.queue.length && items.length < 14; i += 1) {
    const index = (start + i) % state.queue.length;
    if (index === state.index) continue;
    items.push(queueItemHTML(state.queue[index], index, { className: 'upnext-item' }));
  }
  ui.videoUpnext.innerHTML = items.join('');
}

function renderNowPlayingPanel() {
  if (ui.nowPlaying.hidden) return;

  if (state.npTab === 'queue') {
    if (!state.queue.length) {
      ui.npPanel.innerHTML = `<div class="queue-empty"><i class="fa-solid fa-list"></i><span>Queue is empty.</span></div>`;
      return;
    }
    let start = state.index >= 0 ? state.index : 0;
    const items = [];
    for (let i = 0; i < state.queue.length; i += 1) {
      const index = (start + i) % state.queue.length;
      items.push(queueItemHTML(state.queue[index], index));
    }
    ui.npPanel.innerHTML = items.join('');
    return;
  }

  if (state.npTab === 'lyrics') {
    ui.npPanel.innerHTML = `<div class="lyrics-body">${lyricsPanelHTML()}</div>`;
    bindLyricsClicks(ui.npPanel);
    updateLyricsHighlight(Number(media.currentTime) || 0, true);
    return;
  }

  const track = state.current;
  if (!track) {
    ui.npPanel.innerHTML = `<div class="queue-empty"><i class="fa-solid fa-circle-info"></i><span>Nothing playing.</span></div>`;
    return;
  }
  const rows = [
    ['Title', track.title],
    ['Artist', track.artist],
    ['Duration', track.duration || formatTime(track.seconds)],
    ['Views', viewsLabel(track)],
    ['Published', track.ago || '—'],
    ['Source', 'Resona stream'],
    ['Playback', state.mode === 'video' ? 'Video stage (360p)' : 'Audio mode (M4A)'],
    ['Download', 'Audio & video available'],
  ];
  ui.npPanel.innerHTML = `
    <div class="details-list">
      ${rows.map(([label, value]) => `<div class="detail-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}
    </div>`;
}

function refreshQueueViews() {
  renderQueueDrawer();
  renderVideoUpnext();
  if (!ui.nowPlaying.hidden) renderNowPlayingPanel();
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = state.current;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    const artwork = new URL(thumbFor(track, 'max'), location.origin).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: 'Resona',
      artwork: [
        { src: artwork, sizes: '512x512', type: 'image/jpeg' },
        { src: artwork, sizes: '256x256', type: 'image/jpeg' },
      ],
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (Number.isFinite(details.seekTime)) media.currentTime = details.seekTime;
    });
    navigator.mediaSession.playbackState = media.paused ? 'paused' : 'playing';
  } catch (err) {
    /* media session is best-effort */
  }
}

function applyVolume() {
  media.volume = state.volume;
  media.muted = state.muted;
  ui.volumeSlider.value = String(state.volume);
  ui.npVolume.value = String(state.volume);
  const icon = state.muted || state.volume === 0
    ? 'fa-solid fa-volume-xmark'
    : state.volume < 0.45
      ? 'fa-solid fa-volume-low'
      : 'fa-solid fa-volume-high';
  ui.volumeIcon.className = icon;
  ui.npVolumeIcon.className = icon;
}

function setVolume(value) {
  state.volume = Math.min(1, Math.max(0, Number(value) || 0));
  if (state.volume > 0) state.muted = false;
  applyVolume();
  savePrefs();
}

function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  savePrefs();
}

function startMedia(track, options = {}) {
  if (!track) return;
  const token = ++state.loadToken;
  const startAt = Math.max(0, Number(options.startAt) || 0);
  const autoplay = options.autoplay !== false;
  const bust = options.force ? `&t=${Date.now()}` : '';

  state.pendingSeek = startAt;
  state.loading = true;
  if (!options.retry) state.retried = false;

  media.pause();
  media.volume = state.volume;
  media.muted = state.muted;
  media.src = `/api/stream?id=${encodeURIComponent(track.id)}&type=${state.mode}${bust}`;
  media.load();

  ui.videoLoading.hidden = !(state.mode === 'video');
  updateVideoStage();

  if (autoplay) {
    const promise = media.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {
        if (token !== state.loadToken) return;
        state.playing = false;
        state.loading = false;
        updateVideoStage();
        syncPlayingUI();
        toast('Press play to start listening.', 'info');
      });
    }
  } else {
    state.playing = false;
    syncPlayingUI();
  }
}

function playTrack(track, options = {}) {
  if (!track) return;
  track = sanitizeTrack(track) || track;
  trackStore.set(String(track.id), track);

  const list = options.listId ? getList(options.listId) : null;
  let index = -1;
  if (list && list.length) {
    index = list.findIndex((item) => String(item.id) === String(track.id));
  }

  if (index >= 0) {
    state.queue = list.slice();
    state.index = index;
  } else {
    const existing = state.queue.findIndex((item) => String(item.id) === String(track.id));
    if (existing >= 0) {
      state.index = existing;
    } else {
      state.queue.push(track);
      state.index = state.queue.length - 1;
    }
  }

  state.current = track;
  state.pendingSeek = 0;
  state.retried = false;
  addRecent(track);

  if (options.mode && options.mode !== state.mode) {
    state.mode = options.mode === 'video' ? 'video' : 'audio';
    savePrefs();
  }

  moveMediaElement();
  syncPlayingUI();
  syncLikeUI();
  updateModeUI();
  refreshQueueViews();
  updateMediaSession();

  startMedia(track, { autoplay: options.autoplay !== false, startAt: options.startAt || 0 });

  if (state.autoplay && state.index >= state.queue.length - 3) {
    extendQueueFromRadio();
  }

  if (state.mode === 'video' && options.navigate !== false) {
    navigate('video');
  } else if (options.view) {
    navigate(options.view);
  } else if (state.view === 'video') {
    updateVideoStage();
  }
}

function playAtQueueIndex(index) {
  const track = state.queue[index];
  if (!track) return;
  state.index = index;
  state.current = track;
  addRecent(track);
  syncPlayingUI();
  syncLikeUI();
  refreshQueueViews();
  updateMediaSession();
  startMedia(track, { autoplay: true });
  if (state.autoplay && state.index >= state.queue.length - 3) extendQueueFromRadio();
}

function togglePlay() {
  if (!state.current) {
    const fallback = state.heroTrack || state.liked[0] || state.queue[0];
    if (fallback) {
      playTrack(fallback, { listId: state.heroTrack ? state.heroListId : 'liked' });
    } else {
      toast('Pick a song to start listening.', 'info');
    }
    return;
  }

  if (media.paused || media.ended) {
    if (media.ended) media.currentTime = 0;
    const promise = media.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {
        toast('Playback was blocked by the browser. Try again.', 'error');
      });
    }
  } else {
    media.pause();
  }
}

async function extendQueueFromRadio(force = false) {
  const track = state.current;
  if (!track || !state.autoplay) return false;
  if (radioFetched.has(String(track.id)) && !force) return false;
  radioFetched.add(String(track.id));

  try {
    const params = new URLSearchParams({
      id: track.id,
      title: track.title,
      artist: track.artist,
      limit: '20',
    });
    const data = await api(`/api/related?${params.toString()}`);
    const related = sanitizeTracks(data.playlist || []);
    const existing = new Set(state.queue.map((item) => String(item.id)));
    const additions = related.filter((item) => !existing.has(String(item.id)));
    if (additions.length === 0) return false;
    state.queue.push(...additions);
    registerTracks(additions);
    registerList('queue', state.queue);
    refreshQueueViews();
    return true;
  } catch (err) {
    radioFetched.delete(String(track.id));
    return false;
  }
}

function playNext(options = {}) {
  const auto = Boolean(options.auto);
  if (!state.queue.length) return;

  if (state.shuffle) {
    if (state.queue.length === 1) {
      media.currentTime = 0;
      media.play().catch(() => {});
      return;
    }
    let next = state.index;
    while (next === state.index) next = Math.floor(Math.random() * state.queue.length);
    playAtQueueIndex(next);
    return;
  }

  const next = state.index + 1;
  if (next >= state.queue.length) {
    if (auto && state.repeat === 'off') return;
    playAtQueueIndex(0);
    return;
  }
  playAtQueueIndex(next);
}

function playPrev() {
  if (!state.queue.length) return;
  if (media.currentTime > 3) {
    media.currentTime = 0;
    updateProgressUI();
    return;
  }

  if (state.shuffle) {
    playAtQueueIndex(Math.floor(Math.random() * state.queue.length));
    return;
  }

  const prev = state.index - 1 < 0 ? state.queue.length - 1 : state.index - 1;
  playAtQueueIndex(prev);
}

async function handleTrackEnded() {
  if (state.repeat === 'one') {
    media.currentTime = 0;
    media.play().catch(() => {});
    return;
  }

  if (state.shuffle) {
    playNext({ auto: true });
    return;
  }

  if (state.index < state.queue.length - 1) {
    playNext({ auto: true });
    return;
  }

  if (state.autoplay) {
    const added = await extendQueueFromRadio(true);
    if (added && state.index < state.queue.length - 1) {
      playNext({ auto: true });
      return;
    }
  }

  if (state.repeat === 'all' && state.queue.length > 1) {
    playAtQueueIndex(0);
    return;
  }

  state.playing = false;
  syncPlayingUI();
  updateVideoStage();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function seekToFraction(fraction) {
  const duration = getDuration();
  if (!duration) return;
  const value = Math.min(1, Math.max(0, Number(fraction) || 0));
  media.currentTime = value * duration;
  updateProgressUI();
}

function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  syncPlayingUI();
  toast(
    state.repeat === 'off' ? 'Repeat off' : state.repeat === 'all' ? 'Repeat queue' : 'Repeat this track',
    'info'
  );
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  syncPlayingUI();
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off', 'info');
}

function setMode(mode, options = {}) {
  const next = mode === 'video' ? 'video' : 'audio';
  if (next === state.mode) {
    if (next === 'video' && options.navigate !== false) navigate('video');
    return;
  }

  const time = Number(media.currentTime) || 0;
  const wasPlaying = !media.paused && !media.ended;
  state.mode = next;
  savePrefs();

  moveMediaElement();
  updateModeUI();
  syncPlayingUI();

  if (state.current) {
    startMedia(state.current, { autoplay: wasPlaying, startAt: time });
  }

  if (next === 'video' && options.navigate !== false) navigate('video');
  if (options.toast) toast(next === 'video' ? 'Video mode' : 'Audio mode', 'info');
}

function toggleMode() {
  const next = state.mode === 'video' ? 'audio' : 'video';
  setMode(next, { navigate: next === 'video', toast: true });
  if (next === 'audio' && state.view === 'video') navigate('home');
}

/* -------------------------------------------------------------------------- */
/* Navigation and view loaders                                                */
/* -------------------------------------------------------------------------- */

const VIEWS = ['home', 'search', 'explore', 'liked', 'downloads', 'playlist', 'video'];

function setActiveNav(view) {
  document.querySelectorAll('.side-link').forEach((link) => {
    const nav = link.dataset.nav;
    const active =
      (view === 'home' && nav === 'home') ||
      (view === 'search' && nav === 'search') ||
      (view === 'explore' && nav === 'explore') ||
      (view === 'video' && nav === 'video') ||
      (view === 'liked' && nav === 'liked') ||
      (view === 'downloads' && nav === 'downloads');
    link.classList.toggle('is-active', active);
  });
  document.querySelectorAll('.playlist-item').forEach((item) => {
    item.classList.toggle('is-active', view === 'playlist' && item.dataset.playlistId === state.currentPlaylist);
  });
}

function navigate(view, options = {}) {
  const target = VIEWS.includes(view) ? view : 'home';
  state.view = target;

  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.view === target);
  });

  if (target === 'video' && state.current && state.mode !== 'video') {
    setMode('video', { navigate: false });
  }

  setActiveNav(target);
  closeContextMenu();
  hideSuggestions();
  ui.sidebar.classList.remove('is-open');

  if (!options.keepDrawers) {
    closeQueueDrawer();
    closeLyricsDrawer();
  }

  if (target === 'home' && state.homeShelves.length === 0 && !state.homeLoading) {
    loadHome();
  }

  if (target === 'explore') {
    if (state.genres.length === 0 && !state.homeLoading) loadHome();
    else renderGenres(ui.genreGrid, state.genres, false);
  }

  if (target === 'search') {
    renderRecentSearches();
    if (state.searchQuery) renderSearchResults();
    else showSearchIntro();
    if (options.focus) {
      setTimeout(() => ui.searchInput.focus(), 60);
    }
  }

  if (target === 'liked') renderLiked();
  if (target === 'downloads') renderDownloads();
  if (target === 'playlist') renderPlaylist();
  if (target === 'video') updateVideoStage();

  $('views').scrollTop = 0;
}

/* -------------------------------------------------------------------------- */
/* Home                                                                       */
/* -------------------------------------------------------------------------- */

async function loadHome() {
  if (state.homeLoading) return;
  state.homeLoading = true;

  try {
    const data = await api('/api/home');
    state.genres = Array.isArray(data.genres) ? data.genres : [];
    state.homeShelves = (Array.isArray(data.shelves) ? data.shelves : [])
      .map((shelf) => ({
        id: String(shelf.id || shelf.title || Math.random().toString(36).slice(2)),
        title: String(shelf.title || 'Made for you'),
        subtitle: String(shelf.subtitle || ''),
        query: String(shelf.query || ''),
        accent: String(shelf.accent || '#25e07c'),
        tracks: sanitizeTracks(shelf.tracks),
      }))
      .filter((shelf) => shelf.tracks.length > 0);

    state.curated = state.homeShelves.map((shelf) => ({
      id: `curated:${shelf.id}`,
      name: shelf.title,
      subtitle: shelf.subtitle,
      accent: shelf.accent,
      tracks: shelf.tracks,
      curated: true,
    }));

    renderShelves(state.homeShelves);
    renderPlaylistSidebar();
    renderGenres(ui.homeGenres, state.genres, true);
    if (state.view === 'explore') renderGenres(ui.genreGrid, state.genres, false);
    if (state.view === 'playlist') renderPlaylist();

    const hero = pickHeroTrack(state.homeShelves);
    if (hero) {
      renderHero(hero.track, `shelf:${hero.shelf.id}`);
    } else {
      renderHero(null, null);
    }
  } catch (err) {
    renderShelves([]);
    toast(err.message || 'Could not load the home feed.', 'error');
  } finally {
    state.homeLoading = false;
  }
}

function pickHeroTrack(shelves) {
  const MIN_SECONDS = 120;
  const MAX_SECONDS = 600;
  const candidates = [];
  for (const shelf of shelves) {
    for (const track of shelf.tracks) {
      const seconds = Number(track.seconds);
      if (Number.isFinite(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS) {
        candidates.push({ track, shelf });
      }
    }
  }
  const preferred = candidates.find((entry) => entry.shelf === shelves[0]);
  if (preferred) return preferred;
  if (candidates.length) return candidates[0];
  const first = shelves.find((shelf) => shelf.tracks.length);
  return first ? { track: first.tracks[0], shelf: first } : null;
}

function handleShelfPlay(shelfId) {
  const shelf = state.homeShelves.find((item) => item.id === shelfId);
  if (!shelf || shelf.tracks.length === 0) return;
  playTrack(shelf.tracks[0], { listId: `shelf:${shelf.id}` });
}

function handleShelfMore(shelfId) {
  const shelf = state.homeShelves.find((item) => item.id === shelfId);
  if (!shelf) return;
  performSearch(shelf.query || shelf.title, shelf.title);
}

function handleGenre(genreId) {
  const genre = state.genres.find((item) => item.id === genreId);
  if (!genre) return;
  ui.searchInput.value = genre.name;
  performSearch(genre.query || genre.name, genre.name);
}

function heroTrackWithList() {
  return {
    track: state.heroTrack,
    listId: state.heroListId || (state.heroTrack ? `hero:${state.heroTrack.id}` : null),
  };
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

function showSearchIntro() {
  ui.searchResults.innerHTML = '';
  ui.searchResults.classList.add('card-grid');
  ui.searchResults.classList.remove('track-list');
  ui.searchMeta.textContent = '';
  ui.searchEmpty.hidden = false;
  const title = ui.searchEmpty.querySelector('h3');
  const copy = ui.searchEmpty.querySelector('p');
  if (title) title.textContent = 'Search for anything';
  if (copy) copy.textContent = 'Try a song name, an artist, a mood, or a movie soundtrack.';
  ui.searchSubtitle.textContent = 'Search millions of tracks, artists, and videos.';
  renderRecentSearches();
}

function libraryTracks() {
  const map = new Map();
  const push = (track) => {
    if (track && track.id && !map.has(String(track.id))) map.set(String(track.id), track);
  };
  state.liked.forEach(push);
  state.playlists.forEach((playlist) => playlist.tracks.forEach(push));
  state.recent.forEach(push);
  return Array.from(map.values());
}

function filterSearchResults() {
  const all = state.searchResults;
  if (state.searchTab === 'songs') {
    return all.filter((track) => !track.seconds || track.seconds <= 900);
  }
  if (state.searchTab === 'videos') {
    return all
      .filter((track) => track.video !== false)
      .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
  }
  if (state.searchTab === 'library') {
    const query = state.searchQuery.toLowerCase().trim();
    const list = libraryTracks();
    if (!query) return list;
    return list.filter((track) => `${track.title} ${track.artist}`.toLowerCase().includes(query));
  }
  return all;
}

function renderSearchResults() {
  const tab = state.searchTab;
  const tracks = filterSearchResults();

  ui.searchTabs.querySelectorAll('.search-tab').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  });

  ui.searchResults.classList.toggle('track-list', tab === 'library');
  ui.searchResults.classList.toggle('card-grid', tab !== 'library');

  const listId = `search:${tab}`;

  if (tracks.length === 0) {
    ui.searchResults.innerHTML = '';
    ui.searchEmpty.hidden = false;
    const title = ui.searchEmpty.querySelector('h3');
    const copy = ui.searchEmpty.querySelector('p');
    if (state.searchTab === 'videos') {
      if (title) title.textContent = 'No videos found';
      if (copy) copy.textContent = 'Try a different song name or artist.';
    } else if (state.searchTab === 'songs') {
      if (title) title.textContent = 'No songs found';
      if (copy) copy.textContent = 'Try a different spelling or search for an artist.';
    } else if (state.searchTab === 'library') {
      if (title) title.textContent = 'Nothing in your library matches';
      if (copy) copy.textContent = 'Like songs or add them to playlists and they will show up here.';
    } else if (state.searchQuery) {
      if (title) title.textContent = 'No matches found';
      if (copy) copy.textContent = 'Try another song name, artist, or mood.';
    }
  } else {
    ui.searchEmpty.hidden = true;
    if (tab === 'library') {
      renderRows(ui.searchResults, tracks, listId);
    } else {
      renderCardGrid(ui.searchResults, tracks, listId);
    }
  }

  const label = state.searchLabel || state.searchQuery;
  ui.searchMeta.textContent = state.searchQuery
    ? `${tracks.length} ${tracks.length === 1 ? 'result' : 'results'} for “${label}”`
    : `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} in your library`;
}

async function performSearch(query, label) {
  const clean = String(query || '').trim();
  if (!clean) {
    state.searchQuery = '';
    state.searchLabel = '';
    state.searchResults = [];
    showSearchIntro();
    return;
  }

  state.searchQuery = clean;
  state.searchLabel = String(label || clean).trim() || clean;
  state.searchLoading = true;
  ui.searchInput.value = state.searchLabel;
  ui.searchClear.hidden = false;

  if (state.view !== 'search') navigate('search');
  rememberSearch(clean, state.searchLabel);

  ui.searchSubtitle.textContent = `Searching for “${state.searchLabel}”...`;
  ui.searchMeta.textContent = 'Searching the catalogue...';
  ui.searchResults.innerHTML = '';
  ui.searchEmpty.hidden = true;

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(clean)}&limit=40`);
    state.searchResults = sanitizeTracks(data.results || []);
    state.searchLoading = false;
    ui.searchSubtitle.textContent = `Results for “${state.searchLabel}”`;
    renderSearchResults();
  } catch (err) {
    state.searchLoading = false;
    state.searchResults = [];
    ui.searchSubtitle.textContent = `Could not load “${state.searchLabel}”`;
    ui.searchMeta.textContent = '';
    ui.searchResults.innerHTML = '';
    ui.searchEmpty.hidden = false;
    const title = ui.searchEmpty.querySelector('h3');
    const copy = ui.searchEmpty.querySelector('p');
    if (title) title.textContent = 'Search is unavailable';
    if (copy) copy.textContent = err.message || 'Check your connection and try again.';
    toast(err.message || 'Search failed.', 'error');
  }

  renderRecentSearches();
}

function handleSearchInput() {
  const value = ui.searchInput.value;
  ui.searchClear.hidden = !value;

  clearTimeout(searchTimer);
  clearTimeout(suggestTimer);

  if (!value.trim()) {
    hideSuggestions();
    state.searchQuery = '';
    state.searchLabel = '';
    state.searchResults = [];
    if (state.view === 'search') showSearchIntro();
    return;
  }

  if (value.trim().length >= 2) {
    suggestTimer = setTimeout(() => fetchSuggestions(value.trim()), 240);
  } else {
    hideSuggestions();
  }

  searchTimer = setTimeout(() => {
    if (value.trim().length >= 2 && state.view === 'search') {
      performSearch(value.trim());
    }
  }, 650);
}

async function fetchSuggestions(query) {
  try {
    const data = await api(`/api/suggestions?q=${encodeURIComponent(query)}`);
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 7) : [];
    if (!suggestions.length || ui.searchInput.value.trim() !== query) {
      hideSuggestions();
      return;
    }
    ui.suggestions.innerHTML = suggestions
      .map(
        (text) => `
        <button class="suggestion" data-action="suggestion" data-query="${esc(text)}">
          <i class="fa-solid fa-magnifying-glass"></i>
          <span>${esc(text)}</span>
        </button>`
      )
      .join('');
    ui.suggestions.hidden = false;
  } catch (err) {
    hideSuggestions();
  }
}

function hideSuggestions() {
  ui.suggestions.hidden = true;
  ui.suggestions.innerHTML = '';
}

function clearSearch() {
  ui.searchInput.value = '';
  ui.searchClear.hidden = true;
  hideSuggestions();
  state.searchQuery = '';
  state.searchLabel = '';
  state.searchResults = [];
  showSearchIntro();
  ui.searchInput.focus();
}

function clearRecentSearches() {
  state.searches = [];
  saveSearches();
  renderRecentSearches();
  toast('Recent searches cleared.', 'info');
}

/* -------------------------------------------------------------------------- */
/* Playback entry points used by renderers                                    */
/* -------------------------------------------------------------------------- */

function findTrackInList(trackId, listId) {
  const direct = getTrack(trackId);
  if (direct) return direct;
  return getList(listId).find((item) => String(item.id) === String(trackId)) || null;
}

function requestPlay(trackId, listId, options = {}) {
  const track = findTrackInList(trackId, listId);
  if (!track) return;

  const sameCurrent = state.current && String(state.current.id) === String(track.id);
  if (sameCurrent && options.toggle !== false) {
    togglePlay();
    return;
  }
  playTrack(track, { listId, mode: options.mode, navigate: options.navigate });
}

function toggleLike(trackOrId) {
  const track =
    typeof trackOrId === 'string'
      ? getTrack(trackOrId)
      : trackOrId && typeof trackOrId === 'object'
        ? sanitizeTrack(trackOrId)
        : state.current;

  if (!track || !track.id) return;
  const existing = state.liked.findIndex((item) => String(item.id) === String(track.id));
  if (existing >= 0) {
    state.liked.splice(existing, 1);
    toast('Removed from liked songs.', 'info');
  } else {
    state.liked.unshift(track);
    toast('Added to liked songs.');
  }
  saveLiked();
  syncLikeUI();
  if (state.view === 'liked') renderLiked();
  if (state.view === 'search' && state.searchTab === 'library') renderSearchResults();
}

/* -------------------------------------------------------------------------- */
/* Liked songs                                                                */
/* -------------------------------------------------------------------------- */

function renderLiked() {
  syncLikeUI();
  const tracks = state.liked;
  const hasTracks = tracks.length > 0;
  ui.likedEmpty.hidden = hasTracks;
  ui.likedList.hidden = !hasTracks;
  if (hasTracks) {
    renderRows(ui.likedList, tracks, 'liked');
  } else {
    ui.likedList.innerHTML = '';
  }
}

function playLiked(shuffle) {
  if (!state.liked.length) {
    toast('Like a few songs first.', 'info');
    return;
  }
  if (shuffle) {
    const shuffled = state.liked.slice().sort(() => Math.random() - 0.5);
    registerList('liked:shuffle', shuffled);
    playTrack(shuffled[0], { listId: 'liked:shuffle' });
  } else {
    playTrack(state.liked[0], { listId: 'liked' });
  }
}

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

function downloadTracks() {
  const map = new Map();
  for (const entry of state.downloads) {
    const track =
      entry.track ||
      sanitizeTrack({
        id: entry.trackId,
        title: entry.title,
        artist: entry.artist,
        duration: entry.duration,
        seconds: entry.seconds,
        thumbnail: entry.thumbnail,
      });
    if (track && !map.has(String(track.id))) {
      trackStore.set(String(track.id), track);
      map.set(String(track.id), track);
    }
  }
  return Array.from(map.values());
}

function renderDownloads() {
  const count = state.downloads.length;
  const audio = state.downloads.filter((entry) => entry.type === 'audio').length;
  const video = count - audio;
  ui.downloadsSubtitle.textContent = count
    ? `${count} saved ${count === 1 ? 'download' : 'downloads'} • ${audio} audio • ${video} video`
    : 'Your recent audio and video downloads.';

  ui.downloadsEmpty.hidden = count > 0;
  ui.downloadsList.hidden = count === 0;

  if (count === 0) {
    ui.downloadsList.innerHTML = '';
    return;
  }

  registerList('downloads', downloadTracks());
  ui.downloadsList.innerHTML = state.downloads.map((entry, index) => downloadRowHTML(entry, index)).join('');
}

function addDownloadHistory(track, type) {
  const entry = {
    key: `${track.id}:${type}`,
    trackId: String(track.id),
    title: track.title,
    artist: track.artist,
    duration: track.duration || formatTime(track.seconds),
    seconds: Number(track.seconds) || 0,
    thumbnail: track.thumbnail || '',
    type,
    at: Date.now(),
    track,
  };
  state.downloads = [entry, ...state.downloads.filter((item) => item.key !== entry.key)].slice(0, 100);
  saveDownloads();
  if (state.view === 'downloads') renderDownloads();
}

function downloadTrack(trackOrId, type = 'audio') {
  const track = typeof trackOrId === 'string' ? getTrack(trackOrId) : sanitizeTrack(trackOrId);
  if (!track || !track.id) {
    toast('That track is not available for download.', 'error');
    return;
  }

  const params = new URLSearchParams({
    id: track.id,
    type: type === 'video' ? 'video' : 'audio',
    title: track.title,
    artist: track.artist,
  });

  const anchor = document.createElement('a');
  anchor.href = `/api/download?${params.toString()}`;
  anchor.download = '';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  addDownloadHistory(track, type === 'video' ? 'video' : 'audio');
  toast(
    `Preparing ${type === 'video' ? 'video' : 'audio'} download. It may take a few seconds.`,
    'info'
  );
}

function removeDownload(key) {
  const before = state.downloads.length;
  state.downloads = state.downloads.filter((entry) => entry.key !== key);
  if (state.downloads.length === before) return;
  saveDownloads();
  renderDownloads();
  toast('Removed from download history.', 'info');
}

function clearDownloads() {
  if (!state.downloads.length) return;
  openConfirm({
    title: 'Clear download history?',
    message: 'This only clears the list in Resona. Files already saved by your browser stay on your device.',
    confirmLabel: 'Clear history',
    danger: true,
    onConfirm: () => {
      state.downloads = [];
      saveDownloads();
      renderDownloads();
      toast('Download history cleared.', 'info');
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Playlists                                                                  */
/* -------------------------------------------------------------------------- */

function findPlaylist(id) {
  return (
    state.playlists.find((playlist) => playlist.id === id) ||
    state.curated.find((playlist) => playlist.id === id) ||
    null
  );
}

function createPlaylist(name, tracks = []) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) return null;
  const playlist = {
    id: `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    createdAt: Date.now(),
    tracks: sanitizeTracks(tracks),
  };
  state.playlists.unshift(playlist);
  savePlaylists();
  renderPlaylistSidebar();
  return playlist;
}

function openPlaylist(id) {
  state.currentPlaylist = id;
  renderPlaylistSidebar();
  navigate('playlist');
}

function renderPlaylist() {
  const playlist = findPlaylist(state.currentPlaylist);
  if (!playlist) {
    const fallback = state.curated[0] || state.playlists[0];
    if (fallback) {
      state.currentPlaylist = fallback.id;
      return renderPlaylist();
    }
    state.currentPlaylist = null;
    navigate('home');
    return;
  }

  state.currentPlaylist = playlist.id;
  renderPlaylistSidebar();

  const totalSeconds = playlist.tracks.reduce((sum, track) => sum + (Number(track.seconds) || 0), 0);
  const meta = [`${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}`];
  if (playlist.tracks.length) meta.push(formatMinutes(totalSeconds));
  if (playlist.curated) meta.push('Curated by Resona');

  ui.playlistTitle.textContent = playlist.name;
  ui.playlistSubtitle.textContent = meta.join(' • ');
  ui.playlistRename.hidden = Boolean(playlist.curated);
  ui.playlistDelete.hidden = Boolean(playlist.curated);

  const cover = playlist.tracks[0];
  ui.playlistArt.innerHTML = cover
    ? `<img src="${thumbFor(cover, 'max')}" alt="">`
    : '<i class="fa-solid fa-list-music"></i>';

  const hasTracks = playlist.tracks.length > 0;
  ui.playlistEmpty.hidden = hasTracks;
  ui.playlistTracks.hidden = !hasTracks;

  if (hasTracks) {
    renderRows(ui.playlistTracks, playlist.tracks, `playlist:${playlist.id}`, { playlistId: playlist.id });
  } else {
    ui.playlistTracks.innerHTML = '';
  }
}

function addTrackToPlaylist(playlistId, track) {
  const playlist = findPlaylist(playlistId);
  if (!playlist || !track) return;
  if (playlist.tracks.some((item) => String(item.id) === String(track.id))) {
    toast('Already in this playlist.', 'info');
    return;
  }
  playlist.tracks.push(sanitizeTrack(track) || track);
  savePlaylists();
  renderPlaylistSidebar();
  if (state.view === 'playlist' && state.currentPlaylist === playlistId) renderPlaylist();
  toast(`Added to ${playlist.name}.`);
}

function removeTrackFromPlaylist(playlistId, trackId) {
  const playlist = findPlaylist(playlistId);
  if (!playlist) return;
  const before = playlist.tracks.length;
  playlist.tracks = playlist.tracks.filter((track) => String(track.id) !== String(trackId));
  if (playlist.tracks.length === before) return;
  savePlaylists();
  renderPlaylistSidebar();
  if (state.view === 'playlist' && state.currentPlaylist === playlistId) renderPlaylist();
  if (state.view === 'search' && state.searchTab === 'library') renderSearchResults();
  toast('Removed from playlist.', 'info');
}

function deletePlaylist(playlistId) {
  const playlist = findPlaylist(playlistId);
  if (!playlist || playlist.curated) return;
  openConfirm({
    title: `Delete “${playlist.name}”?`,
    message: 'The playlist will be removed from your library. The songs themselves are not affected.',
    confirmLabel: 'Delete playlist',
    danger: true,
    onConfirm: () => {
      state.playlists = state.playlists.filter((item) => item.id !== playlistId);
      savePlaylists();
      renderPlaylistSidebar();
      state.currentPlaylist = state.playlists.length ? state.playlists[0].id : null;
      navigate(state.playlists.length ? 'playlist' : 'home');
      toast('Playlist deleted.', 'info');
    },
  });
}

function playPlaylist(shuffle) {
  const playlist = findPlaylist(state.currentPlaylist);
  if (!playlist || !playlist.tracks.length) {
    toast('Add some songs to this playlist first.', 'info');
    return;
  }
  if (shuffle) {
    const shuffled = playlist.tracks.slice().sort(() => Math.random() - 0.5);
    const tempId = `playlist:${playlist.id}:shuffle`;
    registerList(tempId, shuffled);
    playTrack(shuffled[0], { listId: tempId });
  } else {
    playTrack(playlist.tracks[0], { listId: `playlist:${playlist.id}` });
  }
}

/* -------------------------------------------------------------------------- */
/* Queue helpers                                                              */
/* -------------------------------------------------------------------------- */

function queueTrack(track, next = false) {
  if (!track) return;
  if (!state.current) {
    playTrack(track);
    return;
  }
  const clean = sanitizeTrack(track) || track;
  if (next) {
    const at = state.index >= 0 ? state.index + 1 : state.queue.length;
    state.queue.splice(at, 0, clean);
  } else {
    state.queue.push(clean);
  }
  registerTracks([clean]);
  registerList('queue', state.queue);
  refreshQueueViews();
  toast(next ? 'Playing next.' : 'Added to queue.', 'info');
}

function clearQueue() {
  if (state.current) {
    state.queue = [state.current];
    state.index = 0;
  } else {
    state.queue = [];
    state.index = -1;
  }
  refreshQueueViews();
  toast('Queue cleared.', 'info');
}

function watchTrack(track, listId) {
  if (!track) return;
  playTrack(track, { listId, mode: 'video', navigate: true });
}

/* -------------------------------------------------------------------------- */
/* Lyrics                                                                     */
/* -------------------------------------------------------------------------- */

function parseSyncedLyrics(text) {
  const rows = [];
  const source = String(text || '');
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine) continue;
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const content = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(String(stamp[2]).replace(':', '.'));
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      rows.push({ time: minutes * 60 + seconds, text: content || '♪' });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

function lyricsPanelHTML() {
  const track = state.current;
  if (!track) {
    return `<div class="lyrics-empty"><i class="fa-solid fa-microphone-lines"></i><span>Play a song to see its lyrics.</span></div>`;
  }

  if (state.lyricsLoading && state.lyricsFor === String(track.id)) {
    return `<div class="lyrics-empty"><span class="spinner"></span><span>Loading lyrics...</span></div>`;
  }

  const lyrics = state.lyrics;
  if (!lyrics || state.lyricsFor !== String(track.id)) {
    return `<div class="lyrics-empty"><i class="fa-solid fa-microphone-lines"></i><span>Lyrics will appear here.</span></div>`;
  }

  if (!lyrics.found) {
    return `
      <div class="lyrics-empty">
        <i class="fa-solid fa-microphone-slash"></i>
        <span>${esc(lyrics.reason || 'No lyrics found for this track.')}</span>
        <span>It may be an instrumental, or not indexed yet.</span>
      </div>`;
  }

  if (lyrics.instrumental) {
    return `<div class="lyrics-empty"><i class="fa-solid fa-music"></i><span>This track is instrumental.</span></div>`;
  }

  if (lyrics.synced && lyrics.synced.length) {
    const lines = lyrics.synced
      .map(
        (line) =>
          `<div class="lyrics-line" data-time="${line.time}" role="button" tabindex="0">${esc(line.text)}</div>`
      )
      .join('');
    return `${lines}<div class="lyrics-source"><i class="fa-solid fa-microphone-lines"></i> Synced lyrics via LRCLIB</div>`;
  }

  if (lyrics.plain) {
    return `<div class="lyrics-plain">${esc(lyrics.plain)}</div><div class="lyrics-source"><i class="fa-solid fa-microphone-lines"></i> Lyrics via LRCLIB</div>`;
  }

  return `<div class="lyrics-empty"><i class="fa-solid fa-microphone-slash"></i><span>No lyrics found for this track.</span></div>`;
}

function bindLyricsClicks(root) {
  if (!root) return;
  root.querySelectorAll('.lyrics-line[data-time]').forEach((line) => {
    line.addEventListener('click', () => {
      const time = Number(line.dataset.time);
      if (!Number.isFinite(time)) return;
      if (!state.current) return;
      media.currentTime = time;
      updateProgressUI();
    });
  });
}

function updateLyricsHighlight(time, force = false) {
  const lyrics = state.lyrics;
  if (!lyrics || !lyrics.found || !Array.isArray(lyrics.synced) || !lyrics.synced.length) return;

  const containers = [ui.lyricsBody, ui.npPanel].filter(
    (container) => container && !container.closest('[hidden]')
  );

  for (const container of containers) {
    const lines = container.querySelectorAll('.lyrics-line[data-time]');
    if (!lines.length) continue;

    let active = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (Number(lines[i].dataset.time) <= time + 0.2) active = i;
      else break;
    }

    if (!force && container.dataset.activeIndex === String(active)) continue;
    container.dataset.activeIndex = String(active);

    lines.forEach((line, index) => {
      line.classList.toggle('is-active', index === active);
      line.classList.toggle('is-past', index < active);
    });

    const activeLine = lines[active];
    if (!activeLine || !activeLine.offsetParent) continue;

    const scroller = container.classList.contains('lyrics-body')
      ? container
      : container.querySelector('.lyrics-body') || container;

    const target = activeLine.offsetTop - scroller.clientHeight / 2 + activeLine.offsetHeight / 2;
    if (scroller.scrollHeight > scroller.clientHeight + 20) {
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
}

function renderLyricsViews() {
  const track = state.current;
  ui.lyricsTitle.textContent = track ? track.title : 'Lyrics';
  ui.lyricsArtist.textContent = track ? track.artist : 'Track artist';

  if (!ui.lyricsDrawer.hidden) {
    ui.lyricsBody.innerHTML = lyricsPanelHTML();
    bindLyricsClicks(ui.lyricsBody);
    ui.lyricsBody.dataset.activeIndex = '';
    updateLyricsHighlight(Number(media.currentTime) || 0, true);
  }

  if (!ui.nowPlaying.hidden && state.npTab === 'lyrics') {
    ui.npPanel.innerHTML = `<div class="lyrics-body">${lyricsPanelHTML()}</div>`;
    bindLyricsClicks(ui.npPanel);
    updateLyricsHighlight(Number(media.currentTime) || 0, true);
  }
}

async function loadLyrics(track = state.current, force = false) {
  if (!track || !track.id) return;
  const trackId = String(track.id);

  if (!force && state.lyricsFor === trackId && (state.lyrics || state.lyricsLoading)) return;

  state.lyricsFor = trackId;
  state.lyrics = null;
  state.lyricsLoading = true;
  renderLyricsViews();

  if (!force && lyricsCache.has(trackId)) {
    state.lyrics = lyricsCache.get(trackId);
    state.lyricsLoading = false;
    renderLyricsViews();
    return;
  }

  try {
    const params = new URLSearchParams({
      title: track.title,
      artist: track.artist,
      duration: String(Math.round(Number(track.seconds) || 0)),
    });
    const data = await api(`/api/lyrics?${params.toString()}`);
    if (state.lyricsFor !== trackId) return;

    const synced = parseSyncedLyrics(data.synced || '');
    const result = {
      found: true,
      synced,
      plain: String(data.plain || ''),
      instrumental: Boolean(data.instrumental),
      trackName: data.trackName || track.title,
      artistName: data.artistName || track.artist,
    };
    lyricsCache.set(trackId, result);
    state.lyrics = result;
  } catch (err) {
    if (state.lyricsFor !== trackId) return;
    const result = {
      found: false,
      synced: [],
      plain: '',
      instrumental: false,
      reason: err.message || 'No lyrics found for this track.',
    };
    lyricsCache.set(trackId, result);
    state.lyrics = result;
  } finally {
    if (state.lyricsFor === trackId) {
      state.lyricsLoading = false;
      renderLyricsViews();
    }
  }
}

function openLyricsDrawer() {
  if (!state.current) {
    toast('Play a song to see its lyrics.', 'info');
    return;
  }
  closeQueueDrawer();
  closeContextMenu();
  ui.lyricsDrawer.hidden = false;
  renderLyricsViews();
  loadLyrics(state.current);
}

function closeLyricsDrawer() {
  ui.lyricsDrawer.hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Now playing overlay                                                        */
/* -------------------------------------------------------------------------- */

function openNowPlaying() {
  if (!state.current) {
    toast('Play a song to open the player.', 'info');
    return;
  }
  ui.nowPlaying.hidden = false;
  syncPlayingUI();
  syncLikeUI();
  renderNowPlayingPanel();
  updateLyricsHighlight(Number(media.currentTime) || 0, true);
  if (state.npTab === 'lyrics') loadLyrics(state.current);
}

function closeNowPlaying() {
  ui.nowPlaying.hidden = true;
}

function selectNpTab(tab) {
  state.npTab = ['queue', 'lyrics', 'details'].includes(tab) ? tab : 'queue';
  ui.npTabs.querySelectorAll('.np-tab').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.npTab === state.npTab);
  });
  renderNowPlayingPanel();
  if (state.npTab === 'lyrics' && state.current) loadLyrics(state.current);
}

/* -------------------------------------------------------------------------- */
/* Drawers                                                                    */
/* -------------------------------------------------------------------------- */

function openQueueDrawer() {
  closeLyricsDrawer();
  closeContextMenu();
  ui.queueDrawer.hidden = false;
  renderQueueDrawer();
  setTimeout(() => {
    const active = ui.queueNow.querySelector('.is-playing') || ui.queueNow.firstElementChild;
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 60);
}

function closeQueueDrawer() {
  ui.queueDrawer.hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Context menu                                                               */
/* -------------------------------------------------------------------------- */

function openContextMenu(track, x, y, options = {}) {
  if (!track) return;
  closeContextMenu();

  const liked = isLiked(track.id);
  const items = [
    { action: 'play', icon: 'fa-play', label: 'Play now' },
    { action: 'next', icon: 'fa-forward-step', label: 'Play next' },
    { action: 'queue', icon: 'fa-list', label: 'Add to queue' },
    { sep: true },
    {
      action: 'like',
      icon: liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart',
      label: liked ? 'Remove from liked songs' : 'Like song',
    },
    { action: 'playlist', icon: 'fa-plus', label: 'Add to playlist' },
    { sep: true },
    { action: 'video', icon: 'fa-film', label: 'Watch video' },
    { action: 'download-audio', icon: 'fa-download', label: 'Download audio' },
    { action: 'download-video', icon: 'fa-file-video', label: 'Download video' },
  ];

  if (options.playlistId) {
    items.push({ sep: true });
    items.push({ action: 'remove-playlist', icon: 'fa-list-music', label: 'Remove from playlist', danger: true });
  }
  if (options.downloadKey) {
    items.push({ sep: true });
    items.push({ action: 'remove-download', icon: 'fa-trash', label: 'Remove from history', danger: true });
  }

  ui.contextMenu.innerHTML = items
    .map((item) => {
      if (item.sep) return '<div class="menu-sep"></div>';
      return `<button class="menu-item${item.danger ? ' danger' : ''}" data-menu-action="${esc(item.action)}">
        <i class="${item.icon.includes('fa-regular') ? item.icon : `fa-solid ${item.icon}`}"></i>
        <span>${esc(item.label)}</span>
      </button>`;
    })
    .join('');

  menuState = { track, options };
  ui.contextMenu.hidden = false;

  const rect = ui.contextMenu.getBoundingClientRect();
  const pad = 12;
  const maxLeft = window.innerWidth - rect.width - pad;
  const maxTop = window.innerHeight - rect.height - pad;
  const left = Math.min(maxLeft, Math.max(pad, Number(x) || window.innerWidth / 2 - rect.width / 2));
  const top = Math.min(maxTop, Math.max(pad, Number(y) || window.innerHeight / 2 - rect.height / 2));
  ui.contextMenu.style.left = `${left}px`;
  ui.contextMenu.style.top = `${top}px`;

  ui.contextMenu.querySelectorAll('[data-menu-action]').forEach((button) => {
    button.addEventListener('click', () => performMenuAction(button.dataset.menuAction));
  });
}

function closeContextMenu() {
  ui.contextMenu.hidden = true;
  ui.contextMenu.innerHTML = '';
  ui.contextMenu.style.left = '';
  ui.contextMenu.style.top = '';
  menuState = null;
}

function performMenuAction(action) {
  const ctx = menuState;
  if (!ctx) return;
  const track = ctx.track;
  const options = ctx.options || {};
  closeContextMenu();

  switch (action) {
    case 'play':
      requestPlay(track.id, options.listId);
      break;
    case 'next':
      queueTrack(track, true);
      break;
    case 'queue':
      queueTrack(track, false);
      break;
    case 'like':
      toggleLike(track);
      break;
    case 'playlist':
      openAddToPlaylist(track);
      break;
    case 'video':
      watchTrack(track, options.listId);
      break;
    case 'download-audio':
      downloadTrack(track, 'audio');
      break;
    case 'download-video':
      downloadTrack(track, 'video');
      break;
    case 'remove-playlist':
      if (options.playlistId) removeTrackFromPlaylist(options.playlistId, track.id);
      break;
    case 'remove-download':
      if (options.downloadKey) removeDownload(options.downloadKey);
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Modals                                                                     */
/* -------------------------------------------------------------------------- */

function openModal(html) {
  ui.modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  ui.modalRoot.hidden = false;
  ui.modalRoot.querySelectorAll('[data-modal-close]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  setTimeout(() => {
    const input = ui.modalRoot.querySelector('input');
    if (input) {
      input.focus();
      input.select();
    }
  }, 50);
}

function closeModal() {
  ui.modalRoot.hidden = true;
  ui.modalRoot.innerHTML = '';
}

function openConfirm(options) {
  const danger = Boolean(options.danger);
  openModal(`
    <h2>${esc(options.title || 'Are you sure?')}</h2>
    <p>${esc(options.message || '')}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-modal-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-confirm">${esc(options.confirmLabel || 'Confirm')}</button>
    </div>`);
  const confirm = $('modal-confirm');
  if (confirm) {
    confirm.addEventListener('click', () => {
      closeModal();
      if (typeof options.onConfirm === 'function') options.onConfirm();
    });
  }
}

function openCreatePlaylist(trackToAdd) {
  openModal(`
    <h2>New playlist</h2>
    <p>Give your playlist a name. You can add songs right after.</p>
    <input class="modal-input" id="modal-playlist-name" maxlength="80" placeholder="Late night favourites" autocomplete="off">
    <div class="modal-actions">
      <button class="btn btn-ghost" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="modal-create-confirm"><i class="fa-solid fa-plus"></i> Create playlist</button>
    </div>`);

  const input = $('modal-playlist-name');
  const submit = () => {
    const name = input ? input.value.trim() : '';
    if (!name) {
      toast('Enter a playlist name.', 'error');
      if (input) input.focus();
      return;
    }
    const playlist = createPlaylist(name, trackToAdd ? [trackToAdd] : []);
    if (!playlist) return;
    closeModal();
    if (trackToAdd) {
      toast(`Added to ${playlist.name}.`);
      if (state.view === 'playlist' && state.currentPlaylist === playlist.id) renderPlaylist();
    } else {
      openPlaylist(playlist.id);
      toast(`Playlist “${playlist.name}” created.`);
    }
  };

  $('modal-create-confirm').addEventListener('click', submit);
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }
}

function openImportPlaylist() {
  openModal(`
    <h2>Import Spotify playlist</h2>
    <p>Paste a public Spotify playlist link. Resona will match each song and build a playable playlist here.</p>
    <input class="modal-input" id="modal-spotify-url" maxlength="500"
      placeholder="https://open.spotify.com/playlist/..." autocomplete="off" spellcheck="false">
    <div class="import-status" id="modal-import-status" hidden>
      <span class="spinner"></span>
      <span id="modal-import-text">Reading playlist...</span>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="modal-import-confirm"><i class="fa-brands fa-spotify"></i> Import playlist</button>
    </div>`);

  const input = $('modal-spotify-url');
  const confirm = $('modal-import-confirm');
  const status = $('modal-import-status');
  const statusText = $('modal-import-text');

  const submit = async () => {
    const url = input ? input.value.trim() : '';
    if (!url) {
      toast('Paste a Spotify playlist link first.', 'error');
      if (input) input.focus();
      return;
    }

    confirm.disabled = true;
    input.disabled = true;
    status.hidden = false;
    statusText.textContent = 'Reading the playlist and matching songs...';

    try {
      const data = await api(`/api/import/spotify?url=${encodeURIComponent(url)}`);
      statusText.textContent = `Matched ${data.matched} of ${data.total} songs. Creating your playlist...`;
      const playlist = createPlaylist(data.name || 'Imported Spotify playlist', data.tracks);
      if (!playlist) throw new Error('Could not create the playlist.');

      closeModal();
      renderPlaylistSidebar();
      openPlaylist(playlist.id);
      const skipped = data.unmatched ? ` ${data.unmatched} could not be matched.` : '';
      toast(`Imported ${playlist.tracks.length} songs from “${data.name}”.${skipped}`);
    } catch (err) {
      statusText.textContent = err.message || 'Import failed. Try another public playlist.';
      confirm.disabled = false;
      input.disabled = false;
      toast(err.message || 'Could not import that playlist.', 'error');
    }
  };

  confirm.addEventListener('click', submit);
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }
}

function openRenamePlaylist(playlist) {
  if (!playlist || playlist.curated) return;
  openModal(`
    <h2>Rename playlist</h2>
    <p>Choose a new name for this playlist.</p>
    <input class="modal-input" id="modal-playlist-name" maxlength="80" value="${esc(playlist.name)}" autocomplete="off">
    <div class="modal-actions">
      <button class="btn btn-ghost" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="modal-rename-confirm">Save name</button>
    </div>`);

  const input = $('modal-playlist-name');
  const submit = () => {
    const name = input ? input.value.trim() : '';
    if (!name) {
      toast('Enter a playlist name.', 'error');
      if (input) input.focus();
      return;
    }
    playlist.name = name.slice(0, 80);
    savePlaylists();
    renderPlaylistSidebar();
    if (state.view === 'playlist') renderPlaylist();
    closeModal();
    toast('Playlist renamed.');
  };

  $('modal-rename-confirm').addEventListener('click', submit);
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }
}

function openAddToPlaylist(track) {
  if (!track) return;

  const list = state.playlists
    .map(
      (playlist) => `
      <button class="modal-list-item" data-playlist-id="${esc(playlist.id)}">
        <span class="playlist-thumb"><i class="fa-solid fa-list-music"></i></span>
        <span>${esc(playlist.name)}<small>${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}</small></span>
      </button>`
    )
    .join('');

  openModal(`
    <h2>Add to playlist</h2>
    <p>${esc(track.title)} • ${esc(track.artist)}</p>
    ${
      state.playlists.length
        ? `<div class="modal-list">${list}</div>`
        : `<div class="modal-list"><p>You do not have any playlists yet.</p></div>`
    }
    <div class="modal-actions">
      <button class="btn btn-ghost" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="modal-new-playlist"><i class="fa-solid fa-plus"></i> New playlist</button>
    </div>`);

  ui.modalRoot.querySelectorAll('[data-playlist-id]').forEach((button) => {
    button.addEventListener('click', () => {
      addTrackToPlaylist(button.dataset.playlistId, track);
      closeModal();
    });
  });

  const newButton = $('modal-new-playlist');
  if (newButton) {
    newButton.addEventListener('click', () => {
      closeModal();
      openCreatePlaylist(track);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Decorative visualizer                                                      */
/* -------------------------------------------------------------------------- */

const viz = {
  canvas: ui.visualizer,
  ctx: null,
  width: 0,
  height: 0,
  time: 0,
  last: 0,
};

function startVisualizer() {
  if (!viz.canvas) return;
  viz.ctx = viz.canvas.getContext('2d');
  if (!viz.ctx) return;

  const resize = () => {
    const rect = viz.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      viz.width = 0;
      viz.height = 0;
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    viz.canvas.width = Math.round(rect.width * dpr);
    viz.canvas.height = Math.round(rect.height * dpr);
    viz.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viz.width = rect.width;
    viz.height = rect.height;
  };

  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(viz.canvas);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();

  const draw = (timestamp) => {
    const dt = viz.last ? Math.min(0.05, (timestamp - viz.last) / 1000) : 0.016;
    viz.last = timestamp;
    viz.time += dt * (state.playing ? 1 : 0.25);

    requestAnimationFrame(draw);
    if (!viz.width || !viz.height) return;
    if (ui.nowPlaying.hidden) return;

    const ctx = viz.ctx;
    const w = viz.width;
    const h = viz.height;
    const cx = w / 2;
    const cy = h / 2;
    const unit = Math.min(w, h);
    const base = unit * 0.46;
    const bars = 112;

    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';

    for (let i = 0; i < bars; i += 1) {
      const angle = (Math.PI * 2 * i) / bars;
      const seed = Math.sin(i * 12.9898) * 43758.5453;
      const random = seed - Math.floor(seed);
      const wave = Math.sin(viz.time * 2.6 + i * 0.42) * 0.5 + 0.5;
      const energy = state.playing ? 0.18 + random * 0.5 + wave * 0.32 : 0.055;
      const inner = base;
      const outer = inner + unit * (0.014 + energy * 0.105);
      ctx.strokeStyle = `rgba(37, 224, 124, ${0.08 + energy * 0.5})`;
      ctx.lineWidth = i % 5 === 0 ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
  };

  requestAnimationFrame(draw);
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                               */
/* -------------------------------------------------------------------------- */

function seekBy(delta) {
  const duration = getDuration();
  if (!duration) return;
  media.currentTime = Math.min(duration, Math.max(0, (Number(media.currentTime) || 0) + delta));
  updateProgressUI();
}

function bindProgress(container) {
  if (!container) return;

  const seekFromEvent = (event) => {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    seekToFraction((event.clientX - rect.left) / rect.width);
  };

  container.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragProgress = container;
    container.classList.add('is-dragging');
    if (container.setPointerCapture) {
      try {
        container.setPointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
    seekFromEvent(event);
    event.preventDefault();
  });

  container.addEventListener('pointermove', (event) => {
    if (dragProgress !== container) return;
    seekFromEvent(event);
  });

  const endDrag = (event) => {
    if (dragProgress !== container) return;
    dragProgress = null;
    container.classList.remove('is-dragging');
    if (container.releasePointerCapture) {
      try {
        container.releasePointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
  };

  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  container.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBy(5);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekBy(-5);
    }
  });
}

function handleMediaError() {
  if (!state.current) return;
  state.loading = false;
  updateVideoStage();

  if (!state.retried) {
    state.retried = true;
    toast('Reconnecting to the stream...', 'info');
    startMedia(state.current, {
      autoplay: true,
      startAt: Number(media.currentTime) || 0,
      force: true,
      retry: true,
    });
    return;
  }

  state.playing = false;
  syncPlayingUI();
  toast('Playback failed. Try another track or switch between audio and video.', 'error');
}

function handleAction(actionEl, event) {
  const action = actionEl.dataset.action;
  const trackId = actionEl.dataset.trackId;
  const listId = actionEl.dataset.list;

  switch (action) {
    case 'play':
      event.stopPropagation();
      requestPlay(trackId, listId);
      return true;
    case 'like':
      event.stopPropagation();
      toggleLike(trackId);
      return true;
    case 'menu': {
      event.stopPropagation();
      const rect = actionEl.getBoundingClientRect();
      const track = getTrack(trackId) || findTrackInList(trackId, listId);
      openContextMenu(track, rect.right - 10, rect.bottom + 4, {
        listId,
        playlistId: actionEl.dataset.playlistId || '',
        downloadKey: actionEl.dataset.downloadKey || '',
      });
      return true;
    }
    case 'shelf-play':
      event.stopPropagation();
      handleShelfPlay(actionEl.dataset.shelfId);
      return true;
    case 'shelf-more':
      event.stopPropagation();
      handleShelfMore(actionEl.dataset.shelfId);
      return true;
    case 'genre':
      event.stopPropagation();
      handleGenre(actionEl.dataset.genreId);
      return true;
    case 'suggestion': {
      event.stopPropagation();
      const query = actionEl.dataset.query || '';
      ui.searchInput.value = query;
      hideSuggestions();
      performSearch(query);
      return true;
    }
    case 'recent-search':
      event.stopPropagation();
      performSearch(actionEl.dataset.query, actionEl.dataset.label);
      return true;
    case 'download':
      event.stopPropagation();
      downloadTrack(trackId, actionEl.dataset.type || 'audio');
      return true;
    case 'queue-play':
      event.stopPropagation();
      playAtQueueIndex(Number(actionEl.dataset.index));
      return true;
    default:
      return false;
  }
}

function bindEvents() {
  /* Delegated actions inside cards, rows and menus. */
  document.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && handleAction(actionEl, event)) return;

    if (event.target.closest('button, a, input, textarea, select, label')) return;

    const card = event.target.closest('.track-card[data-track-id]');
    if (card) {
      requestPlay(card.dataset.trackId, card.dataset.list);
      return;
    }

    const row = event.target.closest('.track-row[data-track-id]');
    if (row) {
      requestPlay(row.dataset.trackId, row.dataset.list);
    }
  });

  /* Sidebar + data-nav buttons. */
  document.addEventListener('click', (event) => {
    const navEl = event.target.closest('[data-nav]');
    if (!navEl) return;
    event.preventDefault();
    const view = navEl.dataset.nav;

    if (view === 'playlist') {
      const id = navEl.dataset.playlistId;
      if (id) openPlaylist(id);
      return;
    }
    if (view === 'search') {
      navigate('search', { focus: true });
      return;
    }
    if (VIEWS.includes(view)) navigate(view);
  });

  /* Dismiss popovers when clicking elsewhere. Capture phase avoids
     closing a menu that the same click is about to open. */
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('#context-menu')) closeContextMenu();
      if (!event.target.closest('#search-wrap')) hideSuggestions();
    },
    true
  );

  /* Search. */
  ui.searchInput.addEventListener('input', handleSearchInput);
  ui.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(searchTimer);
      clearTimeout(suggestTimer);
      hideSuggestions();
      performSearch(ui.searchInput.value);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });
  ui.searchInput.addEventListener('focus', () => {
    if (!ui.searchInput.value.trim() && state.view === 'search') renderRecentSearches();
  });
  ui.searchClear.addEventListener('click', clearSearch);
  ui.clearRecentSearches.addEventListener('click', clearRecentSearches);

  ui.searchTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.search-tab');
    if (!tab) return;
    state.searchTab = tab.dataset.tab || 'all';
    if (!state.searchQuery && state.searchTab !== 'library') {
      showSearchIntro();
      ui.searchTabs.querySelectorAll('.search-tab').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.tab === state.searchTab);
      });
      return;
    }
    renderSearchResults();
  });

  /* Hero. */
  ui.heroPlay.addEventListener('click', () => {
    if (!state.heroTrack) {
      toast('The home feed is still loading.', 'info');
      return;
    }
    playTrack(state.heroTrack, { listId: state.heroListId });
  });
  ui.heroVideo.addEventListener('click', () => {
    if (!state.heroTrack) return;
    playTrack(state.heroTrack, { listId: state.heroListId, mode: 'video', navigate: true });
  });
  ui.heroLike.addEventListener('click', () => {
    if (state.heroTrack) toggleLike(state.heroTrack);
    else toast('Pick a featured track first.', 'info');
  });

  /* Player transport. */
  ui.playBtn.addEventListener('click', togglePlay);
  ui.npPlay.addEventListener('click', togglePlay);
  ui.prevBtn.addEventListener('click', playPrev);
  ui.npPrev.addEventListener('click', playPrev);
  ui.nextBtn.addEventListener('click', playNext);
  ui.npNext.addEventListener('click', playNext);
  ui.shuffleBtn.addEventListener('click', toggleShuffle);
  ui.npShuffle.addEventListener('click', toggleShuffle);
  ui.repeatBtn.addEventListener('click', cycleRepeat);
  ui.npRepeat.addEventListener('click', cycleRepeat);
  ui.playerLike.addEventListener('click', () => {
    if (state.current) toggleLike(state.current);
  });
  ui.npLike.addEventListener('click', () => {
    if (state.current) toggleLike(state.current);
  });

  /* Volume. */
  ui.volumeSlider.addEventListener('input', (event) => setVolume(event.target.value));
  ui.npVolume.addEventListener('input', (event) => setVolume(event.target.value));
  ui.volumeBtn.addEventListener('click', toggleMute);
  ui.npMute.addEventListener('click', toggleMute);

  /* Mode. */
  ui.modeToggle.addEventListener('click', toggleMode);
  ui.videoBtn.addEventListener('click', toggleMode);
  ui.npVideo.addEventListener('click', () => {
    closeNowPlaying();
    if (state.mode === 'video') navigate('video');
    else setMode('video', { navigate: true, toast: true });
  });
  ui.videoAudioMode.addEventListener('click', () => {
    setMode('audio', { navigate: false, toast: true });
    navigate('home');
  });

  /* Downloads. */
  ui.topDownload.addEventListener('click', () => {
    if (state.current) downloadTrack(state.current, state.mode === 'video' ? 'video' : 'audio');
  });
  ui.videoDownload.addEventListener('click', () => {
    if (state.current) downloadTrack(state.current, 'video');
  });
  ui.npDownload.addEventListener('click', () => {
    if (state.current) downloadTrack(state.current, 'audio');
  });
  ui.npAdd.addEventListener('click', () => {
    if (state.current) openAddToPlaylist(state.current);
  });
  ui.clearDownloads.addEventListener('click', clearDownloads);

  /* Collections. */
  ui.likedPlay.addEventListener('click', () => playLiked(false));
  ui.likedShuffle.addEventListener('click', () => playLiked(true));
  ui.playlistPlay.addEventListener('click', () => playPlaylist(false));
  ui.playlistShuffle.addEventListener('click', () => playPlaylist(true));
  ui.playlistRename.addEventListener('click', () => {
    const playlist = findPlaylist(state.currentPlaylist);
    if (playlist) openRenamePlaylist(playlist);
  });
  ui.playlistDelete.addEventListener('click', () => {
    if (state.currentPlaylist) deletePlaylist(state.currentPlaylist);
  });
  ui.createPlaylistBtn.addEventListener('click', () => openCreatePlaylist(null));
  ui.importPlaylistBtn.addEventListener('click', openImportPlaylist);

  /* Overlay + drawers. */
  ui.playerExpand.addEventListener('click', openNowPlaying);
  ui.npClose.addEventListener('click', closeNowPlaying);
  ui.queueBtn.addEventListener('click', openQueueDrawer);
  ui.videoQueueOpen.addEventListener('click', openQueueDrawer);
  ui.queueClose.addEventListener('click', closeQueueDrawer);
  ui.queueClear.addEventListener('click', clearQueue);
  ui.lyricsBtn.addEventListener('click', openLyricsDrawer);
  ui.lyricsClose.addEventListener('click', closeLyricsDrawer);
  ui.npTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.np-tab');
    if (tab) selectNpTab(tab.dataset.npTab);
  });

  /* Autoplay radio switch. */
  ui.autoplaySwitch.addEventListener('click', () => {
    state.autoplay = !state.autoplay;
    ui.autoplaySwitch.classList.toggle('is-on', state.autoplay);
    ui.autoplaySwitch.setAttribute('aria-checked', String(state.autoplay));
    savePrefs();
    toast(state.autoplay ? 'Autoplay radio on' : 'Autoplay radio off', 'info');
    if (state.autoplay && state.current) extendQueueFromRadio();
  });

  /* Mobile sidebar. */
  ui.mobileMenu.addEventListener('click', () => {
    ui.sidebar.classList.toggle('is-open');
  });

  /* Modal backdrop. */
  ui.modalRoot.addEventListener('click', (event) => {
    if (event.target === ui.modalRoot) closeModal();
  });

  /* Progress bars. */
  bindProgress(ui.progressContainer);
  bindProgress(ui.npProgress);

  /* Media element events. */
  media.addEventListener('loadedmetadata', () => {
    if (state.pendingSeek > 0) {
      const target = state.pendingSeek;
      try {
        const duration = Number(media.duration);
        media.currentTime =
          Number.isFinite(duration) && duration > 0 ? Math.min(target, Math.max(0, duration - 0.25)) : target;
      } catch (err) {
        /* ignore */
      }
      state.pendingSeek = 0;
    }
    updateProgressUI();
    updateMediaSession();
  });

  media.addEventListener('timeupdate', updateProgressUI);
  media.addEventListener('progress', updateProgressUI);
  media.addEventListener('durationchange', updateProgressUI);

  const setPlaying = () => {
    state.playing = true;
    state.loading = false;
    syncPlayingUI();
    updateVideoStage();
    updateMediaSession();
  };
  media.addEventListener('play', setPlaying);
  media.addEventListener('playing', setPlaying);

  media.addEventListener('pause', () => {
    state.playing = false;
    syncPlayingUI();
    updateVideoStage();
    updateMediaSession();
  });

  media.addEventListener('waiting', () => {
    state.loading = true;
    updateVideoStage();
  });

  media.addEventListener('canplay', () => {
    state.loading = false;
    updateVideoStage();
  });

  media.addEventListener('ended', () => {
    handleTrackEnded().catch(() => {});
  });

  media.addEventListener('error', handleMediaError);

  media.addEventListener('volumechange', () => {
    if (Math.abs(media.volume - state.volume) < 0.001 && media.muted === state.muted) return;
    state.volume = media.volume;
    state.muted = media.muted;
    applyVolume();
    savePrefs();
  });

  /* Broken thumbnails fall back to the in-app artwork. */
  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (img && img.tagName === 'IMG' && !img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.src = FALLBACK_ART;
      }
    },
    true
  );

  /* Keyboard shortcuts. */
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (event.key === 'Escape') {
      closeContextMenu();
      hideSuggestions();
      if (!ui.modalRoot.hidden) closeModal();
      else if (!ui.nowPlaying.hidden) closeNowPlaying();
      else {
        closeQueueDrawer();
        closeLyricsDrawer();
      }
      return;
    }

    if (typing) return;
    if (target && target.closest && target.closest('.progress')) return;

    if (event.code === 'Space') {
      if (target && target.closest && target.closest('button, a')) return;
      event.preventDefault();
      togglePlay();
      return;
    }

    if (event.key === '/') {
      event.preventDefault();
      ui.searchInput.focus();
      ui.searchInput.select();
      return;
    }

    const key = event.key.toLowerCase();
    if (key === 'v') {
      toggleMode();
    } else if (key === 'm') {
      toggleMute();
    } else if (key === 'l') {
      if (state.current) toggleLike(state.current);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBy(5);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekBy(-5);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setVolume(state.volume + 0.05);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setVolume(state.volume - 0.05);
    }
  });

  window.addEventListener('resize', closeContextMenu);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function boot() {
  ui.heroArt.src = FALLBACK_ART;
  ui.searchClear.hidden = true;
  ui.autoplaySwitch.classList.toggle('is-on', state.autoplay);
  ui.autoplaySwitch.setAttribute('aria-checked', String(state.autoplay));
  ui.npTabs.querySelectorAll('.np-tab').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.npTab === state.npTab);
  });

  applyVolume();
  moveMediaElement();
  updateModeUI();
  syncPlayingUI();
  syncLikeUI();
  renderPlaylistSidebar();
  renderRecentSearches();
  renderDownloads();
  renderQueueDrawer();
  renderVideoUpnext();
  bindEvents();
  startVisualizer();
  loadHome();
}

boot();







