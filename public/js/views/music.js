// Music: Plexamp-ish rails, inline album/artist sheets, and a persistent bottom
// mini-player with queue, shuffle, repeat, Media Session, and a WebAudio visualizer.
import { get, post, fmtClock, fmtDuration, artFor, placeholderArt } from '../api.js';
import { h, toast, modal, emptyState, skeletonCards } from '../ui.js';

const QUEUE_KEY = 'slop:music-queue';
const ROW_SIZE = 60;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

const player = {
  audio: null, host: null, el: {}, queue: [], index: -1,
  shuffle: false, repeat: 'off', volume: 0.85, analyser: null,
  audioCtx: null, source: null, raf: 0, lastMark: 0,
  queueOpen: false, restored: false,
};

const num = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const normalizePage = (raw) => {
  if (Array.isArray(raw)) return { items: raw, total: raw.length };
  return { items: raw?.items || raw?.tracks || raw?.albums || raw?.artists || [], total: num(raw?.total, raw?.items?.length) };
};

function trackArt(track) {
  return track?.art?.poster || track?.art?.thumb || (track?.albumId ? `/api/art/${track.albumId}/poster` : artFor(track || {}, 'poster'));
}

function artistArt(artist) {
  return artist?.art?.avatar || artist?.art?.thumb || artist?.art?.poster || artFor(artist || {}, 'poster');
}

function artistName(track) {
  return track?.artistName || track?.artist?.title || track?.artist || '';
}

function albumName(track) {
  return track?.albumName || track?.album?.title || '';
}

function trackMeta(track) {
  const meta = [artistName(track), albumName(track), track?.year].filter(Boolean).join(' · ');
  return meta || 'unknown provenance';
}

function sameQueue(list) {
  if (!Array.isArray(list) || list.length !== player.queue.length) return false;
  return list.every((track, index) => String(track?.id) === String(player.queue[index]?.id));
}

function persistQueue() {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify({
      queue: player.queue.slice(0, 200),
      index: player.index,
      shuffle: player.shuffle,
      repeat: player.repeat,
      volume: player.volume,
    }));
  } catch { /* sessionStorage can be full or disabled */ }
}

function restoreQueue() {
  if (player.restored) return;
  player.restored = true;
  try {
    const saved = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.queue)) return;
    player.queue = saved.queue.filter((track) => track && track.id != null);
    player.index = Math.min(Math.max(Number(saved.index) || 0, 0), Math.max(player.queue.length - 1, 0));
    player.shuffle = Boolean(saved.shuffle);
    player.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
    player.volume = Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.85;
  } catch { player.queue = []; }
}
function ensurePlayer() {
  if (player.host) return player;
  restoreQueue();
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = player.volume;
  player.audio = audio;

  const el = player.el;
  el.artFallback = placeholderArt('mini-player', 'poster', 'No queue');
  el.artImg = h('img', { alt: '', loading: 'eager', decoding: 'async', src: el.artFallback });
  el.artImg.addEventListener('error', () => {
    if (el.artImg.dataset.fallback === '1') return;
    el.artImg.dataset.fallback = '1';
    el.artImg.src = el.artFallback;
  });
  el.artBtn = h('button', { class: 'mp-art', type: 'button', 'aria-label': 'Open album', onclick: () => player.onArtwork?.() }, el.artImg);
  el.title = h('strong', { class: 'mp-title' }, 'Nothing queued');
  el.meta = h('span', { class: 'mp-meta' }, 'pick a track, any track');
  el.prev = h('button', { class: 'mp-btn', type: 'button', 'aria-label': 'Previous track', onclick: () => prevTrack() }, '⏮');
  el.play = h('button', { class: 'mp-btn mp-play', type: 'button', 'aria-label': 'Play', onclick: () => togglePlayback() }, '▶');
  el.next = h('button', { class: 'mp-btn', type: 'button', 'aria-label': 'Next track', onclick: () => nextTrack() }, '⏭');
  el.time = h('span', { class: 'mp-time', 'aria-hidden': 'true' }, '0:00');
  el.duration = h('span', { class: 'mp-time', 'aria-hidden': 'true' }, '0:00');
  el.seek = h('input', {
    type: 'range', class: 'mp-seek', min: '0', max: '0', step: '0.1', value: '0',
    'aria-label': 'Seek within track',
    oninput: () => { if (Number.isFinite(audio.duration)) audio.currentTime = (Number(el.seek.value) / 1000) * audio.duration; },
  });
  el.bars = h('div', { class: 'mp-bars', 'aria-hidden': 'true' }, ...Array.from({ length: 14 }, () => h('i', {})));
  el.shuffle = h('button', { class: 'mp-btn small mp-shuffle', type: 'button', 'aria-label': 'Shuffle', 'aria-pressed': 'false', onclick: () => toggleShuffle() }, '⤨');
  el.repeat = h('button', { class: 'mp-btn small mp-repeat', type: 'button', 'aria-label': 'Repeat', 'aria-pressed': 'false', onclick: () => cycleRepeat() }, '↻');
  el.vol = h('input', {
    type: 'range', class: 'mp-vol', min: '0', max: '1', step: '0.01', value: String(player.volume), 'aria-label': 'Volume',
    oninput: () => { audio.volume = Number(el.vol.value); audio.muted = audio.volume === 0; player.volume = audio.volume; },
  });
  el.queueBtn = h('button', { class: 'mp-btn small mp-queue-btn', type: 'button', 'aria-label': 'Queue', 'aria-expanded': 'false', onclick: () => toggleQueuePanel() }, '☰');
  el.playlistBtn = h('button', { class: 'mp-btn small mp-playlist-btn', type: 'button', 'aria-label': 'Add to playlist', onclick: () => { if (currentTrack()) openPlaylistMenu(currentTrack()); } }, '＋');
  el.queuePanel = h('div', { class: 'mp-queue-panel', hidden: true });

  const host = h('section', { class: 'mp', 'aria-label': 'Music player', hidden: true },
    h('div', { class: 'mp-main' },
      el.artBtn,
      h('div', { class: 'mp-now' }, el.title, el.meta),
      h('div', { class: 'mp-transport' }, el.prev, el.play, el.next),
      h('div', { class: 'mp-progress' }, el.time, el.seek, el.duration),
      el.bars,
      h('div', { class: 'mp-actions' }, el.shuffle, el.repeat, el.vol, el.queueBtn, el.playlistBtn),
    ),
    el.queuePanel,
  );
  player.host = host;
  document.body.append(host);
  bindPlayer(audio);
  syncTransport();
  renderMini();
  return player;
}

