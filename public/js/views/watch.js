// Full-screen custom video player: direct play, HLS transcode, resume, subtitles,
// audio tracks, party sync, stats, and keyboard shortcuts. No framework, no mercy.
import { get, post, fmtClock, fmtDuration, artFor, connectEvents } from '../api.js';
import { h, toast } from '../ui.js';

const SEEK_STEP = 10;
const AUTOSAVE_MS = 10000;
let hlsLoader = null;

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoader) return hlsLoader;
  hlsLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js';
    script.async = true;
    script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js loaded without a global. Sus.')));
    script.onerror = () => { hlsLoader = null; reject(new Error('hls.js failed to load.')); };
    document.head.append(script);
  });
  return hlsLoader;
}

const pickNumber = (...values) => {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
};

function normalizeResume(raw) {
  if (!raw) return null;
  const source = raw.progress || raw.resume || raw.item?.progress || raw;
  const position = pickNumber(source.positionSeconds, source.position, source.position_seconds);
  const duration = pickNumber(source.durationSeconds, source.duration, source.duration_seconds);
  if (!position) return null;
  return { position, duration, finished: Boolean(source.finished) };
}

function reasonText(reasons) {
  if (!Array.isArray(reasons)) return '';
  return reasons.map((reason) => {
    if (typeof reason === 'string') return reason;
    return reason?.message || reason?.label || reason?.code || '';
  }).filter(Boolean).join(' · ');
}

