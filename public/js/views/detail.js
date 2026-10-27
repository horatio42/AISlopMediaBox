// Detail — one page to rule every kind: film, show, album, photo, whatever this is.
import { api, artFor, fmtBytes, fmtClock, fmtDate, fmtDuration, get, memeLine, placeholderArt, post } from '../api.js';
import { state } from '../app.js';
import { navigate } from '../router.js';
import { h, modal, rail, starRating, toast } from '../ui.js';

const isMusicKind = (kind) => kind === 'artist' || kind === 'album' || kind === 'track';
const isVisualKind = (kind) => kind === 'movie' || kind === 'video' || kind === 'episode';

function installArtFallback(scope) {
  scope.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.artFallback === '1') return;
    img.dataset.artFallback = '1';
    const kind = img.closest('.photo-stage') ? 'art'
      : img.closest('.poster-card.landscape, .ep-thumb, .next-episode-card') ? 'thumb'
        : 'poster';
    img.src = placeholderArt(img.alt || img.src || 'slop', kind, img.alt || '');
  }, true);
}

function isManager() {
  return state.user?.role === 'admin' || state.user?.role === 'manager';
}

function musicLink(item) {
  const kind = item.kind;
  if (kind === 'album') return `/music?album=${item.id}`;
  if (kind === 'artist') return `/music?artist=${item.id}`;
  if (item.albumId) return `/music?album=${item.albumId}`;
  return `/music?track=${item.id}`;
}

function heroArt(item, detail) {
  if (item.kind === 'photo') return `/api/photos/${item.id}/file`;
  const context = detail?.show || (item.kind === 'episode' ? detail?.season : null);
  return item.art?.backdrop || context?.art?.backdrop || detail?.show?.art?.backdrop || artFor(item, 'backdrop');
}

function posterArt(item, detail) {
  const context = detail?.show || detail?.season;
  return item.art?.poster || context?.art?.poster || artFor(item, 'poster');
}

function metaPills(item, detail) {
  const pills = [];
  if (item.year) pills.push(String(item.year));
  if (item.contentRating) pills.push(item.contentRating);
  if (item.runtimeSeconds) pills.push(fmtDuration(item.runtimeSeconds));
  if (item.rating) pills.push(`★ ${Number(item.rating).toFixed(1)}`);
  if (item.kind === 'episode' && item.seasonNumber != null) pills.push(`S${item.seasonNumber}E${item.episodeNumber}`);
  if (item.kind === 'album' && (item.trackCount || detail?.tracks?.length)) pills.push(`${item.trackCount || detail.tracks.length} tracks`);
  if (detail?.show && item.kind === 'episode') pills.push(detail.show.title);
  return pills.filter(Boolean).map((pill) => h('span', { class: 'pill' }, pill));
}

function activeResume(item) {
  const progress = item.progress;
  return progress && !progress.finished && progress.positionSeconds > 30 ? progress : null;
}