function bindPlayer(audio) {
  audio.addEventListener('timeupdate', onAudioTime);
  audio.addEventListener('durationchange', syncAudioTime);
  audio.addEventListener('loadedmetadata', () => { syncAudioTime(); renderMini(); });
  audio.addEventListener('play', () => { ensureAnalyser(); player.audioCtx?.resume?.().catch?.(() => {}); startBars(); syncTransport(); });
  audio.addEventListener('playing', () => { syncTransport(); setMediaSession(currentTrack()); });
  audio.addEventListener('pause', () => { stopBars(); syncTransport(); markProgress(); persistQueue(); });
  audio.addEventListener('ended', onAudioEnded);
  audio.addEventListener('error', () => {
    const track = currentTrack();
    if (!track || !audio.currentSrc) return;
    toast(`Track refused to decode${track?.audioCodec ? ` (${track.audioCodec})` : ''}. Codec skill issue.`, 'error');
    syncTransport();
  });
  audio.addEventListener('volumechange', () => {
    player.volume = audio.volume;
    player.el.vol.value = String(audio.volume);
    player.el.vol.style.setProperty('--vol', `${audio.volume * 100}%`);
    persistQueue();
  });
}

function currentTrack() {
  return player.queue[player.index] || null;
}

function onAudioTime() {
  syncAudioTime();
  if (!player.audio.paused && Date.now() - player.lastMark > 10000) markProgress();
}

function syncAudioTime() {
  const audio = player.audio;
  if (!audio || !player.host) return;
  const track = currentTrack();
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : num(track?.durationSeconds, track?.runtimeSeconds);
  const position = audio.currentTime || 0;
  player.el.time.textContent = fmtClock(position);
  player.el.duration.textContent = duration ? fmtClock(duration) : '—';
  player.el.seek.max = String(Math.round(duration * 1000));
  player.el.seek.value = String(Math.min(Math.round(position * 1000), Number(player.el.seek.max)));
  player.el.seek.style.setProperty('--played', duration ? `${(position / duration) * 100}%` : '0%');
}

function markProgress(finished = false) {
  const track = currentTrack();
  if (!track || !player.audio) return;
  const position = player.audio.currentTime || 0;
  if (!finished && position < 2) return;
  player.lastMark = Date.now();
  const duration = Number.isFinite(player.audio.duration) ? player.audio.duration : num(track.durationSeconds, track.runtimeSeconds);
  post(`/api/stream/${track.id}/progress`, {
    positionSeconds: Math.round(position * 10) / 10,
    durationSeconds: Math.round(duration * 10) / 10,
    ...(finished ? { finished: true } : {}),
  }).catch(() => { /* progress is best effort */ });
}

function onAudioEnded() {
  markProgress(true);
  if (player.repeat === 'one') {
    player.audio.currentTime = 0;
    player.audio.play().catch(() => {});
    return;
  }
  if (player.shuffle) { playRandomIndex(); return; }
  if (player.index < player.queue.length - 1) { playIndex(player.index + 1); return; }
  if (player.repeat === 'all' && player.queue.length) { playIndex(0); return; }
  syncTransport();
  stopBars();
}

function renderMini() {
  ensurePlayer();
  const track = currentTrack();
  const el = player.el;
  player.host.hidden = !track;
  document.body.classList.toggle('has-mini-player', Boolean(track));
  if (!track) {
    el.title.textContent = 'Nothing queued';
    el.meta.textContent = 'pick a track, any track';
    el.artBtn.setAttribute('aria-label', 'Track artwork');
    if (el.artImg.getAttribute('src') !== el.artFallback) el.artImg.src = el.artFallback;
    delete el.artImg.dataset.fallback;
    return;
  }
  el.title.textContent = track.title || 'Untitled slop';
  el.meta.textContent = trackMeta(track);
  const art = trackArt(track);
  if (el.artImg.getAttribute('src') !== art) {
    delete el.artImg.dataset.fallback;
    el.artImg.src = art;
  }
  el.artBtn.setAttribute('aria-label', track.albumId ? `Open album ${albumName(track) || ''}` : 'Track artwork');
  syncTransport();
  syncAudioTime();
  if (player.queueOpen) renderQueuePanel();
}

function syncTransport() {
  if (!player.host) return;
  const audio = player.audio;
  const el = player.el;
  const playing = Boolean(audio && !audio.paused);
  el.play.textContent = playing ? '❚❚' : '▶';
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  el.shuffle.classList.toggle('active', player.shuffle);
  el.shuffle.setAttribute('aria-pressed', player.shuffle ? 'true' : 'false');
  const repeatLabels = { off: '↻', all: '↻ all', one: '↻¹' };
  el.repeat.textContent = repeatLabels[player.repeat] || '↻';
  el.repeat.classList.toggle('active', player.repeat !== 'off');
  el.repeat.setAttribute('aria-pressed', player.repeat !== 'off' ? 'true' : 'false');
  el.repeat.setAttribute('aria-label', `Repeat ${player.repeat}`);
}