function langLabel(sub) {
  const raw = sub.label || sub.language || 'Unknown';
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function srclang(value) {
  const code = String(value || '').toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : 'und';
}

function channelLabel(track) {
  if (track.title) return track.title;
  const parts = [String(track.language || 'und').toUpperCase()];
  if (track.codec) parts.push(track.codec);
  if (track.channels) parts.push(`${track.channels}ch`);
  return parts.join(' · ');
}

function streamSourceFor(info) {
  return info?.directUrl || info?.streamUrl || `/api/stream/${info?.id || ''}`;
}

export default async function render(container, ctx) {
  const mediaId = Number(ctx.params.id);
  const abort = new AbortController();
  const timers = new Set();
  const menuListeners = [];

  const state = {
    info: null, detail: null, hls: null, usingHls: false,
    activeAudio: null, defaultAudio: null, activeSubtitle: null, burnSubs: false,
    duration: 0, startAtPending: 0, pendingPlay: false, ready: false,
    resume: null, party: null, isHost: false, partyEvents: null,
    lastSaved: -1, saving: false, nextItem: null, nextTimer: null, nextCount: 0,
    controlsTimer: null, menu: null, statsOpen: false, loadToken: 0,
    destroyed: false, ended: false, wantsPlay: false, previousTitle: document.title,
    partyPublishAt: 0, partyPublishTimer: null, syncedAt: 0, joined: false, hlsStart: 0, restarting: false, seekGraceUntil: 0,
    playSessionId: (globalThis.crypto?.randomUUID?.() || `ps-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };

  let root;
  const el = {};
  const seekState = { dragging: false, preview: 0 };

  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!state.destroyed) fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const every = (fn, ms) => {
    const timer = setInterval(() => { if (!state.destroyed) fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const listen = (target, type, fn, options = {}) => {
    target.addEventListener(type, fn, { ...options, signal: abort.signal });
  };

  function cleanupTimers() {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    timers.clear();
  }

  // ---------- fetch info ----------
  let info;
  try {
    info = await get(`/api/stream/${mediaId}/info`, { signal: ctx.signal });
  } catch (error) {
    if (error.name === 'AbortError' || ctx.signal?.aborted || error.status === 401) return undefined;
    renderFatal(error);
    return undefined;
  }
  state.info = info;
  const tracks = Array.isArray(info.audioTracks) ? info.audioTracks : [];
  const chosen = tracks.find((track) => track.selected) || tracks.find((track) => track.default) || tracks[0];
  state.defaultAudio = chosen ? chosen.index : null;
  state.activeAudio = state.defaultAudio;

  document.body.classList.add('watch-open');
  buildShell();
  fillHeader();

  const [detailResult, progressResult] = await Promise.allSettled([
    get(`/api/media/${mediaId}`, { signal: ctx.signal }),
    get(`/api/stream/${mediaId}/progress`, { signal: ctx.signal }),
  ]);
  if (ctx.signal?.aborted) { teardown(); return undefined; }
  state.detail = detailResult.status === 'fulfilled' ? detailResult.value : null;
  const resume = progressResult.status === 'fulfilled' ? normalizeResume(progressResult.value) : null;
  const fallback = state.detail?.item?.progress;
  state.resume = resume || (fallback ? normalizeResume(fallback) : null);
  fillHeader();
  state.nextItem = findNextEpisode();
  await setupParty();
  if (state.party) {
    const partyPosition = Number(state.party.position) || 0;
    state.partyPosition = partyPosition;
    state.partyPaused = Boolean(state.party.paused);
    state.partyUpdatedAt = Date.now();
    await loadMedia({ startAt: partyPosition, autoplay: !state.partyPaused });
  } else if (!maybePromptResume()) {
    await loadMedia({ autoplay: false });
  }
  root.focus({ preventScroll: true });
  // ---------- fatal API errors ----------
  function renderFatal(error) {
    document.body.classList.remove('watch-open');
    const unavailable = error?.code === 'transcode_unavailable' || error?.status === 503;
    const notFound = error?.status === 404;
    container.replaceChildren(h('div', { class: 'watch-fatal' },
      h('div', { class: 'watch-fatal-emoji' }, unavailable ? '🎛️' : notFound ? '🫥' : '💀'),
      h('span', { class: 'eyebrow' }, unavailable ? '503 · transcode_unavailable' : `player error${error?.status ? ` · ${error.status}` : ''}`),
      h('h1', {}, unavailable ? 'ffmpeg is having a skill issue.' : notFound ? 'That media row ghosted us.' : 'This stream did not pass the vibe check.'),
      h('p', { class: 'muted' }, unavailable
        ? 'This file needs transcoding, but ffmpeg is off duty on the server. Direct-playable files still work.'
        : error?.message || 'The stream refused to load. The bits are unionizing.'),
      h('div', { class: 'row wrap', style: { justifyContent: 'center', marginTop: '10px' } },
        h('a', { class: 'btn', href: `/item/${mediaId}`, 'data-link': true }, 'Back to details'),
        h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again'),
        unavailable ? h('a', { class: 'btn ghost', href: '/admin#settings' }, 'Poke the admin') : null,
      ),
    ));
  }

  // ---------- shell ----------
  function buildShell() {
    const item = state.detail?.item || { id: mediaId, kind: 'movie', title: 'Loading…' };
    const poster = artFor(item, 'backdrop');
    const video = h('video', {
      class: 'watch-video',
      playsinline: true,
      preload: 'metadata',
      poster,
      'aria-label': 'Video player',
    });
    el.video = video;

    el.title = h('h2', { class: 'watch-title' }, 'Loading…');
    el.sub = h('div', { class: 'watch-sub' }, 'warming up the bits');
    el.badge = h('button', {
      class: 'watch-badge', type: 'button', 'data-focus': true,
      'aria-label': 'Stream mode details',
      onclick: () => toggleStats(),
    }, 'Checking…');
    el.partyChip = h('button', { class: 'watch-party-chip', type: 'button', hidden: true, 'data-focus': true });

    const back = h('a', { class: 'watch-back', href: `/item/${mediaId}`, 'data-link': true, 'data-focus': true, 'aria-label': 'Back to details' },
      h('span', { 'aria-hidden': 'true' }, '‹'), h('span', { class: 'watch-back-text' }, 'Back'));
    const topbar = h('header', { class: 'watch-top' },
      back,
      h('div', { class: 'watch-head-copy' }, el.title, el.sub),
      h('div', { class: 'watch-top-right' }, el.partyChip, el.badge),
    );

    el.spinner = h('div', { class: 'watch-spinner', hidden: true, role: 'status', 'aria-label': 'Buffering' }, h('span', { class: 'spinner' }));
    el.bigPlay = h('button', { class: 'watch-bigplay', type: 'button', 'aria-label': 'Play', 'data-focus': true, onclick: () => primePlay() },
      h('span', { class: 'watch-bigplay-icon', 'aria-hidden': 'true' }, '▶'),
      h('span', { class: 'watch-bigplay-label' }, 'play'));
    el.resume = h('div', { class: 'watch-resume', hidden: true, role: 'dialog', 'aria-label': 'Resume playback' });
    el.error = h('div', { class: 'watch-error', hidden: true, role: 'alert' });
    el.next = h('div', { class: 'watch-upnext', hidden: true });
    const stage = h('div', { class: 'watch-stage' }, video, el.spinner, el.bigPlay, el.resume, el.error, el.next);

    // seek bar (custom: buffered ranges + hover preview)
    el.seekBuffers = h('div', { class: 'seek-buffers', 'aria-hidden': 'true' });
    el.seekHover = h('i', { class: 'seek-hover', 'aria-hidden': 'true' });
    el.seekFill = h('i', { class: 'seek-fill', 'aria-hidden': 'true' });
    el.seekTip = h('div', { class: 'seek-tip', hidden: true }, '0:00');
    el.seek = h('div', {
      class: 'watch-seek', role: 'slider', tabindex: '0',
      'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0', 'aria-valuetext': '0:00',
      'data-focus': true,
    }, el.seekBuffers, el.seekHover, el.seekFill, el.seekTip);

    el.time = h('div', { class: 'watch-time' },
      h('span', { class: 'watch-time-current' }, '0:00'),
      h('span', { class: 'watch-time-sep' }, '/'),
      h('span', { class: 'watch-time-total' }, '0:00'));
    el.playBtn = ctrl('▶', 'Play', () => togglePlay(), 'watch-play');
    el.rwBtn = ctrl('↺', 'Rewind 10 seconds', () => seekBy(-SEEK_STEP), '', h('span', { class: 'ctrl-hint' }, '10'));
    el.ffBtn = ctrl('↻', 'Forward 10 seconds', () => seekBy(SEEK_STEP), '', h('span', { class: 'ctrl-hint' }, '10'));
    el.muteBtn = ctrl('🔊', 'Mute', () => toggleMute(), 'watch-mute');
    el.vol = h('input', {
      type: 'range', class: 'watch-vol', min: '0', max: '1', step: '0.01', value: '1',
      'aria-label': 'Volume', title: 'Volume',
      oninput: () => { el.video.volume = Number(el.vol.value); el.video.muted = el.video.volume === 0; syncVolume(); },
    });
    el.rateBtn = ctrl('1×', 'Playback speed', () => toggleMenu('rate'), 'watch-rate');
    el.audioBtn = ctrl('AUD', 'Audio track', () => toggleMenu('audio'), 'watch-audio');
    el.subBtn = ctrl('CC', 'Subtitles', () => toggleMenu('subs'), 'watch-subs');
    el.statsBtn = ctrl('Σ', 'Stream statistics (s)', () => toggleStats(), 'watch-stats-btn');
    el.pipBtn = ctrl('⧉', 'Picture in picture', () => togglePip(), 'watch-pip');
    el.fsBtn = ctrl('⛶', 'Fullscreen (f)', () => toggleFullscreen(), 'watch-fs');
    if (!document.pictureInPictureEnabled) el.pipBtn.hidden = true;

    el.pop = h('div', { class: 'watch-pop', role: 'menu', hidden: true });

    el.controls = h('footer', { class: 'watch-controls' },
      el.seek,
      h('div', { class: 'watch-ctrl-row' },
        h('div', { class: 'watch-ctrl-group' },
          el.playBtn, el.rwBtn, el.ffBtn,
          h('div', { class: 'watch-volume' }, el.muteBtn, el.vol),
          el.time,
        ),
        h('div', { class: 'watch-ctrl-group right' },
          el.rateBtn, el.audioBtn, el.subBtn, el.statsBtn, el.pipBtn, el.fsBtn,
        ),
      ),
    );

    el.statValues = {};
    const statRow = (label) => {
      el.statValues[label] = h('dd', {}, '—');
      return [h('dt', {}, label), el.statValues[label]];
    };
    el.statsPanel = h('aside', { class: 'watch-stats', hidden: true, 'aria-label': 'Stream statistics' },
      h('div', { class: 'watch-stats-head' },
        h('h2', {}, 'Stream stats'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close stats', onclick: () => toggleStats(false) }, '✕')),
      h('dl', { class: 'kv' },
        ...statRow('Mode'), ...statRow('Container'), ...statRow('Video'), ...statRow('Audio'),
        ...statRow('Resolution'), ...statRow('Bitrate'), ...statRow('Encoder'), ...statRow('Duration'), ...statRow('Buffer'),
        ...statRow('Dropped'), ...statRow('Source')),
      h('div', { class: 'watch-reasons', hidden: true },
        h('div', { class: 'eyebrow' }, 'Why this mode'),
        el.statReasons = h('ul', {})),
    );

    root = h('div', { class: 'watch', tabindex: '-1', 'aria-label': 'Video player' }, stage, topbar, el.statsPanel, el.controls, el.pop);
    container.replaceChildren(root);

    listen(el.video, 'loadedmetadata', onLoadedMetadata);
    listen(el.video, 'durationchange', () => { state.duration = currentDuration(); syncTime(); });
    listen(el.video, 'timeupdate', onTimeUpdate);
    listen(el.video, 'progress', updateBuffered);
    listen(el.video, 'playing', onPlaying);
    listen(el.video, 'play', onPlay);
    listen(el.video, 'pause', onPause);
    listen(el.video, 'waiting', () => setBuffering(true));
    listen(el.video, 'stalled', () => setBuffering(true));
    listen(el.video, 'canplay', () => setBuffering(false));
    listen(el.video, 'seeked', () => { state.wantsPlay = !el.video.paused; setBuffering(false); hug(); });
    listen(el.video, 'seeking', () => setBuffering(!el.video.paused));
    listen(el.video, 'volumechange', syncVolume);
    listen(el.video, 'ratechange', () => { el.rateBtn.firstChild.textContent = `${el.video.playbackRate}×`; });
    listen(el.video, 'ended', onEnded);
    listen(el.video, 'error', onVideoError);
    listen(el.seek, 'pointerdown', onSeekPointerDown);
    listen(el.seek, 'pointermove', onSeekPointerMove);
    listen(el.seek, 'pointerup', onSeekPointerUp);
    listen(el.seek, 'pointercancel', () => { seekState.dragging = false; });
    listen(el.seek, 'pointerleave', () => { if (!seekState.dragging) el.seekTip.hidden = true; });
    listen(el.seek, 'keydown', onSeekKeydown);
    listen(stage, 'click', onStageClick);
    listen(stage, 'dblclick', (event) => { if (event.target.closest('.watch-controls, .watch-resume, .watch-error, .watch-upnext, button')) return; toggleFullscreen(); });
    listen(document, 'pointermove', () => showControls(), { passive: true });
    listen(document, 'keydown', onKeyDown);
    bindSeekDrag();
  }

  function ctrl(label, aria, onclick, cls = '', extra = null) {
    return h('button', {
      class: `watch-ctrl ${cls}`, type: 'button', 'aria-label': aria, title: aria, 'data-focus': true, onclick,
    }, h('span', { class: 'ctrl-icon', 'aria-hidden': 'true' }, label), extra);
  }

  function fillHeader() {
    const item = state.detail?.item;
    const title = item?.title || (state.info ? `Media #${mediaId}` : 'Loading…');
    document.title = `${title} — watch`;
    el.title.textContent = title;
    const bits = [];
    if (item?.kind === 'episode') {
      if (state.detail?.show?.title) bits.push(state.detail.show.title);
      if (item.seasonNumber != null) bits.push(`S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber || 0).padStart(2, '0')}`);
    }
    if (item?.year) bits.push(String(item.year));
    const duration = pickNumber(state.info?.duration, item?.durationSeconds, item?.runtimeSeconds);
    if (duration) bits.push(fmtDuration(duration));
    if (item?.contentRating) bits.push(item.contentRating);
    el.sub.textContent = bits.join(' · ') || 'local bits, zero cloud';
    if (item?.art?.backdrop) el.video.poster = artFor(item, 'backdrop');
    updateBadge();
  }

  function findNextEpisode() {
    const direct = state.detail?.nextEpisode || state.detail?.item?.nextEpisode;
    if (direct?.id) return direct;
    const list = Array.isArray(state.detail?.episodes) ? state.detail.episodes : [];
    const index = list.findIndex((episode) => Number(episode.id) === mediaId);
    if (index >= 0 && list[index + 1]) return list[index + 1];
    return null;
  }

  function updateBadge() {
    if (!el.badge) return;
    const transcode = state.usingHls || state.info?.directPlay === false;
    const remux = state.usingHls && state.info?.mode === 'remux';
    el.badge.classList.toggle('transcode', transcode);
    el.badge.classList.toggle('direct', !transcode);
    el.badge.textContent = transcode ? (remux ? 'Remuxing' : 'Transcoding') : 'Direct Play';
    const reasons = activeReasons();
    el.badge.title = transcode
      ? `${remux ? 'Remux on the server: video copied, audio converted only if needed' : 'Transcoding on the server'}${reasons.length ? `: ${reasons.join(' · ')}` : ''}`
      : 'Direct play. Bits served raw, no ffmpeg in the loop.';
    el.badge.setAttribute('aria-label', el.badge.title);
  }

  function activeReasons() {
    const reasons = reasonText(state.info?.reasons) ? state.info.reasons.map((r) => (typeof r === 'string' ? r : r?.message || r?.code || '')).filter(Boolean) : [];
    if (state.activeAudio != null && state.defaultAudio != null && state.activeAudio !== state.defaultAudio) reasons.unshift('alternate audio track');
    if (state.burnSubs && state.activeSubtitle != null) reasons.unshift('burned-in subtitles');
    return reasons;
  }

  // ---------- source loading ----------
  function canDirectPlay() {
    const info = state.info;
    if (!info?.directPlay || !info.directUrl) return false;
    if (state.activeAudio != null && state.defaultAudio != null && state.activeAudio !== state.defaultAudio) return false;
    if (state.burnSubs && state.activeSubtitle != null) return false;
    return true;
  }

  function buildHlsUrl(startAt = 0) {
    const raw = state.info?.hlsUrl || `/api/stream/${mediaId}/hls/master.m3u8`;
    const url = new URL(raw, location.origin);
    url.searchParams.set('psid', state.playSessionId);
    if (startAt > 0.5) url.searchParams.set('start', String(Math.floor(startAt)));
    if (state.activeAudio != null) url.searchParams.set('audio', String(state.activeAudio));
    if (state.burnSubs && state.activeSubtitle != null) {
      url.searchParams.set('subtitle', String(state.activeSubtitle));
      url.searchParams.set('burn', '1');
    } else {
      url.searchParams.delete('subtitle');
      url.searchParams.delete('burn');
    }
    return `${url.pathname}${url.search}`;
  }

  async function loadMedia({ startAt = 0, autoplay = false } = {}) {
    if (!state.info || state.destroyed) return;
    const token = ++state.loadToken;
    state.ready = false;
    state.startAtPending = startAt;
    state.pendingPlay = autoplay;
    state.ended = false;
    el.next.hidden = true;
    cancelNext();
    destroyPlayback();
    state.hlsStart = 0;
    clearTracks();
    hidePlayerError();
    el.resume.hidden = true;
    setBuffering(true);

    if (canDirectPlay()) {
      state.usingHls = false;
      el.video.src = state.info.directUrl;
      updateBadge();
      return;
    }
    const url = buildHlsUrl(startAt);
    if (state.info.transcode?.available === false) {
      showPlayerError('Transcoding unavailable', 'ffmpeg is not available on this server, and this file is not direct-playable.');
      return;
    }
    state.usingHls = true;
    state.hlsStart = startAt;
    state.startAtPending = 0;
    updateBadge();
    await setupHls(url, token);
  }

  async function setupHls(url, token) {
    if (el.video.canPlayType('application/vnd.apple.mpegurl')) {
      el.video.src = url;
      return;
    }
    let Hls;
    try {
      Hls = await loadHls();
    } catch (error) {
      if (token === state.loadToken) showPlayerError('HLS player missing', `${error.message} Direct play only today.`);
      return;
    }
    if (token !== state.loadToken || state.destroyed) return;
    if (!Hls?.isSupported?.()) {
      showPlayerError('This browser cannot HLS', 'No Media Source Extensions, no transcode. Try Safari or a direct-playable file.');
      return;
    }
    try {
      // EVENT playlists look "live" to hls.js. We already baked the seek offset into ffmpeg, so
      // force local time 0 and pin the live-sync target far outside any real playlist; otherwise
      // a fast hardware encoder makes hls.js jump the playhead to the live edge.
      const hls = new Hls({
        maxBufferLength: 30, maxBufferSize: 60 * 1024 * 1024, backBufferLength: 30, enableWorker: true,
        startPosition: 0, liveSyncDurationCount: 1_000_000, liveMaxLatencyDurationCount: 1_000_001,
      });
      state.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(el.video);
      hls.on(Hls.Events.ERROR, (_event, data) => onHlsError(data));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== state.loadToken) return;
        state.restarting = false;
        try {
          // The playlist is EVENT (growing), which hls.js treats as live and would otherwise
          // start at the live edge. Our seek offset is already baked into ffmpeg's -ss, so
          // local media time 0 is the requested position.
          el.video.currentTime = 0;
          hls.startLoad(0);
        } catch { /* media not attached yet */ }
        syncTime();
        updateBuffered();
        if (state.pendingPlay) { state.pendingPlay = false; attemptPlay(); }
      });
    } catch (error) {
      showPlayerError('HLS session refused', error?.message || 'The transcoder hung up.');
    }
  }

  function onHlsError(data) {
    if (!data?.fatal || state.destroyed) return;
    const detailText = String(data.details || '');
    const segmentScoped = Boolean(data.frag) || /FRAG|BUFFER|PARSING/.test(detailText);
    if (segmentScoped && (state.restarting || Date.now() < state.seekGraceUntil)) {
      state.restarting = false;
      return;
    }
    state.restarting = false;
    const type = String(data.type || '');
    const detail = data.details ? ` (${data.details})` : '';
    if (type.includes('NETWORK')) {
      showPlayerError('The network ate the stream.', `HLS segments refused to load${detail}. The server may be busy transcoding.`);
    } else if (type.includes('MEDIA')) {
      showPlayerError('The decoder gave up.', `Media error while playing the transcode${detail}. Try direct play or a smaller file.`);
    } else {
      showPlayerError('HLS pooped the bed.', `Fatal playback error${detail}.`);
    }
  }

  function destroyPlayback() {
    if (state.hls) {
      try { state.hls.destroy(); } catch { /* already dead */ }
      state.hls = null;
    }
    if (!el.video) return;
    el.video.pause();
    el.video.removeAttribute('src');
    try { el.video.load(); } catch { /* source already gone */ }
  }

  function clearTracks() {
    if (!el.video) return;
    for (const track of [...el.video.querySelectorAll('track')]) track.remove();
    if (state.subBlobUrl) { URL.revokeObjectURL(state.subBlobUrl); state.subBlobUrl = null; }
  }

  function subtitleById(id) {
    const list = Array.isArray(state.info?.subtitles) ? state.info.subtitles : [];
    return list.find((sub) => String(sub.id) === String(id)) || null;
  }

  function parseVttTime(value) {
    const parts = String(value || '').trim().split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function formatVttTime(seconds) {
    const safe = Math.max(0, seconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
  }

  function shiftVtt(text, offset) {
    return String(text || '').split(/\r?\n/).map((line) => {
      if (!line.includes('-->')) return line;
      return line.replace(/(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}/g, (stamp) => {
        const seconds = parseVttTime(stamp.replace(',', '.'));
        return seconds == null ? stamp : formatVttTime(seconds - offset);
      });
    }).join('\n');
  }

  async function subtitleSrc(sub) {
    const base = sub.url || `/api/stream/${mediaId}/subtitles/${sub.id}.vtt`;
    if (!state.usingHls || state.hlsStart < 0.5) return base;
    try {
      const response = await fetch(base, { credentials: 'same-origin' });
      if (!response.ok) return base;
      const text = await response.text();
      if (state.subBlobUrl) URL.revokeObjectURL(state.subBlobUrl);
      state.subBlobUrl = URL.createObjectURL(new Blob([shiftVtt(text, state.hlsStart)], { type: 'text/vtt' }));
      return state.subBlobUrl;
    } catch {
      return base;
    }
  }

  async function applyTracks() {
    clearTracks();
    if (state.activeSubtitle == null || state.burnSubs) return;
    const sub = subtitleById(state.activeSubtitle);
    if (!sub) return;
    const src = await subtitleSrc(sub);
    if (state.destroyed || String(state.activeSubtitle) !== String(sub.id) || state.burnSubs) return;
    const track = h('track', {
      kind: 'subtitles',
      label: langLabel(sub),
      srclang: srclang(sub.language),
      src,
      default: true,
    });
    track.addEventListener('error', () => {
      if (state.activeSubtitle === sub.id && !state.burnSubs) {
        toast('That subtitle track failed to render. Burn it into the video instead.', 'error');
      }
    });
    track.addEventListener('load', () => showTextTrack());
    el.video.append(track);
    later(showTextTrack, 250);
  }

  function showTextTrack() {
    if (state.activeSubtitle == null || state.burnSubs) return;
    const list = el.video.textTracks;
    for (let i = 0; i < list.length; i += 1) list[i].mode = 'showing';
  }

  // ---------- resume ----------
  function maybePromptResume() {
    const progress = state.resume;
    if (!progress || progress.finished) return false;
    const duration = currentDuration();
    const startThreshold = duration ? Math.max(3, Math.min(30, duration * 0.08)) : 30;
    if (progress.position < startThreshold) return false;
    if (duration && progress.position > duration - Math.min(20, duration * 0.1)) return false;
    el.resume.hidden = false;
    el.bigPlay.hidden = true;
    const position = progress.position;
    el.resume.replaceChildren(
      h('span', { class: 'eyebrow' }, 'Welcome back, slopper'),
      h('h2', {}, `Continue at ${fmtClock(position)}?`),
      h('p', { class: 'muted' }, `Your last brain cell clocked out ${fmtDuration(position, { clock: true })} in.`),
      h('div', { class: 'row wrap' },
        h('button', {
          class: 'btn primary', type: 'button', 'data-focus': true,
          onclick: () => loadMedia({ startAt: position, autoplay: true }),
        }, `Continue from ${fmtClock(position)}`),
        h('button', {
          class: 'btn ghost', type: 'button', 'data-focus': true,
          onclick: () => loadMedia({ startAt: 0, autoplay: true }),
        }, 'Start over, no thoughts'),
      ),
      h('button', { class: 'mini-link resume-dismiss', type: 'button', onclick: () => { el.resume.hidden = true; loadMedia({ startAt: 0, autoplay: false }); } }, 'Just show me the poster'),
    );
    later(() => el.resume.querySelector('.btn.primary')?.focus({ preventScroll: true }), 80);
    return true;
  }

  // ---------- up next ----------
  function offerNextEpisode() {
    if (!state.nextItem?.id || state.party) return;
    const next = state.nextItem;
    const showName = state.detail?.show?.title;
    state.nextCount = 5;
    el.next.hidden = false;
    el.next.replaceChildren(
      h('div', { class: 'upnext-art' }, h('img', { src: artFor(next, 'thumb'), alt: '', loading: 'lazy' })),
      h('div', { class: 'upnext-copy' },
        h('span', { class: 'eyebrow' }, 'Up next'),
        h('h3', {}, next.title || 'Next episode'),
        h('p', { class: 'muted small' }, [showName, next.seasonNumber != null ? `S${String(next.seasonNumber).padStart(2, '0')}E${String(next.episodeNumber || 0).padStart(2, '0')}` : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'row' }, h('span', { class: 'upnext-count' }, `Playing in 5s`))),
      h('div', { class: 'upnext-actions' },
        h('button', { class: 'btn primary small', type: 'button', onclick: goNext }, 'Play now'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: cancelNext }, 'Cancel')),
    );
    clearInterval(state.nextTimer);
    state.nextTimer = setInterval(() => {
      if (state.destroyed) return;
      state.nextCount -= 1;
      const counter = el.next.querySelector('.upnext-count');
      if (counter) counter.textContent = state.nextCount > 0 ? `Playing in ${state.nextCount}s` : 'Going…';
      if (state.nextCount <= 0) goNext();
    }, 1000);
    timers.add(state.nextTimer);
  }

  function goNext() {
    if (!state.nextItem?.id) return;
    const suffix = state.partyId ? `?party=${encodeURIComponent(state.partyId)}` : '';
    cancelNext();
    ctx.navigate(`/watch/${state.nextItem.id}${suffix}`);
  }

  function cancelNext() {
    if (state.nextTimer) {
      clearInterval(state.nextTimer);
      timers.delete(state.nextTimer);
      state.nextTimer = null;
    }
    if (el.next) el.next.hidden = true;
  }


  // ---------- playback core ----------
  function currentDuration() {
    const known = pickNumber(state.info?.duration, state.detail?.item?.durationSeconds, state.detail?.item?.runtimeSeconds);
    if (state.usingHls) return known || 0;
    const live = el.video && Number.isFinite(el.video.duration) && el.video.duration > 0 ? el.video.duration : 0;
    return live || known;
  }

  function logicalPosition() {
    const base = Number(el.video?.currentTime) || 0;
    return state.usingHls ? Math.max(0, base + state.hlsStart) : base;
  }

  function mediaTimeFor(position) {
    return state.usingHls ? Math.max(0, position - state.hlsStart) : Math.max(0, position);
  }

  function primePlay() {
    if (!state.ready) { state.pendingPlay = true; showControls(); return; }
    attemptPlay();
  }

  function requestPlay() {
    state.wantsPlay = true;
    if (state.ready && el.video.readyState >= 1) attemptPlay();
    else { state.pendingPlay = true; showControls(); }
  }

  function attemptPlay() {
    const promise = el.video.play();
    if (promise?.catch) {
      promise.catch((error) => {
        if (error?.name === 'AbortError') return;
        state.wantsPlay = false;
        syncPlayIcon();
        if (error?.name === 'NotAllowedError') {
          showControls();
          if (!state.autoplayNagged) {
            state.autoplayNagged = true;
            toast('Browser blocked autoplay. Tap play, boss.', 'info', { emoji: '🫸' });
          }
        } else {
          showPlayerError('Playback refused to start.', error?.message || 'The decoder said no.');
        }
      });
    }
  }

  function togglePlay() {
    if (el.video.paused) requestPlay();
    else el.video.pause();
  }

  function seekBy(delta) {
    const duration = currentDuration();
    if (!duration) return;
    seekTo(Math.min(Math.max(logicalPosition() + delta, 0), Math.max(duration - 0.25, 0)));
  }

  function hlsBufferedEnd() {
    try {
      return el.video.buffered.length ? el.video.buffered.end(el.video.buffered.length - 1) : 0;
    } catch {
      return 0;
    }
  }

  /** hls.js knows how far the growing playlist reaches; jump inside it without a restart. */
  function hlsEncodedEnd() {
    const levels = state.hls?.levels || [];
    const details = levels[state.hls?.currentLevel ?? 0]?.details || levels[0]?.details;
    const fragments = details?.fragments;
    if (!fragments?.length) return 0;
    const last = fragments[fragments.length - 1];
    return Number(last.start || 0) + Number(last.duration || 0);
  }

  /** Outside the encoded/buffered window? Restart the same session at the target, Plex-style. */
  function needsTranscodeRestart(target) {
    if (!state.usingHls) return false;
    const local = target - state.hlsStart;
    const encoded = Math.max(hlsEncodedEnd(), hlsBufferedEnd());
    return local < 0.25 || local > encoded + 1;
  }

  function restartTranscodeAt(target) {
    const wasPlaying = !el.video.paused || state.pendingPlay;
    if (!el.video.paused) el.video.pause();
    state.hlsStart = target;
    state.startAtPending = 0;
    state.pendingPlay = wasPlaying;
    setBuffering(true);
    showControls();
    hidePlayerError();
    state.seekGraceUntil = Date.now() + 6000;
    try { el.video.currentTime = 0; } catch { /* source is mid-swap */ }
    if (!state.burnSubs) applyTracks();
    if (!state.hls) {
      loadMedia({ startAt: target, autoplay: wasPlaying });
      return;
    }
    state.restarting = true;
    try {
      state.hls.stopLoad();
      state.hls.loadSource(buildHlsUrl(target));
    } catch {
      state.restarting = false;
      loadMedia({ startAt: target, autoplay: wasPlaying });
    }
  }

  function seekTo(seconds, { save = false } = {}) {
    const duration = currentDuration();
    if (!duration) return;
    const target = Math.min(Math.max(seconds, 0), Math.max(duration - 0.25, 0));
    if (needsTranscodeRestart(target)) {
      syncSeekValue(target, duration);
      restartTranscodeAt(target);
      saveProgress({ force: save });
      return;
    }
    el.video.currentTime = mediaTimeFor(target);
    syncSeekValue(target);
    showControls();
    hug();
    saveProgress({ force: save });
  }

  function onLoadedMetadata() {
    state.duration = currentDuration();
    if (state.usingHls) {
      // Native HLS (Safari) also treats an EVENT playlist as live; force the requested offset.
      try { if (el.video.currentTime > 1) el.video.currentTime = 0; } catch { /* manifest not ready */ }
    } else if (state.startAtPending > 0) {
      try { el.video.currentTime = state.startAtPending; } catch { /* seek is best effort */ }
      state.startAtPending = 0;
    }
    if (!state.ready) {
      state.ready = true;
      applyTracks();
      if (state.pendingPlay) { state.pendingPlay = false; attemptPlay(); }
    }
    syncPlayIcon();
    syncTime();
    updateBuffered();
    updateStats();
  }

  function onTimeUpdate() {
    syncTime();
    updateBuffered();
    if (state.statsOpen) updateStats();
    el.resume.hidden = true;
  }

  function onPlay() {
    state.wantsPlay = true;
    syncPlayIcon();
    scheduleHide();
    hug();
    if (state.party) publishParty();
  }

  function onPause() {
    state.wantsPlay = false;
    syncPlayIcon();
    showControls();
    saveProgress({ force: true });
    if (state.party) publishParty();
  }

  function onPlaying() {
    setBuffering(false);
    syncPlayIcon();
    scheduleHide();
  }

  function onEnded() {
    state.ended = true;
    setBuffering(false);
    syncPlayIcon();
    showControls();
    saveProgress({ force: true, finished: true });
    if (state.party && !state.isHost) { publishParty(); return; }
    offerNextEpisode();
  }

  function onVideoError() {
    if (!el.video.currentSrc && !el.video.src) return;
    if (state.destroyed) return;
    if (state.restarting || Date.now() < state.seekGraceUntil) return;
    showPlayerError('The stream fell over.', 'The browser could not decode this source. Blame the codec, not yourself.');
  }

  function showPlayerError(title, message) {
    if (!el.error) return;
    el.spinner.hidden = true;
    el.error.hidden = false;
    el.error.replaceChildren(
      h('div', { class: 'watch-error-emoji', 'aria-hidden': 'true' }, '💀'),
      h('h3', {}, title),
      h('p', { class: 'muted small' }, message),
      h('div', { class: 'row wrap', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', type: 'button', onclick: () => { hidePlayerError(); loadMedia({ startAt: logicalPosition(), autoplay: true }); } }, 'Retry stream'),
        h('a', { class: 'btn', href: `/item/${mediaId}`, 'data-link': true }, 'Give up gracefully'),
      ),
    );
  }

  function hidePlayerError() {
    if (!el.error) return;
    el.error.hidden = true;
    el.error.replaceChildren();
  }

  function setBuffering(on) {
    if (!el.spinner) return;
    el.spinner.hidden = !(on && el.error.hidden);
  }

  function syncPlayIcon() {
    if (!el.playBtn) return;
    const playing = !el.video.paused && !el.video.ended;
    el.playBtn.firstChild.textContent = playing ? '❚❚' : '▶';
    el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    el.playBtn.title = playing ? 'Pause (space)' : 'Play (space)';
    if (el.bigPlay) el.bigPlay.hidden = playing || !state.ready || !el.resume.hidden || !el.error.hidden;
  }

  function syncTime() {
    const duration = currentDuration();
    const position = logicalPosition();
    el.time.querySelector('.watch-time-current').textContent = fmtClock(position);
    el.time.querySelector('.watch-time-total').textContent = duration ? fmtClock(duration) : '—';
    syncSeekValue(position, duration);
  }

  function syncSeekValue(position, duration = currentDuration()) {
    if (!el.seek) return;
    const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
    el.seekFill.style.width = `${pct}%`;
    el.seek.setAttribute('aria-valuemax', String(Math.round(duration)));
    el.seek.setAttribute('aria-valuenow', String(Math.round(position)));
    el.seek.setAttribute('aria-valuetext', `${fmtClock(position)} of ${fmtClock(duration)}`);
  }

  function updateBuffered() {
    if (!el.seekBuffers) return;
    const duration = currentDuration();
    if (!duration) { el.seekBuffers.replaceChildren(); return; }
    const ranges = [];
    try {
      for (let i = 0; i < el.video.buffered.length; i += 1) {
        const start = el.video.buffered.start(i) + state.hlsStart;
        const end = el.video.buffered.end(i) + state.hlsStart;
        if (end <= start) continue;
        ranges.push(h('span', {
          class: 'seek-buffer',
          style: { left: `${Math.min(100, (start / duration) * 100)}%`, width: `${Math.min(100, ((end - start) / duration) * 100)}%` },
        }));
      }
    } catch { /* buffered can throw after a source swap */ }
    el.seekBuffers.replaceChildren(...ranges);
  }

  function onSeekPointerDown(event) {
    if (!currentDuration()) return;
    seekState.dragging = true;
    seekState.preview = 0;
    try { el.seek.setPointerCapture(event.pointerId); } catch { /* pointer capture optional */ }
    updateSeekPreview(event, true);
    event.preventDefault();
  }

  function onSeekPointerMove(event) {
    if (!currentDuration()) return;
    updateSeekPreview(event, seekState.dragging);
  }

  function updateSeekPreview(event, dragging) {
    const duration = currentDuration();
    if (!duration) return;
    const rect = el.seek.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)));
    seekState.preview = ratio * duration;
    const pct = ratio * 100;
    el.seekHover.style.left = `${pct}%`;
    el.seekTip.style.left = `${Math.min(96, Math.max(4, pct))}%`;
    el.seekTip.textContent = fmtClock(seekState.preview);
    el.seekTip.hidden = false;
    if (dragging) el.seekFill.style.width = `${pct}%`;
  }

  function onSeekPointerUp(event) {
    if (!seekState.dragging) return;
    seekState.dragging = false;
    try { el.seek.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    seekTo(seekState.preview, { save: true });
    later(() => { if (!seekState.dragging) el.seekTip.hidden = true; }, 900);
  }

  function onSeekKeydown(event) {
    const duration = currentDuration();
    if (!duration) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); }
    else if (event.key === 'PageUp') { event.preventDefault(); seekBy(30); }
    else if (event.key === 'PageDown') { event.preventDefault(); seekBy(-30); }
    else if (event.key === 'Home') { event.preventDefault(); seekTo(0); }
    else if (event.key === 'End') { event.preventDefault(); seekTo(duration - 0.5); }
  }

  function bindSeekDrag() {
    listen(el.seek, 'lostpointercapture', () => { seekState.dragging = false; });
  }

  function syncVolume() {
    if (!el.muteBtn) return;
    const muted = el.video.muted || el.video.volume === 0;
    el.muteBtn.firstChild.textContent = muted ? '🔇' : el.video.volume < 0.5 ? '🔉' : '🔊';
    el.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    el.muteBtn.classList.toggle('is-muted', muted);
    el.vol.value = String(el.video.volume);
    el.vol.style.setProperty('--vol', `${el.video.volume * 100}%`);
  }

  function toggleMute() {
    el.video.muted = !el.video.muted;
    if (!el.video.muted && el.video.volume === 0) el.video.volume = 0.6;
    syncVolume();
  }

  function showControls() {
    if (!root) return;
    root.classList.remove('controls-hidden');
    scheduleHide();
  }

  function hideControls() {
    if (!root || !state.ready) return;
    if (!el.video.paused || state.menu || state.statsOpen || !el.resume.hidden || !el.error.hidden || !el.next.hidden) return;
    const active = document.activeElement;
    if (active && active !== el.video && root.contains(active) && active.matches?.(':focus-visible')) return;
    el.pop.hidden = true;
    state.menu = null;
    root.classList.add('controls-hidden');
  }

  function scheduleHide() {
    if (state.controlsTimer) { clearTimeout(state.controlsTimer); timers.delete(state.controlsTimer); }
    if (el.video.paused) return;
    state.controlsTimer = later(() => { state.controlsTimer = null; hideControls(); }, 3200);
  }

  function onStageClick(event) {
    if (event.target.closest('.watch-resume, .watch-error, .watch-upnext, .watch-bigplay, .watch-spinner')) return;
    if (!state.ready) return;
    if (state.menu) { closeMenu(); return; }
    showControls();
    if (root.classList.contains('controls-hidden')) { root.classList.remove('controls-hidden'); scheduleHide(); }
    else hideControls();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    const request = root?.requestFullscreen || root?.webkitRequestFullscreen;
    if (request) request.call(root).catch(() => toast('Fullscreen said nope. Browser things.', 'error'));
    else if (el.video?.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
    else toast('This browser has no fullscreen. Brutal.', 'error');
  }

  function syncFullscreenIcon() {
    if (!el.fsBtn) return;
    const on = Boolean(document.fullscreenElement);
    el.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen (f)' : 'Fullscreen (f)');
    el.fsBtn.classList.toggle('is-active', on);
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.video.requestPictureInPicture();
    } catch {
      toast('Picture-in-picture refused. Rude.', 'error');
    }
  }

  function setRate(rate) {
    el.video.playbackRate = rate;
    el.rateBtn.firstChild.textContent = `${rate}×`;
    closeMenu();
    toast(`Speed: ${rate}×.`, 'fun', { emoji: rate >= 2 ? '⚡' : '🏃' });
  }

  function toggleStats(force) {
    const open = typeof force === 'boolean' ? force : !state.statsOpen;
    state.statsOpen = open;
    el.statsPanel.hidden = !open;
    el.statsBtn.classList.toggle('is-active', open);
    if (open) { showControls(); updateStats(); }
  }

  function bitrateLabel(bps) {
    const value = Number(bps);
    if (!Number.isFinite(value) || value <= 0) return '—';
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1000)} kbps`;
  }

  function updateStats() {
    if (!state.statsOpen || !state.info) return;
    const info = state.info;
    const transcode = state.usingHls || info.directPlay === false;
    const duration = currentDuration();
    let buffer = 0;
    try {
      for (let i = 0; i < el.video.buffered.length; i += 1) {
        if (el.video.buffered.start(i) <= el.video.currentTime && el.video.buffered.end(i) >= el.video.currentTime) {
          buffer = el.video.buffered.end(i) - el.video.currentTime;
        }
      }
    } catch { buffer = 0; }
    const quality = el.video.getVideoPlaybackQuality?.();
    const set = (key, value) => { if (el.statValues[key]) el.statValues[key].textContent = value; };
    set('Mode', transcode ? (info.mode === 'remux' ? 'Remuxing (HLS)' : 'Transcoding (HLS)') : 'Direct Play');
    set('Container', info.container || '—');
    set('Video', [info.videoCodec || '?', info.fps ? `${Math.round(info.fps)} fps` : ''].filter(Boolean).join(' · '));
    set('Audio', [info.audioCodec || '?', state.activeAudio != null ? `track ${state.activeAudio}` : ''].filter(Boolean).join(' · '));
    set('Resolution', info.width && info.height ? `${info.width}×${info.height}` : 'unknown');
    set('Bitrate', bitrateLabel(info.bitrate));
    set('Encoder', transcode && info.transcode?.hardware
      ? `${info.transcode.hardware.encoder}${info.transcode.hardware.active ? '' : ' (software)'}`
      : '—');
    set('Duration', duration ? fmtClock(duration) : '—');
    set('Buffer', `${buffer.toFixed(1)}s`);
    set('Dropped', quality ? `${quality.droppedVideoFrames} / ${quality.totalVideoFrames}` : '—');
    set('Source', transcode ? (info.hlsUrl || 'HLS session') : streamSourceFor(info));
    const reasons = activeReasons();
    const panel = el.statReasons.closest('.watch-reasons');
    panel.hidden = reasons.length === 0;
    el.statReasons.replaceChildren(...reasons.map((reason) => h('li', {}, reason)));
  }

  // ---------- menus ----------
  function toggleMenu(kind) {
    if (state.menu === kind) { closeMenu(); return; }
    state.menu = kind;
    el.pop.hidden = false;
    renderMenu();
    showControls();
  }

  function closeMenu() {
    state.menu = null;
    if (!el.pop) return;
    el.pop.hidden = true;
    el.pop.replaceChildren();
    scheduleHide();
  }

  function menuHeader(title) {
    return h('div', { class: 'watch-pop-head' },
      h('span', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close menu', onclick: closeMenu }, '✕'));
  }

  function menuItem(label, meta, active, onClick, extraCls = '') {
    return h('button', {
      class: `watch-menu-item${active ? ' active' : ''} ${extraCls}`, type: 'button', role: 'menuitem', 'aria-pressed': active ? 'true' : 'false',
      onclick: onClick,
    },
      h('span', { class: 'menu-check', 'aria-hidden': 'true' }, active ? '✓' : ''),
      h('span', { class: 'menu-label' }, label),
      meta ? h('span', { class: 'menu-meta' }, meta) : null);
  }

  function renderMenu() {
    if (!state.menu) return;
    if (state.menu === 'rate') renderRateMenu();
    else if (state.menu === 'audio') renderAudioMenu();
    else if (state.menu === 'subs') renderSubtitleMenu();
  }

  function renderRateMenu() {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    el.pop.replaceChildren(
      menuHeader('Playback speed'),
      ...rates.map((rate) => menuItem(`${rate}×`, rate === 1 ? 'normal' : rate < 1 ? 'slomo' : 'speedrun', el.video.playbackRate === rate, () => setRate(rate))),
    );
  }

  function renderAudioMenu() {
    const tracks = Array.isArray(state.info?.audioTracks) ? state.info.audioTracks : [];
    const children = [menuHeader('Audio track')];
    if (!tracks.length) {
      children.push(h('p', { class: 'watch-pop-note' }, 'No audio tracks reported. Silent film era, respect.'));
    } else {
      for (const track of tracks) {
        const active = state.activeAudio != null && track.index === state.activeAudio;
        const meta = [track.codec, track.channels ? `${track.channels}ch` : '', track.default ? 'default' : ''].filter(Boolean).join(' · ');
        children.push(menuItem(channelLabel(track), meta, active, () => selectAudio(track.index)));
      }
      if (tracks.length > 1) children.push(h('p', { class: 'watch-pop-note' }, 'Switching tracks spins up a fresh HLS session. Bits may buffer.'));
    }
    el.pop.replaceChildren(...children);
  }

  function renderSubtitleMenu() {
    const subs = Array.isArray(state.info?.subtitles) ? state.info.subtitles : [];
    const children = [menuHeader('Subtitles')];
    children.push(menuItem('Off', 'rawdog dialogue', state.activeSubtitle == null, () => selectSubtitle(null)));
    for (const sub of subs) {
      const meta = [String(sub.language || '').toUpperCase(), sub.format || '', sub.forced ? 'forced' : '', sub.isExternal ? 'external' : 'embedded'].filter(Boolean).join(' · ');
      children.push(menuItem(langLabel(sub), meta, String(state.activeSubtitle) === String(sub.id), () => selectSubtitle(sub.id)));
    }
    if (!subs.length) children.push(h('p', { class: 'watch-pop-note' }, 'No subtitle tracks. Whatever they said, it was probably slop.'));
    if (state.activeSubtitle != null) {
      children.push(h('div', { class: 'watch-pop-divider' }));
      children.push(h('button', {
        class: `watch-burn${state.burnSubs ? ' active' : ''}`, type: 'button', 'aria-pressed': state.burnSubs ? 'true' : 'false',
        onclick: toggleBurn,
      },
        h('span', { class: 'burn-switch', 'aria-hidden': 'true' }, h('i', {})),
        h('span', {}, 'Burn into video'),
        h('span', { class: 'menu-meta' }, 'forces transcode')));
      children.push(h('p', { class: 'watch-pop-note' }, 'Burn-in is permanent for this session. Server-side pixels, no off switch until reload.'));
    }
    el.pop.replaceChildren(...children);
  }

  function selectAudio(index) {
    if (index === state.activeAudio) { closeMenu(); return; }
    const position = logicalPosition();
    const wasPlaying = !el.video.paused;
    state.activeAudio = index;
    const track = (state.info.audioTracks || []).find((entry) => entry.index === index);
    closeMenu();
    toast(`Audio: ${track ? channelLabel(track) : `track ${index}`}`, 'info', { emoji: '🔊' });
    loadMedia({ startAt: position, autoplay: wasPlaying });
  }

  function selectSubtitle(id) {
    if (id == null) {
      state.activeSubtitle = null;
      state.burnSubs = false;
      applyTracks();
      closeMenu();
      toast('Subtitles off. Dialogue roulette.', 'fun', { emoji: '💬' });
      return;
    }
    const changed = String(state.activeSubtitle) !== String(id);
    state.activeSubtitle = id;
    if (state.burnSubs) {
      const position = logicalPosition();
      const wasPlaying = !el.video.paused;
      closeMenu();
      loadMedia({ startAt: position, autoplay: wasPlaying });
      return;
    }
    applyTracks();
    renderSubtitleMenu();
    if (changed) toast(`Subtitles: ${langLabel(subtitleById(id) || {})}`, 'info', { emoji: '💬' });
  }

  function toggleBurn() {
    if (state.activeSubtitle == null) {
      toast('Pick a subtitle track first, chief.', 'error');
      return;
    }
    const position = logicalPosition();
    const wasPlaying = !el.video.paused;
    state.burnSubs = !state.burnSubs;
    renderSubtitleMenu();
    loadMedia({ startAt: position, autoplay: wasPlaying });
    toast(state.burnSubs
      ? 'Burn-in on. Subtitles are now part of the pixels.'
      : 'Burn-in off. Back to polite subtitle rendering.', 'fun', { emoji: state.burnSubs ? '🔥' : '💬' });
  }

  function toggleSubtitlesKey() {
    if (state.activeSubtitle != null) {
      selectSubtitle(null);
      return;
    }
    const subs = state.info?.subtitles || [];
    if (!subs.length) { toast('No subtitles in this file. Rawdog it.', 'info', { emoji: '💬' }); return; }
    selectSubtitle(subs[0].id);
  }

  // ---------- progress heartbeat ----------
  function progressPayload({ finished = null, ended = null } = {}) {
    const position = logicalPosition();
    const duration = currentDuration();
    const payload = {
      positionSeconds: Math.round(position * 10) / 10,
      durationSeconds: Math.round(duration * 10) / 10,
    };
    if (state.usingHls) payload.mode = 'transcode';
    if (finished != null) payload.finished = Boolean(finished);
    if (ended != null) payload.ended = Boolean(ended);
    return payload;
  }

  async function saveProgress({ force = false, finished = null } = {}) {
    if (!state.info || state.destroyed) return;
    const position = logicalPosition();
    if (!finished && position < 1.5) return;
    if (!force && Math.abs(position - state.lastSaved) < 1) return;
    if (state.saving) return;
    state.saving = true;
    state.lastSaved = position;
    try {
      await post(`/api/stream/${mediaId}/progress`, progressPayload({ finished }));
    } catch { /* resume points are best effort; never block playback */ }
    finally { state.saving = false; }
  }

  function releasePlaybackSession() {
    if (!state.playSessionId) return;
    try {
      const url = `/api/stream/${mediaId}/hls/release`;
      const blob = new Blob([JSON.stringify({ psid: state.playSessionId })], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
      else fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ psid: state.playSessionId }), keepalive: true }).catch(() => {});
    } catch { /* session will be swept by the idle timer */ }
  }

  function flushProgressBeacon() {
    if (!state.info || !navigator.sendBeacon) return;
    const position = logicalPosition();
    if (position < 1.5 && !state.ended) return;
    const payload = progressPayload({ ended: true });
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon(`/api/stream/${mediaId}/progress`, blob);
  }

  // ---------- party sync ----------
  async function setupParty() {
    const requested = ctx.query.party ? String(ctx.query.party) : '';
    let party = null;
    if (requested) {
      try {
        const found = await get(`/api/parties/${encodeURIComponent(requested)}`, { signal: ctx.signal });
        party = found?.party || found;
      } catch { party = null; }
    }
    if (!party?.id) {
      try {
        const list = await get(`/api/parties?mediaId=${mediaId}&pageSize=1`, { signal: ctx.signal });
        party = (list?.items || list?.parties || [])[0] || null;
      } catch { party = null; }
    }
    if (ctx.signal?.aborted || !party?.id) return;
    state.party = party;
    state.partyId = String(party.id);
    state.isHost = party.isHost === true;
    if (requested) {
      try { await post(`/api/parties/${party.id}/join`, {}); state.joined = true; } catch { state.joined = false; }
    }
    renderPartyChip();
    state.partyEvents = connectEvents({
      'party.sync': (data) => {
        if (!data || String(data.partyId) !== String(state.partyId)) return;
        if (data.ended) {
          toast('Party ended. Back to solo slop.', 'fun', { emoji: '🫡' });
          el.video.pause();
          state.party = null;
          state.partyEvents?.close();
          state.partyEvents = null;
          renderPartyChip();
          return;
        }
        onPartySync(data);
      },
    });
  }

  function renderPartyChip() {
    if (!el.partyChip) return;
    if (!state.party) { el.partyChip.hidden = true; return; }
    el.partyChip.hidden = false;
    el.partyChip.classList.toggle('host', state.isHost);
    el.partyChip.replaceChildren(
      h('span', { class: 'party-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'party-role' }, state.isHost ? 'Hosting' : 'Synced'),
      h('span', { class: 'party-name' }, state.party.name || 'party'),
    );
    el.partyChip.title = `${state.party.name || 'Party'} · ${state.isHost ? 'you call the shots' : 'following the host'}`;
    el.partyChip.onclick = () => ctx.navigate(`/party/${state.partyId}`);
  }

  function onPartySync(data) {
    if (!state.party) return;
    const position = Number(data.position) || 0;
    const paused = Boolean(data.paused);
    state.partyPosition = position;
    state.partyPaused = paused;
    state.partyUpdatedAt = Date.now();
    state.syncedAt = Date.now();
    if (state.isHost) return;
    if (state.usingHls && position + 0.5 < state.hlsStart) {
      state.hlsStart = position;
      loadMedia({ startAt: position, autoplay: !paused });
      return;
    }
    if (paused) {
      if (!el.video.paused) el.video.pause();
      if (Number.isFinite(position)) {
        try { el.video.currentTime = mediaTimeFor(position); } catch { /* manifest not ready yet */ }
      }
      return;
    }
    if (state.ready && Math.abs(logicalPosition() - position) > 1.5) {
      try { el.video.currentTime = mediaTimeFor(position); } catch { /* seeking before manifest is best effort */ }
    }
    if (el.video.paused) requestPlay();
  }

  function publishParty() {
    if (!state.isHost || !state.partyId) return;
    const send = () => {
      state.partyPublishAt = Date.now();
      post(`/api/parties/${state.partyId}/state`, {
        position: Math.round(logicalPosition() * 10) / 10,
        paused: el.video.paused,
      }).catch(() => { /* sync is best effort */ });
    };
    const wait = 900 - (Date.now() - state.partyPublishAt);
    if (wait <= 0) { send(); return; }
    if (state.partyPublishTimer) return;
    state.partyPublishTimer = later(() => { state.partyPublishTimer = null; send(); }, wait);
  }

  function hug() {
    if (state.party) publishParty();
  }

  // ---------- keyboard ----------
  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (typing) return;
    const control = target instanceof HTMLElement ? target.closest('button, a, [role="slider"]') : null;

    if (event.key === 'Escape') {
      if (state.menu) { closeMenu(); return; }
      if (state.statsOpen) { toggleStats(false); return; }
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return; }
      if (!el.resume.hidden) { el.resume.hidden = true; return; }
      ctx.navigate(`/item/${mediaId}`);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (control && (event.key === ' ' || event.key === 'Enter')) return;

    const key = event.key.toLowerCase();
    if (key === ' ' || key === 'k') { event.preventDefault(); togglePlay(); }
    else if (key === 'arrowleft') { event.preventDefault(); seekBy(-SEEK_STEP); }
    else if (key === 'arrowright') { event.preventDefault(); seekBy(SEEK_STEP); }
    else if (key === 'arrowup') { event.preventDefault(); el.video.volume = Math.min(1, Math.round((el.video.volume + 0.1) * 100) / 100); syncVolume(); }
    else if (key === 'arrowdown') { event.preventDefault(); el.video.volume = Math.max(0, Math.round((el.video.volume - 0.1) * 100) / 100); syncVolume(); }
    else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    else if (key === 'm') { event.preventDefault(); toggleMute(); }
    else if (key === 'c') { event.preventDefault(); toggleSubtitlesKey(); }
    else if (key === 's') { event.preventDefault(); toggleStats(); }
    else return;
    showControls();
  }

  // ---------- teardown ----------
  function teardown() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.loadToken += 1;
    flushProgressBeacon();
    releasePlaybackSession();
    cancelNext();
    if (state.partyEvents) { state.partyEvents.close(); state.partyEvents = null; }
    abort.abort();
    cleanupTimers();
    destroyPlayback();
    document.body.classList.remove('watch-open');
    if (root?.parentNode) root.remove();
    document.title = state.previousTitle;
  }

  every(() => { if (!el.video.paused && !document.hidden) saveProgress(); }, AUTOSAVE_MS);
  every(() => {
    if (state.party && state.isHost && !el.video.paused) publishParty();
  }, 4000);
  every(() => {
    if (!state.party || state.isHost || state.partyPaused) return;
    const target = state.partyPosition + (Date.now() - state.partyUpdatedAt) / 1000;
    if (Number.isFinite(target) && state.ready && Math.abs(logicalPosition() - target) > 2.5) el.video.currentTime = mediaTimeFor(target);
  }, 5000);
  listen(document, 'visibilitychange', () => { if (document.hidden) saveProgress({ force: true }); });
  listen(window, 'pagehide', releasePlaybackSession);
  listen(document, 'fullscreenchange', syncFullscreenIcon);
  listen(document, 'pointerdown', (event) => {
    if (!state.menu) return;
    if (event.target.closest('.watch-pop, .watch-controls')) return;
    closeMenu();
  });
  syncPlayIcon();
  syncVolume();
  syncFullscreenIcon();
  updateBadge();
  return teardown;
}




