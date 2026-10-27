// Playlist detail — ordered queue with drag/arrow reorder and media picker.
import { api, get, post, del, artFor, placeholderArt, fmtDuration } from '../api.js';
import { h, kindLabel, emptyState, toast, confirmDialog } from '../ui.js';
import { rerender } from '../router.js';
import { errorCopy, playFirst, openMediaPicker } from './collections.js';
import { isPlaylistOwner, openPlaylistEditor } from './playlists.js';

function renderLoadError(container, error) {
  container.append(
    h('div', { class: 'empty-state' },
      h('div', { class: 'emoji' }, '🔒'),
      h('h3', {}, 'Playlist not available'),
      h('p', {}, errorCopy(error, 'Private, deleted, or never existed. Pick one.')),
      h('a', { class: 'btn', href: '/playlists', 'data-link': true }, '← Back to playlists'),
    ),
  );
}

export default async function render(container, ctx) {
  const { params, navigate } = ctx;
  const root = h('div', { class: 'playlist-detail' });
  container.append(root);

  let payload;
  try {
    payload = await get(`/api/playlists/${encodeURIComponent(params.id)}`);
  } catch (error) {
    renderLoadError(container, error);
    return;
  }

  const playlist = payload?.playlist || payload || {};
  let items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(playlist.items) ? playlist.items : [];
  const owner = isPlaylistOwner(playlist);
  const title = playlist.name || 'Untitled queue';
  document.title = `${title} — Playlists`;

  const art = playlist.art?.poster || playlist.art?.thumb
    || (items[0] ? artFor(items[0], 'poster') : placeholderArt(`playlist:${playlist.id}`, 'thumb', title));

  const countBadge = h('span', { class: 'pill' }, `${items.length} item${items.length === 1 ? '' : 's'}`);
  const durationBadge = h('span', { class: 'pill mono' }, fmtDuration(playlist.durationSeconds || 0, { empty: '0m' }));
  const listHost = h('div', { class: 'queue' });

  const playButton = h('button', {
    class: 'btn primary',
    type: 'button',
    disabled: items.length === 0,
    onclick: () => playFirst(items, navigate),
  }, '▶ Play all');

  const addButton = owner ? h('button', {
    class: 'btn',
    type: 'button',
    onclick: openAdd,
  }, '＋ Add media') : null;

  const duplicateButton = h('button', {
    class: 'btn',
    type: 'button',
    onclick: duplicate,
  }, '⧉ Duplicate');

  const editButton = owner ? h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => openPlaylistEditor({ playlist, onSaved: () => rerender() }),
  }, '✎ Edit') : null;

  const deleteButton = owner ? h('button', {
    class: 'btn danger',
    type: 'button',
    onclick: deletePlaylist,
  }, 'Delete') : null;

  root.append(
    h('header', { class: 'playlist-hero' },
      h('img', { class: 'playlist-hero-art', src: art, alt: '', 'aria-hidden': 'true' }),
      h('div', { class: 'playlist-hero-shade' }),
      h('div', { class: 'playlist-hero-copy' },
        h('p', { class: 'eyebrow' }, 'playlist'),
        h('h1', { class: 'playlist-hero-title' }, title),
        playlist.description ? h('p', { class: 'playlist-hero-desc' }, playlist.description) : null,
        h('div', { class: 'row wrap', style: { gap: '6px' } },
          h('span', { class: `pill${playlist.isPublic ? ' good' : ''}` }, playlist.isPublic ? 'public' : 'private'),
          h('span', { class: 'pill' }, playlist.kind || 'mixed'),
          countBadge,
          durationBadge,
          playlist.createdBy ? h('span', { class: 'faint small' }, `by ${playlist.createdBy}`) : null,
        ),
      ),
    ),
    h('div', { class: 'playlist-actions' }, playButton, addButton, duplicateButton, editButton, deleteButton),
    listHost,
  );

  renderList();
  return () => { /* no document listeners */ };

  function renderList() {
    const totalSeconds = items.reduce((sum, item) => sum + (Number(item.durationSeconds) || Number(item.runtimeSeconds) || 0), 0);
    countBadge.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    durationBadge.textContent = fmtDuration(totalSeconds || playlist.durationSeconds || 0, { empty: '0m' });
    playButton.disabled = items.length === 0;

    if (!items.length) {
      listHost.replaceChildren(emptyState(
        'Queue is empty',
        owner
          ? 'Add some certified bangers. A playlist with zero items is just a vibe.'
          : 'The curator left this one empty. Mysterious.',
        '🎧',
      ));
      if (owner) {
        listHost.append(h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', type: 'button', onclick: openAdd }, '＋ Add media'),
        ));
      }
      return;
    }

    listHost.replaceChildren(
      h('div', { class: 'queue-head' },
        h('span', { class: 'faint mono small' }, '#'),
        h('span', { 'aria-hidden': 'true' }),
        h('span', {}, 'Title'),
        h('span', { class: 'queue-dur-head' }, 'Length'),
        owner ? h('span', { class: 'queue-tools-head' }, 'Order') : h('span', { 'aria-hidden': 'true' }),
      ),
      h('div', { class: 'queue-rows' }, ...items.map((item, index) => queueRow(item, index))),
    );
  }

  function queueRow(item, index) {
    const playable = ['movie', 'episode', 'video', 'track'].includes(item.kind);
    const meta = [kindLabel(item.kind), item.year, item.artistName || item.showTitle].filter(Boolean).join(' · ');
    const seconds = Number(item.durationSeconds) || Number(item.runtimeSeconds) || 0;

    const row = h('div', {
      class: 'queue-row',
      draggable: owner ? 'true' : null,
      'data-media-id': String(item.id),
    },
    h('span', { class: 'queue-index num' }, String(index + 1).padStart(2, '0')),
    h('img', { class: 'queue-thumb', src: artFor(item, 'thumb'), alt: '', loading: 'lazy' }),
    h('div', { class: 'queue-copy' },
      h('a', { class: 'queue-title truncate', href: `/item/${item.id}`, 'data-link': true, 'data-focus': true }, item.title || 'Untitled slop'),
      h('small', { class: 'faint' }, meta || 'certified slop'),
    ),
    h('span', { class: 'queue-dur mono small faint' }, seconds ? fmtDuration(seconds, { clock: true }) : '—'),
    owner
      ? h('div', { class: 'queue-tools' },
        playable ? h('button', {
          class: 'icon-btn queue-play',
          type: 'button',
          title: 'Play this',
          'aria-label': `Play ${item.title}`,
          onclick: () => playFirst([item], navigate),
        }, '▶') : null,
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Move up',
          'aria-label': `Move ${item.title} up`,
          disabled: index === 0,
          onclick: () => move(index, -1),
        }, '↑'),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Move down',
          'aria-label': `Move ${item.title} down`,
          disabled: index === items.length - 1,
          onclick: () => move(index, 1),
        }, '↓'),
        h('button', {
          class: 'icon-btn danger',
          type: 'button',
          title: 'Remove from playlist',
          'aria-label': `Remove ${item.title} from playlist`,
          onclick: () => removeItem(index),
        }, '✕'),
      )
      : h('span', { class: 'queue-tools' }),
    );

    if (!owner) return row;

    let dragIndex = null;
    row.addEventListener('dragstart', (event) => {
      dragIndex = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(item.id));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragIndex = null;
      row.classList.remove('dragging');
      listHost.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (event) => {
      if (dragIndex === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drag-over');
      if (dragIndex === null || dragIndex === index) return;
      const [moved] = items.splice(dragIndex, 1);
      items.splice(index, 0, moved);
      dragIndex = null;
      renderList();
      saveOrder();
    });
    return row;
  }
  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const [moved] = items.splice(index, 1);
    items.splice(target, 0, moved);
    renderList();
    saveOrder();
  }

  async function removeItem(index) {
    const item = items[index];
    if (!item) return;
    try {
      await del(`/api/playlists/${encodeURIComponent(playlist.id)}/items/${encodeURIComponent(item.id)}`);
      items.splice(index, 1);
      renderList();
      toast(`${item.title || 'Item'} removed from the queue.`, 'success');
    } catch (error) {
      toast(errorCopy(error, 'Could not remove that item.'), 'error');
    }
  }

  async function saveOrder() {
    try {
      await api(`/api/playlists/${encodeURIComponent(playlist.id)}/items`, {
        method: 'PUT',
        body: { mediaIds: items.map((item) => item.id) },
      });
    } catch (error) {
      toast(`Queue order did not save: ${errorCopy(error)}`, 'error');
    }
  }

  function openAdd() {
    const kinds = playlist.kind === 'video' ? ['movie', 'episode', 'video']
      : playlist.kind === 'audio' ? ['track']
        : playlist.kind === 'photo' ? ['photo']
          : ['movie', 'episode', 'video', 'track'];
    openMediaPicker({
      title: 'Add to playlist',
      excludeIds: items.map((item) => String(item.id)),
      kinds,
      onPick: async (ids) => {
        await post(`/api/playlists/${encodeURIComponent(playlist.id)}/items`, { mediaIds: ids });
        toast(`${ids.length} item${ids.length === 1 ? '' : 's'} queued. Order is a suggestion.`, 'success');
        rerender();
      },
    });
  }

  async function duplicate() {
    duplicateButton.disabled = true;
    try {
      const res = await post(`/api/playlists/${encodeURIComponent(playlist.id)}/duplicate`, {});
      const created = res?.playlist || res?.item || res;
      toast('Duplicated. A fresh queue, same energy.', 'success');
      if (created?.id) navigate(`/playlists/${created.id}`);
      else rerender();
    } catch (error) {
      toast(errorCopy(error, 'Could not duplicate that playlist.'), 'error');
    } finally {
      duplicateButton.disabled = false;
    }
  }

  async function deletePlaylist() {
    const ok = await confirmDialog(
      'Delete this playlist?',
      `“${title}” disappears. Media files are untouched — we are chaotic, not reckless.`,
      { confirmLabel: 'Delete it' },
    );
    if (!ok) return;
    try {
      await del(`/api/playlists/${encodeURIComponent(playlist.id)}`);
      toast('Playlist deleted. The queue is free.', 'success');
      navigate('/playlists');
    } catch (error) {
      toast(errorCopy(error, 'Could not delete that playlist.'), 'error');
    }
  }
}