function setMediaSession(track) {
  if (!track || !('mediaSession' in navigator)) return;
  try {
    const artwork = [{ src: new URL(trackArt(track), location.origin).href, sizes: '512x512' }];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Untitled',
      artist: artistName(track) || 'Unknown artist',
      album: albumName(track) || 'AISlopMediaBox',
      artwork,
    });
  } catch { /* MediaMetadata can refuse malformed artwork */ }
  const handlers = {
    play: () => togglePlayback(),
    pause: () => player.audio?.pause(),
    previoustrack: () => prevTrack(),
    nexttrack: () => nextTrack(),
    seekbackward: () => seekGlobal(-10),
    seekforward: () => seekGlobal(10),
    seekto: (details) => { if (Number.isFinite(details?.seekTime)) player.audio.currentTime = details.seekTime; },
    stop: () => { player.audio?.pause(); player.audio.currentTime = 0; },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(name, handler); } catch { /* handler unsupported */ }
  }
}

function ensureAnalyser() {
  if (player.analyser) { player.audioCtx?.resume?.().catch?.(() => {}); return; }
  if (reduceMotion) return;
  const audio = player.audio;
  if (!audio) return;
  try {
    const source = new URL(audio.currentSrc || audio.src, location.origin);
    if (source.origin !== location.origin) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    player.audioCtx = new Ctx();
    player.source = player.audioCtx.createMediaElementSource(audio);
    const analyser = player.audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.76;
    player.source.connect(analyser);
    analyser.connect(player.audioCtx.destination);
    player.analyser = analyser;
  } catch { player.analyser = null; }
}

function startBars() {
  if (!player.analyser || reduceMotion) return;
  cancelAnimationFrame(player.raf);
  const bars = [...player.el.bars.children];
  const data = new Uint8Array(player.analyser.frequencyBinCount);
  const draw = () => {
    player.analyser.getByteFrequencyData(data);
    bars.forEach((bar, index) => {
      const value = data[index % data.length] / 255;
      bar.style.transform = `scaleY(${0.16 + value * 0.84})`;
    });
    player.raf = requestAnimationFrame(draw);
  };
  draw();
}

function stopBars() {
  cancelAnimationFrame(player.raf);
  for (const bar of player.el.bars?.children || []) bar.style.transform = 'scaleY(0.16)';
}

function playIndex(index, { autoplay = true } = {}) {
  const track = player.queue[index];
  if (!track) return;
  const audio = player.audio;
  if (!audio) return;
  audio.pause();
  player.index = index;
  player.lastMark = 0;
  audio.src = `/api/stream/${track.id}`;
  audio.load();
  renderMini();
  persistQueue();
  if (autoplay) {
    audio.play().catch((error) => {
      if (error?.name !== 'AbortError') toast('Playback blocked. Tap play.', 'info', { emoji: '🫸' });
    });
  }
}

function togglePlayback() {
  const audio = player.audio;
  if (!audio || !currentTrack()) return;
  if (audio.paused) {
    if (!audio.src) { playIndex(player.index); return; }
    if (audio.ended) audio.currentTime = 0;
    audio.play().catch(() => toast('Playback blocked. Tap play.', 'info'));
  } else {
    audio.pause();
  }
}