function pickShowTarget(item, detail, episodes) {
  if (detail?.nextEpisode) return detail.nextEpisode;
  const candidates = [...(episodes || []), ...(detail?.episodes || [])]
    .filter((episode) => episode && episode.kind === 'episode');
  const resumable = candidates.find((episode) => episode.progress && !episode.progress.finished && episode.progress.positionSeconds > 30);
  if (resumable) return resumable;
  const unwatched = candidates.find((episode) => !episode.watched);
  return unwatched || candidates[0] || null;
}
function installFavorite(button, item) {
  const paint = () => {
    button.classList.toggle('active', Boolean(item.favorite));
    button.setAttribute('aria-pressed', String(Boolean(item.favorite)));
    button.textContent = item.favorite ? '♥ Favorited' : '♡ Favorite';
  };
  paint();
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const previous = Boolean(item.favorite);
    button.disabled = true;
    try {
      const result = await post(`/api/progress/${item.id}/favorite`);
      item.favorite = result?.favorite ?? !previous;
      paint();
      toast(item.favorite ? 'Favorited. Certified banger status applied.' : 'Unfavorited. It insists upon itself anyway.', 'fun', { emoji: item.favorite ? '♥' : '💔' });
    } catch (error) {
      if (error?.status !== 401) toast(error.message || 'Could not update favorite', 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function installWatched(button, item) {
  const paint = () => {
    button.classList.toggle('active', Boolean(item.watched));
    button.setAttribute('aria-pressed', String(Boolean(item.watched)));
    button.textContent = item.watched ? '✓ Watched' : '◻ Mark watched';
  };
  paint();
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const previous = Boolean(item.watched);
    button.disabled = true;
    try {
      const result = await api(`/api/progress/${item.id}/state`, { method: 'PUT', body: { watched: !previous } });
      item.watched = result?.watched ?? !previous;
      paint();
      toast(item.watched ? 'Marked watched. Completionist arc complete.' : 'Unwatched. Rewatch era begins.', 'success');
    } catch (error) {
      if (error?.status !== 401) toast(error.message || 'Could not update watched state', 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function primaryAction(item, detail, episodes) {
  if (isMusicKind(item.kind)) {
    return h('a', { class: 'btn primary', href: musicLink(item), 'data-link': true, 'data-focus': true },
      item.kind === 'track' ? '▶ Play in music' : '♫ Open in music');
  }
  if (item.kind === 'photo') {
    return h('a', { class: 'btn primary', href: `/api/photos/${item.id}/file`, download: '', 'data-focus': true }, '⇩ Download original');
  }
  if (isVisualKind(item.kind)) {
    const resume = activeResume(item);
    return h('a', { class: 'btn primary', href: `/watch/${item.id}`, 'data-link': true, 'data-focus': true },
      resume ? `▶ Resume ${fmtClock(resume.positionSeconds)}` : '▶ Play');
  }
  if (item.kind === 'show' || item.kind === 'season') {
    const target = pickShowTarget(item, detail, episodes);
    if (!target) return h('button', { class: 'btn primary', type: 'button', disabled: true }, 'No episodes yet');
    const resume = activeResume(target);
    const label = target.seasonNumber != null
      ? `${resume ? 'Resume' : 'Play'} S${target.seasonNumber}E${target.episodeNumber ?? '?'}`
      : `${resume ? 'Resume' : 'Play'} ${target.title}`;
    return h('a', { class: 'btn primary', href: `/watch/${target.id}`, 'data-link': true, 'data-focus': true }, `▶ ${label}`);
  }
  return null;
}

function detailHero(item, detail, episodes, onEdit) {
  const backdrop = h('div', { class: 'backdrop', style: { backgroundImage: `url("${heroArt(item, detail)}")` } });
  const titleNode = h('h1', { class: 'title' }, item.title || 'Untitled slop');
  const descNode = h('p', { class: 'desc clamp-3' }, item.description || memeLine((item.id || 1) / 11));
  const taglineNode = item.tagline ? h('p', { class: 'detail-tagline accent mono small' }, item.tagline) : null;
  const favoriteButton = h('button', { class: 'btn favorite-btn', type: 'button', 'data-focus': true });
  const watchedButton = h('button', { class: 'btn watched-btn', type: 'button', 'data-focus': true });
  installFavorite(favoriteButton, item);
  installWatched(watchedButton, item);
  const editButton = isManager() && item.kind !== 'photo'
    ? h('button', { class: 'btn ghost small', type: 'button', 'data-focus': true, onclick: onEdit }, '✎ Edit metadata')
    : null;

  const genres = (item.genres || []).map((genre) => h('a', {
    class: 'chip genre-chip',
    href: `/browse/${isMusicKind(item.kind) ? 'albums' : 'movies'}?genre=${encodeURIComponent(genre)}`,
    'data-link': true,
    'data-focus': true,
  }, genre));

  const heroCopy = h('div', { class: 'copy' },
    h('div', { class: 'detail-eyebrow' },
      h('span', { class: 'hero-brand' }, `◉ ${item.kind}`),
      item.libraryName ? h('span', { class: 'faint small' }, item.libraryName) : null,
      item.playable ? h('span', { class: 'pill accent' }, 'playable') : null,
    ),
    titleNode,
    taglineNode,
    h('div', { class: 'detail-meta' }, ...metaPills(item, detail)),
    descNode,
    genres.length ? h('div', { class: 'chip-row detail-genres' }, ...genres) : null,
    h('div', { class: 'actions' },
      primaryAction(item, detail, episodes),
      favoriteButton,
      watchedButton,
      editButton,
    ),
    item.kind === 'episode' && detail?.show
      ? h('a', { class: 'mini-link', href: `/item/${detail.show.id}`, 'data-link': true }, `← back to ${detail.show.title}`)
      : null,
  );

  const poster = item.kind === 'photo'
    ? null
    : h('div', { class: 'detail-poster' }, h('img', {
      src: posterArt(item, detail),
      alt: `Poster for ${item.title}`,
      loading: 'eager',
      decoding: 'async',
    }));

  return {
    node: h('section', { class: `detail-hero${item.kind === 'photo' ? ' photo-hero' : ''}` }, backdrop, h('div', { class: 'shade' }),
      h('div', { class: 'inner' }, poster, heroCopy)),
    titleNode,
    descNode,
    taglineNode,
    favoriteButton,
    watchedButton,
  };
}

function openEditModal(item, onSaved) {
  const title = h('input', { class: 'input', value: item.title || '', required: true });
  const year = h('input', { class: 'input', type: 'number', min: '1800', max: '2200', value: item.year ?? '' });
  const rating = h('input', { class: 'input', type: 'number', min: '0', max: '10', step: '0.1', value: item.rating ?? '' });
  const contentRating = h('input', { class: 'input', value: item.contentRating || '', placeholder: 'PG-13' });
  const tagline = h('input', { class: 'input', value: item.tagline || '' });
  const description = h('textarea', { class: 'textarea', rows: '4' }, item.description || '');
  const genres = h('input', { class: 'input', value: (item.genres || []).join(', '), placeholder: 'Comedy, Drama' });
  const locked = h('input', { type: 'checkbox', checked: Boolean(item.metadataLocked) });
  const errorLine = h('p', { class: 'form-error', hidden: true });
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Title'), title),
    h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
      h('div', { class: 'field', style: { flex: '1' } }, h('label', {}, 'Year'), year),
      h('div', { class: 'field', style: { flex: '1' } }, h('label', {}, 'Rating (0–10)'), rating),
      h('div', { class: 'field', style: { flex: '1' } }, h('label', {}, 'Content rating'), contentRating),
    ),
    h('div', { class: 'field' }, h('label', {}, 'Tagline'), tagline),
    h('div', { class: 'field' }, h('label', {}, 'Description'), description),
    h('div', { class: 'field' }, h('label', {}, 'Genres (comma separated)'), genres),
    h('label', { class: 'check' }, locked, h('span', {}, 'Lock metadata (stop scans from overwriting it)')),
    errorLine,
    h('p', { class: 'help' }, 'Manager-only surgery. Does not touch the source file.'),
  );
  modal({
    title: 'Edit metadata',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save changes',
        kind: 'primary',
        onClick: async () => {
          errorLine.hidden = true;
          const payload = {
            title: title.value.trim(),
            description: description.value.trim(),
            year: year.value ? Number(year.value) : null,
            rating: rating.value ? Number(rating.value) : null,
            tagline: tagline.value.trim() || null,
            contentRating: contentRating.value.trim() || null,
            genres: genres.value.split(',').map((genre) => genre.trim()).filter(Boolean),
            metadataLocked: locked.checked,
          };
          if (!payload.title) {
            errorLine.textContent = 'Title cannot be empty. Even slop needs a name.';
            errorLine.hidden = false;
            return false;
          }
          try {
            const result = await api(`/api/media/${item.id}`, { method: 'PATCH', body: payload });
            const updated = result?.item || result;
            Object.assign(item, payload, updated && typeof updated === 'object' ? updated : {});
            toast('Metadata saved. The slop is now canon.', 'success');
            onSaved?.();
            return true;
          } catch (error) {
            if (error?.status === 401) return false;
            errorLine.textContent = error.message || 'Save failed. Server is being a diva.';
            errorLine.hidden = false;
            return false;
          }
        },
      },
    ],
  });
}
function episodeRow(episode) {
  const progress = episode.progress && !episode.progress.finished ? episode.progress : null;
  const pct = progress && progress.durationSeconds > 0
    ? Math.min(100, (progress.positionSeconds / progress.durationSeconds) * 100)
    : 0;
  const thumb = episode.art?.thumb || artFor(episode, 'thumb');
  return h('div', { class: `episode-row${episode.watched ? ' is-watched' : ''}`, 'data-episode-id': episode.id },
    h('span', { class: 'num mono', 'aria-hidden': 'true' }, episode.episodeNumber != null ? String(episode.episodeNumber).padStart(2, '0') : '·'),
    h('a', {
      class: 'ep-thumb',
      href: `/item/${episode.id}`,
      'data-link': true,
      tabindex: '-1',
      'aria-hidden': 'true',
    }, h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' }),
      pct > 0 ? h('span', { class: 'ep-thumb-progress' }, h('i', { style: { width: `${pct}%` } })) : null,
    ),
    h('div', { class: 'body' },
      h('div', { class: 'ep-title-line' },
        h('a', { class: 'ep-title', href: `/item/${episode.id}`, 'data-link': true, 'data-focus': true }, episode.title || `Episode ${episode.episodeNumber}`),
        episode.watched ? h('span', { class: 'pill good' }, '✓') : null,
        progress ? h('span', { class: 'pill warn' }, `${fmtClock(progress.positionSeconds)} / ${fmtClock(progress.durationSeconds)}`) : null,
      ),
      episode.description ? h('p', { class: 'ep-desc clamp-2' }, episode.description) : null,
      h('div', { class: 'ep-foot faint mono small' },
        episode.runtimeSeconds ? fmtDuration(episode.runtimeSeconds) : '',
        episode.contentRating ? ` · ${episode.contentRating}` : '',
        episode.progress?.finished ? ' · watched' : '',
      ),
    ),
    h('a', {
      class: 'icon-round ep-play',
      href: `/watch/${episode.id}`,
      'data-link': true,
      'data-focus': true,
      'aria-label': `${progress ? 'Resume' : 'Play'} ${episode.title}`,
      title: progress ? 'Resume episode' : 'Play episode',
    }, '▶'),
  );
}

function normalizeSeasons(item, detail) {
  const raw = Array.isArray(detail?.seasons) ? detail.seasons.filter(Boolean) : [];
  const seasons = raw.map((season, index) => ({
    id: season.id ?? season.seasonId ?? null,
    seasonNumber: Number(season.seasonNumber ?? season.season_number ?? index + 1),
    title: season.title || season.name || `Season ${season.seasonNumber ?? index + 1}`,
    episodeCount: season.episodeCount ?? season.childCount ?? season.episodes?.length ?? null,
  }));
  if (seasons.length) return seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
  const seen = new Map();
  for (const episode of detail?.episodes || []) {
    const number = Number(episode.seasonNumber ?? 1);
    if (!seen.has(number)) seen.set(number, { id: null, seasonNumber: number, title: `Season ${number}`, episodeCount: 0 });
    seen.get(number).episodeCount += 1;
  }
  if (!seen.size && item.kind === 'show') seen.set(1, { id: null, seasonNumber: 1, title: 'Season 1', episodeCount: null });
  return [...seen.values()].sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function seasonPanel({ seasons, selected, episodes, loadSeason, countLabel }) {
  if (!seasons.length && !episodes.length) {
    return h('section', { class: 'section' }, h('div', { class: 'empty-state small-empty' },
      h('div', { class: 'emoji' }, '📼'),
      h('h3', {}, 'No episodes scanned'),
      h('p', {}, 'The scanner found zero episodes. Skill issue, or the folder is empty.'),
    ));
  }
  const select = h('select', { class: 'select season-select', 'aria-label': 'Season', 'data-focus': true },
    ...seasons.map((season) => h('option', {
      value: String(season.seasonNumber),
      selected: Number(season.seasonNumber) === Number(selected),
    }, `${season.title}${season.episodeCount ? ` · ${season.episodeCount} eps` : ''}`)),
  );
  const host = h('div', { class: 'episode-list' },
    ...episodes.map((episode) => episodeRow(episode)),
  );
  const count = h('span', { class: 'count' }, countLabel || `${episodes.length} episodes`);
  let seasonRequest = 0;
  const head = h('div', { class: 'section-head season-head' },
    h('h2', {}, 'Episodes'),
    count,
    seasons.length > 1 ? h('div', { class: 'season-picker' }, h('span', { class: 'faint small' }, 'Season'), select) : null,
  );
  select.addEventListener('change', async () => {
    const next = Number(select.value);
    const url = new URL(window.location.href);
    url.searchParams.set('season', String(next));
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    host.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton', style: { height: '74px' } })));
    seasonRequest += 1;
    const token = seasonRequest;
    const loaded = await loadSeason(next);
    if (token !== seasonRequest) return;
    if (!loaded) return;
    count.textContent = `${loaded.length} episode${loaded.length === 1 ? '' : 's'}`;
    host.replaceChildren(...(loaded.length ? loaded.map((episode) => episodeRow(episode)) : [h('p', { class: 'faint' }, 'This season is a ghost town.')]));
  });
  return h('section', { class: 'section episodes-section' }, head, host);
}

function trackList(tracks, item) {
  if (!tracks?.length) return null;
  return h('section', { class: 'section detail-tracks' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Tracks'),
      h('span', { class: 'count' }, `${tracks.length} songs`),
      h('a', { class: 'mini-link', href: musicLink(item), 'data-link': true, style: { marginLeft: 'auto' } }, 'Play in music →'),
    ),
    h('div', { class: 'track-list-detail' }, ...tracks.map((track, index) => {
      const duration = track.runtimeSeconds || track.progress?.durationSeconds;
      return h('div', { class: 'track-row-detail' },
        h('span', { class: 'num mono faint' }, String(track.trackNumber ?? index + 1).padStart(2, '0')),
        h('div', { class: 'track-copy' },
          h('a', { class: 'track-title', href: `/item/${track.id}`, 'data-link': true, 'data-focus': true }, track.title || 'Untitled banger'),
          track.artistName || track.albumTitle ? h('span', { class: 'faint small' }, track.artistName || track.albumTitle) : null,
        ),
        track.favorite ? h('span', { class: 'pill hot' }, '♥') : null,
        duration ? h('span', { class: 'faint mono small' }, fmtClock(duration)) : null,
        h('a', {
          class: 'icon-round',
          href: musicLink(track),
          'data-link': true,
          'data-focus': true,
          'aria-label': `Play ${track.title} in music`,
        }, '▶'),
      );
    })),
  );
}

function peopleList(people) {
  if (!people?.length) return null;
  const seen = new Set();
  const unique = people.filter((person) => {
    const key = `${person.name}:${person.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Cast & crew'),
      h('span', { class: 'count' }, `${unique.length} humans`),
    ),
    h('div', { class: 'cast-list' }, ...unique.map((person) => h('div', { class: 'cast-item' },
      h('strong', {}, person.name || 'Unknown'),
      h('span', {}, person.character ? `${person.character} · ${person.role || 'actor'}` : (person.role || 'crew')),
    ))),
  );
}

function ratingCard(item) {
  const value = Number(item.userRating) || 0;
  const label = h('span', { class: 'faint small' }, value ? `${value} / 10` : 'not rated');
  const stars = h('div');
  const paint = (next) => {
    stars.replaceChildren(starRating(next, async (rating) => {
      try {
        const result = await api(`/api/progress/${item.id}/state`, { method: 'PUT', body: { rating: rating || null } });
        item.userRating = result?.rating ?? rating;
        label.textContent = item.userRating ? `${item.userRating} / 10` : 'not rated';
        paint(item.userRating || 0);
        toast(item.userRating ? `Rated ${item.userRating}/10. Objective truth.` : 'Rating cleared. Coward.', 'fun', { emoji: '⭐' });
      } catch (error) {
        if (error?.status !== 401) toast(error.message || 'Rating failed', 'error');
      }
    }));
  };
  paint(value);
  return h('div', { class: 'card rating-card' },
    h('div', { class: 'card-title' }, h('h3', {}, 'Your rating'), label),
    stars,
  );
}
function factsCard(item) {
  const facts = [
    ['Kind', item.kind],
    ['Released', item.releaseDate ? fmtDate(item.releaseDate) : item.year ? String(item.year) : null],
    ['Runtime', item.runtimeSeconds ? `${fmtDuration(item.runtimeSeconds)} (${fmtClock(item.runtimeSeconds)})` : null],
    ['Content rating', item.contentRating],
    ['Library', item.libraryName],
    ['Added', item.addedAt ? fmtDate(item.addedAt) : null],
    ['Plays', item.progress?.playCount ? String(item.progress.playCount) : null],
    ['Last played', item.progress?.updatedAt ? fmtDate(item.progress.updatedAt, true) : null],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!facts.length) return null;
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, h('h3', {}, 'Facts'), h('span', { class: 'faint mono small' }, 'verified slop')),
    h('dl', { class: 'kv' }, ...facts.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
  );
}

function techCard(item, detail) {
  const audio = Array.isArray(item.audioTracks) ? item.audioTracks : [];
  const subtitles = Array.isArray(detail?.subtitles) ? detail.subtitles : [];
  const chapters = Array.isArray(item.chapters) ? item.chapters : [];
  const tech = [
    ['Container', item.container],
    ['Resolution', item.width && item.height ? `${item.width}×${item.height}` : null],
    ['Video', [item.videoCodec, item.fps ? `${Number(item.fps).toFixed(2)} fps` : null].filter(Boolean).join(' · ') || null],
    ['Audio codec', item.audioCodec],
    ['Bitrate', Number.isFinite(Number(item.bitrate)) && Number(item.bitrate) > 0 ? `${Math.round(Number(item.bitrate) / 1000).toLocaleString()} kbps` : null],
    ['Size', item.sizeBytes ? fmtBytes(item.sizeBytes) : null],
    ['Chapters', chapters.length ? String(chapters.length) : null],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!tech.length && !audio.length && !subtitles.length) return null;
  return h('div', { class: 'card tech-card' },
    h('div', { class: 'card-title' }, h('h3', {}, 'Tech specs'), h('span', { class: 'faint mono small' }, 'nerd corner')),
    tech.length ? h('dl', { class: 'kv' }, ...tech.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])) : null,
    audio.length ? h('div', { class: 'tech-block' },
      h('h4', { class: 'tech-heading' }, 'Audio tracks'),
      ...audio.map((track) => h('div', { class: 'track-row' },
        h('span', {},
          h('span', { class: 'mono faint' }, `${track.language || 'und'} · `),
          track.title || `Track ${track.index}`,
          h('span', { class: 'faint' }, track.channels ? ` · ${track.channels}ch` : ''),
          h('span', { class: 'subtitle-tag' }, track.codec || '?'),
        ),
        track.default ? h('span', { class: 'pill good' }, 'default') : null,
      )),
    ) : null,
    subtitles.length ? h('div', { class: 'tech-block' },
      h('h4', { class: 'tech-heading' }, 'Subtitles'),
      ...subtitles.map((subtitle) => h('div', { class: 'track-row' },
        h('span', {}, `${subtitle.label || subtitle.language || 'unknown'} `, h('span', { class: 'subtitle-tag' }, subtitle.format || '?')),
        h('span', { class: 'faint' }, [subtitle.forced ? 'forced' : '', subtitle.is_external || subtitle.isExternal ? 'external' : 'embedded'].filter(Boolean).join(' · ')),
      )),
    ) : null,
  );
}

function chaptersCard(item) {
  if (!item.chapters?.length) return null;
  return h('section', { class: 'section chapters-section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Chapters'), h('span', { class: 'count' }, `${item.chapters.length} skips`)),
    h('div', { class: 'chapter-list' }, ...item.chapters.map((chapter) => h('div', { class: 'chapter-row' },
      h('span', { class: 'mono faint small' }, fmtClock(chapter.start || 0)),
      h('span', {}, chapter.title || 'Untitled chapter'),
    ))),
  );
}

function photoStage(item) {
  const src = `/api/photos/${item.id}/file`;
  return h('figure', { class: 'photo-stage' },
    h('img', {
      src,
      alt: item.description || item.title || 'Photo',
      loading: 'eager',
      decoding: 'async',
    }),
    h('figcaption', { class: 'photo-caption row wrap' },
      h('span', { class: 'faint small' }, [item.width && item.height ? `${item.width}×${item.height}` : '', item.sizeBytes ? fmtBytes(item.sizeBytes) : ''].filter(Boolean).join(' · ')),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn small', href: src, download: '', 'data-focus': true }, '⇩ Download'),
      h('a', { class: 'btn small ghost', href: '/photos', 'data-link': true, 'data-focus': true }, 'Open photos'),
    ),
  );
}

function skeletonDetail(root) {
  root.replaceChildren(
    h('div', { class: 'detail-hero skeleton hero-skeleton', 'aria-hidden': 'true' }),
    h('div', { class: 'detail-body', 'aria-hidden': 'true' },
      h('div', { class: 'detail-main' },
        ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton', style: { height: '72px' } })),
      ),
      h('div', { class: 'detail-side' },
        h('div', { class: 'skeleton', style: { height: '120px' } }),
        h('div', { class: 'skeleton', style: { height: '220px' } }),
      ),
    ),
  );
  root.setAttribute('aria-busy', 'true');
}

function detailError(container, title, message, retry) {
  container.replaceChildren(h('div', { class: 'empty-state' },
    h('div', { class: 'emoji' }, '🕳️'),
    h('h3', {}, title),
    h('p', {}, message),
    h('div', { class: 'row wrap', style: { gap: '8px' } },
      retry ? h('button', { class: 'btn primary', type: 'button', onclick: retry }, 'Try again') : null,
      h('a', { class: 'btn', href: '/', 'data-link': true }, 'Go home'),
    ),
  ));
}

export default async function render(container, ctx) {
  const id = Number(ctx.params?.id);
  if (!Number.isInteger(id) || id <= 0) {
    detailError(container, 'Invalid media id', 'That is not a number. Nice try, goblin.');
    return;
  }
  const root = h('div', { class: 'detail-view' });
  installArtFallback(root);
  container.append(root);
  skeletonDetail(root);

  const controller = new AbortController();
  let disposed = false;
  let detail = null;
  let item = null;

  const request = (path) => get(path, { signal: controller.signal });

  const fetchDetail = async () => {
    detail = await request(`/api/media/${id}`);
    item = detail?.item || (detail && detail.id ? detail : null);
    if (!item) throw new Error('The server returned no item. Rude.');
  };

  try {
    await fetchDetail();
  } catch (error) {
    if (disposed || error?.name === 'AbortError') return () => controller.abort();
    if (error?.status === 401) return () => controller.abort();
    detailError(container, error?.status === 404 ? 'This item got isekai’d' : 'The detail page took an L', error.message || 'Could not load this title.', () => {
      navigate(`${window.location.pathname}?retry=${Date.now()}`, { replace: true });
    });
    return () => controller.abort();
  }
  if (disposed) return () => controller.abort();

  const showContext = item.kind === 'episode' ? detail.show : item.kind === 'season' ? (detail.show || item) : item;
  const seasons = normalizeSeasons(showContext || item, detail);
  const bundled = Array.isArray(detail.episodes) ? detail.episodes.filter((episode) => episode && episode.kind === 'episode') : [];
  const targetEpisode = detail.nextEpisode || (item.kind === 'episode' ? null : bundled.find((episode) => episode.progress && !episode.progress.finished) || bundled[0]);
  const requestedSeason = Number(ctx.query.season) || 0;
  const seasonNumbers = seasons.map((season) => Number(season.seasonNumber));
  const selectedSeason = (requestedSeason && (!seasonNumbers.length || seasonNumbers.includes(requestedSeason)) ? requestedSeason : 0)
    || ((item.kind === 'episode' || item.kind === 'season') ? Number(item.seasonNumber) || 0 : Number(targetEpisode?.seasonNumber) || 0)
    || seasonNumbers[0]
    || 1;

  const collectionId = item.kind === 'show' ? item.id
    : item.kind === 'season' ? item.id
      : item.kind === 'episode' ? (detail.show?.id || item.parentId)
        : null;

  const fetchEpisodes = async (seasonNumber) => {
    if (!collectionId) return [];
    try {
      const result = await request(`/api/media/${collectionId}/children${seasonNumber ? `?season=${encodeURIComponent(seasonNumber)}` : ''}`);
      const list = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
      return list.filter((entry) => entry && entry.kind === 'episode');
    } catch (error) {
      if (disposed || error?.name === 'AbortError' || error?.status === 401) return [];
      toast(`Episodes failed to load: ${error.message}`, 'error');
      return [];
    }
  };

  let episodes = bundled.filter((episode) => episode.seasonNumber == null || Number(episode.seasonNumber) === Number(selectedSeason));
  if (!episodes.length && collectionId && (item.kind === 'show' || item.kind === 'season' || item.kind === 'episode')) {
    episodes = await fetchEpisodes(selectedSeason);
  }
  if (disposed) return () => controller.abort();

  const paint = async () => {
    if (disposed) return;
    document.title = `${item.title || 'Untitled'} — ${state.branding?.serverName || 'AISlopMediaBox'}`;
    root.replaceChildren();
    root.removeAttribute('aria-busy');

    let hero;
    const onEdit = () => openEditModal(item, () => {
      hero.titleNode.textContent = item.title;
      hero.descNode.textContent = item.description || memeLine(item.id / 13);
      const existingTagline = hero.node.querySelector('.detail-tagline');
      if (existingTagline) existingTagline.textContent = item.tagline || '';
      else if (item.tagline) hero.descNode.before(h('p', { class: 'detail-tagline accent mono small' }, item.tagline));
      document.title = `${item.title} — ${state.branding?.serverName || 'AISlopMediaBox'}`;
    });
    hero = detailHero(item, detail, episodes, onEdit);
    root.append(hero.node);

    const main = h('div', { class: 'detail-main' });
    const side = h('div', { class: 'detail-side' });

    if (item.kind === 'photo') {
      main.append(photoStage(item));
    }

    if (seasons.length || episodes.length) {
      if (item.kind === 'show' || item.kind === 'season' || item.kind === 'episode') {
        main.append(seasonPanel({
          seasons,
          selected: selectedSeason,
          episodes,
          countLabel: `${episodes.length} episode${episodes.length === 1 ? '' : 's'}`,
          loadSeason: async (seasonNumber) => {
            const loaded = await fetchEpisodes(seasonNumber);
            if (loaded.length) episodes = loaded;
            return loaded;
          },
        }));
      }
    }

    const musicTracks = Array.isArray(detail.tracks) && detail.tracks.length
      ? detail.tracks
      : item.kind === 'track' ? [item] : [];
    if (isMusicKind(item.kind) && musicTracks.length) main.append(trackList(musicTracks, item));

    const albums = Array.isArray(detail.albums) ? detail.albums : [];
    if (item.kind === 'artist' && albums.length) {
      main.append(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Albums'), h('span', { class: 'count' }, `${albums.length}`)),
        h('div', { class: 'grid poster-grid' }, ...albums.map((album) => {
          return h('a', { class: 'poster-card', href: `/item/${album.id}`, 'data-link': true, 'data-focus': true },
            h('div', { class: 'poster' }, h('img', { src: artFor(album, 'poster'), alt: '', loading: 'lazy', decoding: 'async' })),
            h('div', { class: 'title clamp-2' }, album.title),
            h('div', { class: 'meta truncate' }, album.year ? String(album.year) : 'album'),
          );
        })),
      ));
    }

    const chapters = chaptersCard(item);
    if (chapters) main.append(chapters);

    const cast = peopleList(item.people || detail.show?.people || []);
    if (cast) main.append(cast);

    if (detail.related?.length) {
      const related = rail('More like this', detail.related, { showKind: false });
      for (const card of related.querySelectorAll('[data-media-id]')) {
        const photo = detail.related.find((entry) => String(entry.id) === card.dataset.mediaId);
        if (photo?.kind === 'photo') {
          const img = card.querySelector('img');
          if (img) img.src = artFor(photo, 'thumb');
        }
      }
      main.append(related);
    }
    const episodeIndex = item.kind === 'episode' ? episodes.findIndex((episode) => episode.id === item.id) : -1;
    const upNext = detail.nextEpisode
      || (episodeIndex >= 0 ? episodes[episodeIndex + 1] : null);
    if (upNext?.id && upNext.id !== item.id) {
      const next = upNext;
      main.append(h('section', { class: 'section up-next' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Up next'), h('span', { class: 'count' }, 'do not skip the intro')),
        h('a', { class: 'next-episode-card', href: `/item/${next.id}`, 'data-link': true, 'data-focus': true },
          h('img', { src: artFor(next, 'thumb'), alt: '', loading: 'lazy', decoding: 'async' }),
          h('div', {},
            h('strong', {}, next.title || 'Next episode'),
            h('span', { class: 'faint small' }, next.seasonNumber != null ? `S${next.seasonNumber}E${next.episodeNumber} · ${next.runtimeSeconds ? fmtDuration(next.runtimeSeconds) : ''}` : ''),
          ),
          h('span', { class: 'btn small primary' }, '▶ Play'),
        ),
      ));
    }

    side.append(ratingCard(item));
    const facts = factsCard(item);
    if (facts) side.append(facts);
    const tech = techCard(item, detail);
    if (tech) side.append(tech);
    if (isMusicKind(item.kind)) {
      side.append(h('div', { class: 'card music-cta' },
        h('h3', {}, 'Full music nonsense'),
        h('p', { class: 'faint small' }, 'Queue it, shuffle it, pretend you have taste.'),
        h('a', { class: 'btn primary block', href: musicLink(item), 'data-link': true, 'data-focus': true }, '♫ Open music'),
      ));
    }

    root.append(h('div', { class: 'detail-body' }, main, side));
  };

  try {
    await paint();
  } catch (error) {
    if (disposed || error?.name === 'AbortError') return () => controller.abort();
    if (error?.status === 401) return () => controller.abort();
    detailError(container, 'The page faceplanted', error.message || 'Something in this detail is cursed.', () => {
      navigate(`${window.location.pathname}?retry=${Date.now()}`, { replace: true });
    });
  }

  return () => {
    disposed = true;
    controller.abort();
  };
}