function seekGlobal(delta) {
  const audio = player.audio;
  if (!audio || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(Math.max(audio.currentTime + delta, 0), Math.max(audio.duration - 0.5, 0));
  syncAudioTime();
}

function playRandomIndex() {
  if (!player.queue.length) return;
  if (player.queue.length === 1) { playIndex(0); return; }
  let next = player.index;
  while (next === player.index) next = Math.floor(Math.random() * player.queue.length);
  playIndex(next);
}

function nextTrack() {
  if (!player.queue.length) return;
  if (player.shuffle) { playRandomIndex(); return; }
  if (player.index < player.queue.length - 1) { playIndex(player.index + 1); return; }
  if (player.repeat === 'all') { playIndex(0); return; }
  toast('Queue ended. Certified silence.', 'info', { emoji: '🤫' });
}

function prevTrack() {
  if (!player.queue.length) return;
  if (player.audio?.currentTime > 4) { player.audio.currentTime = 0; syncAudioTime(); return; }
  if (player.index > 0) { playIndex(player.index - 1); return; }
  if (player.repeat === 'all') { playIndex(player.queue.length - 1); return; }
  player.audio.currentTime = 0;
}

function playTrackNow(track, list, { restart = false } = {}) {
  if (!track?.id) return;
  ensurePlayer();
  const alreadyCurrent = currentTrack() && String(currentTrack().id) === String(track.id) && (!list || sameQueue(list));
  if (alreadyCurrent && !restart) { togglePlayback(); return; }
  if (Array.isArray(list) && list.length) {
    if (!sameQueue(list)) player.queue = list.slice();
    let index = player.queue.findIndex((entry) => String(entry.id) === String(track.id));
    if (index < 0) { player.queue.unshift(track); index = 0; }
    player.index = index;
  } else {
    let index = player.queue.findIndex((entry) => String(entry.id) === String(track.id));
    if (index < 0) { player.queue.push(track); index = player.queue.length - 1; }
    player.index = index;
  }
  playIndex(player.index, { autoplay: true });
}

function enqueue(track) {
  if (!track?.id) return;
  ensurePlayer();
  player.queue.push(track);
  if (player.index < 0) player.index = 0;
  persistQueue();
  renderMini();
  toast(`Queued: ${track.title || 'track'}.`, 'success', { emoji: '➕' });
}

function removeQueueItem(index) {
  if (index < 0 || index >= player.queue.length) return;
  const removingCurrent = index === player.index;
  player.queue.splice(index, 1);
  if (!player.queue.length) {
    player.index = -1;
    player.audio.pause();
    player.audio.removeAttribute('src');
    player.audio.load();
  } else if (index < player.index) {
    player.index -= 1;
  } else if (removingCurrent) {
    player.index = Math.min(player.index, player.queue.length - 1);
    playIndex(player.index);
  }
  persistQueue();
  renderMini();
}

function clearQueue() {
  player.audio?.pause();
  player.queue = [];
  player.index = -1;
  if (player.audio) { player.audio.removeAttribute('src'); player.audio.load(); }
  persistQueue();
  renderMini();
  toast('Queue cleared. Silence is golden.', 'fun', { emoji: '🧹' });
}

function toggleShuffle() {
  player.shuffle = !player.shuffle;
  persistQueue();
  syncTransport();
  toast(player.shuffle ? 'Shuffle on. Chaos mode.' : 'Shuffle off. Linear thinking.', 'fun', { emoji: '🔀' });
}

function cycleRepeat() {
  const modes = ['off', 'all', 'one'];
  player.repeat = modes[(modes.indexOf(player.repeat) + 1) % modes.length];
  persistQueue();
  syncTransport();
  toast(`Repeat: ${player.repeat}.`, 'fun', { emoji: '🔁' });
}

function toggleQueuePanel(force) {
  player.queueOpen = typeof force === 'boolean' ? force : !player.queueOpen;
  player.el.queuePanel.hidden = !player.queueOpen;
  player.el.queueBtn.setAttribute('aria-expanded', player.queueOpen ? 'true' : 'false');
  renderQueuePanel();
}

function renderQueuePanel() {
  if (!player.queueOpen) return;
  const panel = player.el.queuePanel;
  if (!player.queue.length) {
    panel.replaceChildren(h('div', { class: 'mpq-empty' }, 'Queue is empty. Choose violence (a track).'));
    return;
  }
  const rows = player.queue.map((track, index) => h('div', { class: `mpq-row${index === player.index ? ' playing' : ''}` },
    h('button', { class: 'mpq-main', type: 'button', onclick: () => playIndex(index) },
      h('span', { class: 'mpq-num' }, index === player.index ? '▶' : String(index + 1).padStart(2, '0')),
      h('img', { src: trackArt(track), alt: '', loading: 'lazy' }),
      h('span', { class: 'mpq-copy' },
        h('strong', { class: 'truncate' }, track.title || 'Untitled'),
        h('span', { class: 'truncate' }, trackMeta(track))),
      h('span', { class: 'mpq-dur' }, fmtClock(num(track.durationSeconds, track.runtimeSeconds)))),
    h('button', {
      class: 'mpq-remove', type: 'button', 'aria-label': `Remove ${track.title || 'track'} from queue`,
      onclick: () => removeQueueItem(index),
    }, '✕')));
  panel.replaceChildren(
    h('div', { class: 'mpq-head' },
      h('strong', {}, `Queue · ${player.queue.length}`),
      h('button', { class: 'mini-link', type: 'button', onclick: clearQueue }, 'clear')),
    h('div', { class: 'mpq-list' }, ...rows),
  );
}

async function openPlaylistMenu(track) {
  if (!track?.id) return;
  let playlists = [];
  try {
    const raw = await get('/api/playlists?pageSize=100');
    playlists = raw?.items || raw?.playlists || (Array.isArray(raw) ? raw : []);
  } catch (error) {
    toast(error.message || 'Could not load playlists.', 'error');
    return;
  }
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, `${track.title || 'Track'}${artistName(track) ? ` · ${artistName(track)}` : ''}`));
  if (!playlists.length) {
    body.append(
      h('p', { class: 'muted' }, 'No playlists yet. Make one and it will appear here.'),
      h('a', { class: 'btn primary', href: '/playlists', 'data-link': true }, 'Go make a playlist'),
    );
  }
  const dialog = modal({ title: 'Add to playlist', body });
  for (const playlist of playlists) {
    body.append(h('button', {
      class: 'btn block', type: 'button',
      onclick: async () => {
        try {
          await post(`/api/playlists/${playlist.id}/items`, { mediaIds: [track.id] });
          toast(`Added to ${playlist.name || 'playlist'}.`, 'success', { emoji: '📃' });
          dialog.close();
        } catch (error) {
          toast(error.message || 'Playlist said no.', 'error');
        }
      },
    }, `${playlist.name || 'Untitled playlist'}${playlist.itemCount != null ? ` · ${playlist.itemCount}` : ''}`));
  }
}

const TABS = [
  { id: '', label: 'Overview', href: '/music' },
  { id: 'albums', label: 'Albums', href: '/music/albums' },
  { id: 'artists', label: 'Artists', href: '/music/artists' },
  { id: 'tracks', label: 'Tracks', href: '/music/tracks' },
];

export default async function render(container, ctx) {
  const tab = ['albums', 'artists', 'tracks'].includes(ctx.params.tab) ? ctx.params.tab : '';
  const query = ctx.query || {};
  ensurePlayer();
  player.onArtwork = () => {
    const track = currentTrack();
    if (track?.albumId) openAlbumPanel(track.albumId);
    else toast('No album art to open. It is giving single energy.', 'info', { emoji: '🖼️' });
  };
  container.replaceChildren(h('div', { 'aria-busy': 'true' }, h('div', { class: 'music-loading' }, h('span', { class: 'spinner' }), 'loading the discography')));

  let overview = null;
  try {
    overview = await get('/api/music', { signal: ctx.signal });
  } catch (error) {
    if (error.name === 'AbortError' || ctx.signal?.aborted) return undefined;
    toast(error.message || 'Music API is being shy.', 'error');
    overview = null;
  }

  const view = {
    panel: null, panelData: null, body: null, overview,
    page: { albums: 1, artists: 1, tracks: 1 },
    lists: { albums: [], artists: [], tracks: [] },
    totals: { albums: 0, artists: 0, tracks: 0 },
  };

  activeView = view;
  document.title = 'Music — AISlopMediaBox';
  const shell = h('div', { class: 'music-view' },
    musicHeader(overview),
    h('nav', { class: 'tabs music-tabs', 'aria-label': 'Music sections' },
      ...TABS.map((entry) => h('a', {
        class: `tab${(entry.id === tab) ? ' active' : ''}`,
        href: entry.href, 'data-link': true,
        'aria-current': entry.id === tab ? 'page' : null,
      }, entry.label))),
    view.body = h('div', { class: 'music-body' }),
  );
  container.replaceChildren(shell);

  bindMusicKeys(ctx);

  if (!tab) {
    renderOverview(view, overview, ctx);
  } else {
    await loadTab(view, tab, ctx);
  }

  if (query.album) await openAlbumPanel(query.album, { initial: true });
  else if (query.artist) await openArtistPanel(query.artist, { initial: true });

  renderMini();

  return () => {
    player.onArtwork = null;
    closePanel({ updateUrl: false });
    if (activeView === view) activeView = null;
    if (location.pathname.startsWith('/watch')) player.audio?.pause();
  };
}

function musicHeader(overview) {
  const stats = overview?.stats || {};
  const pills = [];
  const stat = (count, label) => {
    if (!Number.isFinite(Number(count))) return;
    pills.push(h('span', { class: 'pill' }, `${count} ${label}`));
  };
  stat(stats.artists ?? overview?.artists?.length, 'artists');
  stat(stats.albums ?? overview?.albums?.length, 'albums');
  stat(stats.tracks ?? overview?.tracks?.length, 'tracks');
  if (stats.hours) pills.push(h('span', { class: 'pill accent' }, `${stats.hours}h played`));
  return h('header', { class: 'page-head music-head' },
    h('div', {},
      h('span', { class: 'eyebrow' }, 'music'),
      h('h1', { class: 'music-title' }, h('span', {}, 'Your ears called.'), h('span', { class: 'music-title-accent' }, 'We answered.')),
      h('p', { class: 'sub' }, 'Local audio, zero streaming subscriptions, full Plexamp cosplay.')),
    h('div', { class: 'row wrap music-stats' }, ...pills));
}

const renderEmpty = (title, message, emoji = '🎧') => emptyState(title, message, emoji);

function section(title, nodes, { count, action } = {}) {
  if (!nodes.length) return null;
  return h('section', { class: 'music-section' },
    h('div', { class: 'section-head' },
      h('h2', {}, title),
      count != null ? h('span', { class: 'count' }, `${count}`) : null,
      action ? h('a', { class: 'mini-link', href: action.href, 'data-link': true, style: { marginLeft: 'auto' } }, action.label) : null),
    h('div', { class: 'music-rail' }, ...nodes));
}

function trackCard(track, list) {
  return h('button', {
    class: 'track-card', type: 'button', 'data-focus': true,
    'aria-label': `Play ${track.title || 'track'}${artistName(track) ? ` by ${artistName(track)}` : ''}`,
    onclick: () => playTrackNow(track, list),
  },
    h('span', { class: 'track-card-art' },
      h('img', { src: trackArt(track), alt: '', loading: 'lazy', decoding: 'async' }),
      h('span', { class: 'track-card-play', 'aria-hidden': 'true' }, '▶')),
    h('strong', { class: 'truncate' }, track.title || 'Untitled'),
    h('span', { class: 'truncate muted' }, artistName(track) || 'Unknown artist'));
}

function albumCard(album) {
  return h('div', { class: 'music-card' },
    h('div', { class: 'music-art-wrap' },
      h('button', { class: 'music-art-btn', type: 'button', 'aria-label': `Open album ${album.title || ''}`, onclick: () => openAlbumPanel(album.id) },
        h('img', { src: artFor(album, 'poster'), alt: '', loading: 'lazy', decoding: 'async' })),
      h('button', {
        class: 'music-play-btn', type: 'button', 'aria-label': `Play album ${album.title || ''}`,
        onclick: () => playAlbum(album),
      }, '▶')),
    h('button', { class: 'music-card-title truncate', type: 'button', onclick: () => openAlbumPanel(album.id) }, album.title || 'Untitled'),
    h('span', { class: 'music-card-meta truncate' }, [album.artistName, album.year].filter(Boolean).join(' · ') || 'album'));
}

function artistCard(artist) {
  return h('div', { class: 'music-card artist-card' },
    h('button', { class: 'music-art-btn round', type: 'button', 'aria-label': `Open artist ${artist.title || ''}`, onclick: () => openArtistPanel(artist.id) },
      h('img', { src: artistArt(artist), alt: '', loading: 'lazy', decoding: 'async' })),
    h('button', { class: 'music-card-title truncate', type: 'button', onclick: () => openArtistPanel(artist.id) }, artist.title || 'Unknown artist'),
    h('span', { class: 'music-card-meta truncate' }, [artist.albumCount ? `${artist.albumCount} albums` : '', artist.trackCount ? `${artist.trackCount} tracks` : ''].filter(Boolean).join(' · ') || 'artist'));
}

function playlistCard(playlist) {
  return h('a', { class: 'music-card playlist-card', href: `/playlists/${playlist.id}`, 'data-link': true },
    h('div', { class: 'music-art-wrap' },
      h('img', { src: artFor(playlist, 'poster'), alt: '', loading: 'lazy' }),
      h('span', { class: 'playlist-count' }, `${playlist.itemCount ?? 0} tracks`)),
    h('strong', { class: 'music-card-title truncate' }, playlist.name || 'Untitled playlist'),
    h('span', { class: 'music-card-meta truncate' }, playlist.description || 'playlist'));
}

function renderOverview(view, overview, ctx) {
  const body = view.body;
  if (!overview) {
    body.replaceChildren(renderEmpty('Music API is off the grid', 'The server did not report any music. Scan a music library or come back later.'));
    return;
  }
  const recentTracks = (overview.recentTracks?.length ? overview.recentTracks : overview.recentlyPlayed) || [];
  const recent = overview.recentlyAdded;
  const recentAlbums = Array.isArray(recent) ? recent : recent?.albums || [];
  const recentArtists = Array.isArray(recent) ? [] : recent?.artists || [];
  const artists = overview.artists || [];
  const albums = overview.albums || [];
  const playlists = overview.playlists || [];

  const sections = [
    section('Recently played', recentTracks.map((track) => trackCard(track, recentTracks)), { count: recentTracks.length, action: { href: '/music/tracks', label: 'all tracks' } }),
    section('Freshly ripped', recentAlbums.map(albumCard), { count: recentAlbums.length, action: { href: '/music/albums', label: 'all albums' } }),
    section('Artists', artists.map(artistCard), { count: artists.length, action: { href: '/music/artists', label: 'all artists' } }),
    section('Albums on deck', albums.map(albumCard), { count: albums.length, action: { href: '/music/albums', label: 'all albums' } }),
    section('Recently added artists', recentArtists.map(artistCard), { count: recentArtists.length }),
    section('Playlists', playlists.map(playlistCard), { count: playlists.length, action: { href: '/playlists', label: 'library' } }),
  ].filter(Boolean);

  if (!sections.length) {
    body.replaceChildren(renderEmpty('No music, no thoughts', 'Your music library is empty. Point a scan at a folder of questionable FLACs.'));
    return;
  }
  body.replaceChildren(...sections);
  if (player.queue.length) body.append(h('p', { class: 'music-hint faint small' }, 'Queue is still alive in the bottom bar. It never left.'));
}

async function playAlbum(album) {
  try {
    const data = await get(`/api/music/albums/${album.id}`);
    const tracks = normalizeAlbum(data).tracks;
    if (!tracks.length) { toast('This album has no tracks. Conceptual release.', 'error'); return; }
    playTrackNow(tracks[0], tracks, { restart: true });
  } catch (error) {
    toast(error.message || 'Album refused to play.', 'error');
  }
}

function normalizeAlbum(raw) {
  const album = raw?.album || raw?.item || raw || {};
  const tracks = raw?.tracks || raw?.items || album.tracks || [];
  const artist = raw?.artist || album.artist || null;
  return { album, tracks, artist };
}

function normalizeArtist(raw) {
  const artist = raw?.artist || raw?.item || raw || {};
  const albums = raw?.albums || raw?.items || artist.albums || [];
  const tracks = raw?.topTracks || raw?.tracks || raw?.top_tracks || [];
  return { artist, albums, tracks };
}

let activeView = null;

async function loadTab(view, tab, ctx) {
  activeView = view;
  const body = view.body;
  const skeletons = h('div', { class: 'music-grid' }, ...skeletonCards(tab === 'tracks' ? 0 : 10));
  body.replaceChildren(h('div', { class: 'music-rails-skeleton' }, skeletons,
    tab === 'tracks' ? Array.from({ length: 8 }, () => h('div', { class: 'skeleton music-track-skeleton' })) : null));
  try {
    if (tab === 'albums') {
      const page = normalizePage(await get(`/api/music/albums?page=1&pageSize=${ROW_SIZE}`, { signal: ctx.signal }));
      view.lists.albums = page.items;
      view.totals.albums = page.total;
      renderAlbumList(view);
    } else if (tab === 'artists') {
      const page = normalizePage(await get(`/api/music/artists?page=1&pageSize=${ROW_SIZE}`, { signal: ctx.signal }));
      view.lists.artists = page.items;
      view.totals.artists = page.total;
      renderArtistList(view);
    } else {
      const page = normalizePage(await get(`/api/music/tracks?page=1&pageSize=${ROW_SIZE}`, { signal: ctx.signal }));
      view.lists.tracks = page.items;
      view.totals.tracks = page.total;
      renderTrackList(view);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    body.replaceChildren(renderEmpty('This tab ghosted us', error.message || 'The music API did not answer.', '💀'));
  }
}

function listHead(title, count, extra = []) {
  return h('div', { class: 'music-list-head' },
    h('div', {},
      h('h2', {}, title),
      h('p', { class: 'muted small' }, `${count} ${count === 1 ? 'thing' : 'things'}`)),
    h('div', { class: 'row wrap' }, ...extra));
}

function loadMoreButton(view, tab, ctx) {
  const button = h('button', { class: 'btn', type: 'button' }, 'Load more');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    view.page[tab] += 1;
    try {
      const path = tab === 'albums' ? '/api/music/albums' : tab === 'artists' ? '/api/music/artists' : '/api/music/tracks';
      const page = normalizePage(await get(`${path}?page=${view.page[tab]}&pageSize=${ROW_SIZE}`, { signal: ctx.signal }));
      const list = view.lists[tab];
      const host = view.listHost;
      if (tab === 'tracks') {
        list.push(...page.items);
        host.append(...page.items.map((track, index) => trackRow(track, () => view.lists.tracks, index + list.length - page.items.length)));
      } else {
        list.push(...page.items);
        host.append(...page.items.map((entry) => (tab === 'albums' ? albumCard(entry) : artistCard(entry))));
      }
      view.totals[tab] = page.total;
      if (list.length >= page.total || !page.items.length) button.remove();
      else { button.disabled = false; button.textContent = 'Load more'; }
      renderMini();
    } catch (error) {
      view.page[tab] -= 1;
      button.disabled = false;
      button.textContent = 'Load more';
      toast(error.message || 'Could not load more.', 'error');
    }
  });
  return button;
}

function renderAlbumList(view) {
  if (!view.lists.albums.length) {
    view.body.replaceChildren(emptyState('No albums in the crate', 'The music library is empty, or the scanner is still hungover. Add a music library and scan it.', '📀'));
    return;
  }
  const host = h('div', { class: 'music-grid albums-grid' }, ...view.lists.albums.map(albumCard));
  view.listHost = host;
  const loadMore = view.lists.albums.length < view.totals.albums ? h('div', { class: 'load-more' }, loadMoreButton(view, 'albums')) : null;
  view.body.replaceChildren(
    listHead('Albums', view.totals.albums, [h('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => {
        const first = view.lists.albums[0];
        if (first) playAlbum(first);
        else toast('No albums to play. Empty shelf energy.', 'info');
      },
    }, 'Play first album')]),
    host,
    loadMore,
  );
}

function renderArtistList(view) {
  if (!view.lists.artists.length) {
    view.body.replaceChildren(emptyState('No artists found', 'No artists, no drama. Scan a music library to summon some.', '🎤'));
    return;
  }
  const host = h('div', { class: 'music-grid artists-grid' }, ...view.lists.artists.map(artistCard));
  view.listHost = host;
  const loadMore = view.lists.artists.length < view.totals.artists ? h('div', { class: 'load-more' }, loadMoreButton(view, 'artists')) : null;
  view.body.replaceChildren(listHead('Artists', view.totals.artists), host, loadMore);
}

function renderTrackList(view) {
  if (!view.lists.tracks.length) {
    view.body.replaceChildren(emptyState('No tracks to play', 'The track list is empty. Silence is technically music, but this is a media server.', '🎧'));
    return;
  }
  const listHost = h('div', { class: 'music-tracklist' });
  const playAll = h('button', { class: 'btn primary small', type: 'button', onclick: () => {
    const tracks = view.lists.tracks;
    if (!tracks.length) { toast('No tracks. Silence wins.', 'info'); return; }
    playTrackNow(tracks[0], tracks, { restart: true });
  } }, '▶ Play all');
  view.listHost = listHost;
  listHost.append(...view.lists.tracks.map((track, index) => trackRow(track, () => view.lists.tracks, index)));
  const loadMore = view.lists.tracks.length < view.totals.tracks ? h('div', { class: 'load-more' }, loadMoreButton(view, 'tracks')) : null;
  view.body.replaceChildren(listHead('Tracks', view.totals.tracks, [playAll]), listHost, loadMore);
}

function resolveTracks(source) {
  return typeof source === 'function' ? source() : source;
}

function trackRow(track, listSource, index) {
  return h('div', { class: 'music-track', 'data-track-id': track.id },
    h('button', {
      class: 'mt-play', type: 'button', 'aria-label': `Play ${track.title || 'track'}`,
      onclick: () => playTrackNow(track, resolveTracks(listSource)),
    },
      h('span', { class: 'mt-num' }, String(index + 1).padStart(2, '0')),
      h('span', { class: 'mt-icon', 'aria-hidden': 'true' }, '▶')),
    h('img', { class: 'mt-art', src: trackArt(track), alt: '', loading: 'lazy', decoding: 'async' }),
    h('div', { class: 'mt-body' },
      h('strong', { class: 'truncate' }, track.title || 'Untitled'),
      h('span', { class: 'truncate muted' }, trackMeta(track))),
    h('span', { class: 'mt-dur' }, fmtClock(num(track.durationSeconds, track.runtimeSeconds))),
    h('button', { class: 'mt-menu', type: 'button', 'aria-label': `Add ${track.title || 'track'} to playlist`, onclick: () => openPlaylistMenu(track) }, '＋'));
}

function setPanelUrl(key, id) {
  const url = new URL(location.href);
  url.searchParams.delete('album');
  url.searchParams.delete('artist');
  if (key && id != null) url.searchParams.set(key, String(id));
  history.replaceState(history.state, '', `${url.pathname}${url.search}`);
}

function closePanel({ updateUrl = true } = {}) {
  const view = activeView;
  if (view?.panel) { view.panel.remove(); view.panel = null; }
  document.body.classList.remove('music-sheet-open');
  view?.panelAbort?.abort();
  if (view) view.panelAbort = null;
  if (updateUrl) setPanelUrl(null, null);
}

async function openAlbumPanel(id, { initial = false } = {}) {
  if (!id) return;
  let data;
  try {
    data = await get(`/api/music/albums/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (!initial) toast(error.message || 'Album not found.', 'error');
    if (initial) closePanel();
    return;
  }
  const { album, tracks: rawTracks, artist } = normalizeAlbum(data);
  const tracks = rawTracks.map((track) => ({
    ...track,
    albumName: track.albumName || album.title,
    artistName: track.artistName || artist?.title || album.artistName,
  }));
  if (!album?.title) return;
  closePanel({ updateUrl: false });
  const view = activeView;
  if (!view) return;
  const ac = new AbortController();
  view.panelAbort = ac;
  const backdrop = h('div', { class: 'music-sheet-backdrop', role: 'presentation' });
  const closeBtn = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close album', onclick: () => closePanel() }, '✕');
  const playAll = h('button', {
    class: 'btn primary', type: 'button',
    onclick: () => {
      if (!tracks.length) { toast('No tracks on this album. Art piece only.', 'info'); return; }
      playTrackNow(tracks[0], tracks, { restart: true });
    },
  }, '▶ Play album');
  const queueAll = h('button', {
    class: 'btn', type: 'button',
    onclick: () => {
      if (!tracks.length) return;
      tracks.forEach((track) => enqueue(track));
      toast(`Queued ${tracks.length} tracks from ${album.title}.`, 'success', { emoji: '📀' });
    },
  }, '＋ Queue album');
  const artistLink = (artist?.id || album.artistId)
    ? h('button', {
      class: 'mini-link sheet-artist', type: 'button',
      onclick: () => openArtistPanel(artist?.id || album.artistId),
    }, artist?.title || artistName(album) || 'View artist')
    : null;
  const totalDuration = tracks.reduce((sum, track) => sum + num(track.durationSeconds, track.runtimeSeconds), 0);

  const sheet = h('section', { class: 'music-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${album.title} album` },
    closeBtn,
    h('div', { class: 'sheet-hero' },
      h('div', { class: 'sheet-art' }, h('img', { src: artFor(album, 'poster'), alt: '', loading: 'eager' })),
      h('div', { class: 'sheet-copy' },
        h('span', { class: 'eyebrow' }, 'album'),
        h('h2', { class: 'sheet-title' }, album.title),
        artistLink ? h('div', { class: 'sheet-artist-row' }, artistLink) : h('p', { class: 'muted' }, artistName(album) || 'Unknown artist'),
        h('p', { class: 'muted small' }, [album.year, `${tracks.length} tracks`, totalDuration ? fmtDuration(totalDuration) : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'row wrap sheet-actions' }, playAll, queueAll))),
    tracks.length
      ? h('div', { class: 'music-tracklist sheet-tracks' }, ...tracks.map((track, index) => trackRow(track, tracks, index)))
      : h('p', { class: 'muted sheet-empty' }, 'This album has no tracks. Bold artistic statement.'),
  );
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closePanel(); });
  backdrop.append(sheet);
  document.body.append(backdrop);
  document.body.classList.add('music-sheet-open');
  view.panel = backdrop;
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePanel(); }, { signal: ac.signal });
  setPanelUrl('album', album.id || id);
  closeBtn.focus({ preventScroll: true });
}

async function openArtistPanel(id, { initial = false } = {}) {
  if (!id) return;
  let data;
  try {
    data = await get(`/api/music/artists/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (!initial) toast(error.message || 'Artist not found.', 'error');
    if (initial) closePanel();
    return;
  }
  const { artist, albums, tracks: rawTracks } = normalizeArtist(data);
  const tracks = rawTracks.map((track) => ({ ...track, artistName: track.artistName || artist.title }));
  if (!artist?.title && !artist?.id) return;
  closePanel({ updateUrl: false });
  const view = activeView;
  if (!view) return;
  const ac = new AbortController();
  view.panelAbort = ac;
  const backdrop = h('div', { class: 'music-sheet-backdrop', role: 'presentation' });
  const closeBtn = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close artist', onclick: () => closePanel() }, '✕');
  const playTop = h('button', {
    class: 'btn primary', type: 'button',
    onclick: () => {
      if (!tracks.length) { toast('No top tracks. Hum something.', 'info'); return; }
      playTrackNow(tracks[0], tracks, { restart: true });
    },
  }, '▶ Play top tracks');
  const sheet = h('section', { class: 'music-sheet artist-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${artist.title || 'Artist'} artist` },
    closeBtn,
    h('div', { class: 'sheet-hero artist-hero' },
      h('div', { class: 'sheet-art round' }, h('img', { src: artistArt(artist), alt: '', loading: 'eager' })),
      h('div', { class: 'sheet-copy' },
        h('span', { class: 'eyebrow' }, 'artist'),
        h('h2', { class: 'sheet-title' }, artist.title || 'Unknown artist'),
        h('p', { class: 'muted small' }, [albums.length ? `${albums.length} albums` : '', tracks.length ? `${tracks.length} top tracks` : '', artist.description].filter(Boolean).join(' · ')),
        h('div', { class: 'row wrap sheet-actions' }, playTop))),
    tracks.length ? h('div', { class: 'sheet-block' },
      h('h3', { class: 'sheet-sub' }, 'Top tracks'),
      h('div', { class: 'music-tracklist' }, ...tracks.map((track, index) => trackRow(track, tracks, index)))) : null,
    albums.length ? h('div', { class: 'sheet-block' },
      h('h3', { class: 'sheet-sub' }, 'Albums'),
      h('div', { class: 'music-grid albums-grid sheet-albums' }, ...albums.map(albumCard))) : null,
  );
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closePanel(); });
  backdrop.append(sheet);
  document.body.append(backdrop);
  document.body.classList.add('music-sheet-open');
  view.panel = backdrop;
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePanel(); }, { signal: ac.signal });
  setPanelUrl('artist', artist.id || id);
  closeBtn.focus({ preventScroll: true });
}

function bindMusicKeys(ctx) {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (target instanceof HTMLElement && target.closest('button, a[href]') && (event.key === ' ' || event.key === 'Enter')) return;
    if (key === ' ' || key === 'k') { event.preventDefault(); togglePlayback(); }
    else if (key === 'arrowright') { event.preventDefault(); seekGlobal(5); }
    else if (key === 'arrowleft') { event.preventDefault(); seekGlobal(-5); }
    else if (key === 'n') { event.preventDefault(); nextTrack(); }
    else if (key === 'p') { event.preventDefault(); prevTrack(); }
    else if (key === 'm' && player.audio) { event.preventDefault(); player.audio.muted = !player.audio.muted; syncTransport(); }
  }, { signal: ctx.signal });
}
