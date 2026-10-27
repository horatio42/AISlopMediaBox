// Playlists — ordered slop queues, public or private.
import { get, post, patch, del, placeholderArt, fmtDuration } from '../api.js';
import { h, pageHeader, emptyState, modal, toast, confirmDialog, skeletonCards } from '../ui.js';
import { state as appState } from '../app.js';
import { listOf, errorCopy, playFirst } from './collections.js';

const KINDS = [
  { value: 'mixed', label: 'Mixed (anything)' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'photo', label: 'Photos' },
];

export function isPlaylistOwner(playlist) {
  const user = appState.user;
  if (!user) return false;
  if (user.role === 'admin') return true;
  const owner = playlist?.createdBy;
  if (owner === undefined || owner === null) return false;
  return owner === user.username || owner === user.displayName || String(owner) === String(user.id);
}

export function openPlaylistEditor({ playlist = null, onSaved } = {}) {
  const isEdit = Boolean(playlist?.id);
  const nameInput = h('input', {
    class: 'input',
    id: 'playlist-name',
    maxlength: '80',
    value: playlist?.name || '',
    placeholder: 'Shitpost Cinema, Vol. 1',
    'aria-label': 'Playlist name',
  });
  const descriptionInput = h('textarea', {
    class: 'textarea',
    id: 'playlist-description',
    rows: '3',
    maxlength: '500',
    placeholder: 'What is this queue for? Be honest.',
    'aria-label': 'Playlist description',
  });
  descriptionInput.value = playlist?.description || '';

  const kindSelect = h('select', { class: 'select', id: 'playlist-kind', 'aria-label': 'Playlist kind' },
    ...KINDS.map((kind) => h('option', { value: kind.value, selected: (playlist?.kind || 'mixed') === kind.value }, kind.label)));

  const publicCheck = h('input', {
    type: 'checkbox',
    checked: Boolean(playlist?.isPublic),
    'aria-describedby': 'playlist-public-hint',
  });

  const errorNode = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const body = h('div', { class: 'stack', style: { gap: '14px' } },
    h('div', { class: 'field' }, h('label', { for: 'playlist-name' }, 'Name'), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'playlist-description' }, 'Description'), descriptionInput),
    h('div', { class: 'field' }, h('label', { for: 'playlist-kind' }, 'Kind'), kindSelect,
      h('p', { class: 'help' }, 'Mixed playlists can hold movies, episodes, and tracks. Chaos is a feature.')),
    h('div', {},
      h('label', { class: 'check' }, publicCheck, h('span', {}, 'Public — visible to everyone on this server')),
      h('p', { class: 'help', id: 'playlist-public-hint' }, 'Private playlists stay yours. Admin can still see everything, obviously.'),
    ),
    errorNode,
  );

  modal({
    title: isEdit ? 'Edit playlist' : 'New playlist',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: isEdit ? 'Save changes' : 'Create playlist',
        kind: 'primary',
        onClick: async () => {
          errorNode.hidden = true;
          const name = nameInput.value.trim();
          if (!name) {
            errorNode.textContent = 'Name required. An anonymous queue is a cry for help.';
            errorNode.hidden = false;
            nameInput.focus();
            return false;
          }
          const payload = {
            name,
            description: descriptionInput.value.trim(),
            kind: kindSelect.value,
            isPublic: publicCheck.checked,
          };
          try {
            const res = isEdit
              ? await patch(`/api/playlists/${playlist.id}`, payload)
              : await post('/api/playlists', payload);
            const created = res?.playlist || res?.item || res;
            toast(isEdit ? 'Playlist updated. Queue integrity restored.' : 'Playlist created. Queue up.', 'success');
            onSaved?.(created);
          } catch (error) {
            errorNode.textContent = errorCopy(error, 'Could not save that playlist.');
            errorNode.hidden = false;
            return false;
          }
          return true;
        },
      },
    ],
  });
}

function playlistCard(playlist, onChanged, navigate) {
  const owner = isPlaylistOwner(playlist);
  const art = playlist.art?.poster || playlist.art?.thumb
    || placeholderArt(`playlist:${playlist.id}`, 'thumb', playlist.name);
  const meta = [
    `${playlist.itemCount ?? 0} item${playlist.itemCount === 1 ? '' : 's'}`,
    playlist.durationSeconds ? fmtDuration(playlist.durationSeconds) : null,
    playlist.createdBy ? `by ${playlist.createdBy}` : null,
  ].filter(Boolean).join(' · ');

  return h('article', { class: 'playlist-tile' },
    h('a', {
      class: 'playlist-hit',
      href: `/playlists/${playlist.id}`,
      'data-link': true,
      'aria-label': `${playlist.name} — ${meta}`,
    },
    h('img', { class: 'playlist-art', src: art, alt: '', loading: 'lazy', decoding: 'async' }),
    h('div', { class: 'playlist-copy' },
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        h('span', { class: `pill${playlist.isPublic ? ' good' : ''}` }, playlist.isPublic ? 'public' : 'private'),
        playlist.kind && playlist.kind !== 'mixed' ? h('span', { class: 'pill' }, playlist.kind) : null,
      ),
      h('strong', {}, playlist.name || 'Untitled queue'),
      playlist.description ? h('p', { class: 'small muted clamp-2' }, playlist.description) : null,
      h('span', { class: 'faint small mono' }, meta),
    ),
    ),
    h('div', { class: 'playlist-tools' },
      h('button', {
        class: 'icon-round small',
        type: 'button',
        title: 'Play from the top',
        'aria-label': `Play ${playlist.name} from the top`,
        onclick: async () => {
          try {
            const res = await get(`/api/playlists/${playlist.id}`);
            const queue = Array.isArray(res?.items) ? res.items : [];
            if (!queue.length) navigate(`/playlists/${playlist.id}`);
            else playFirst(queue, navigate);
          } catch (error) {
            toast(errorCopy(error, 'Could not start that playlist.'), 'error');
          }
        },
      }, '▶'),
      owner ? h('button', {
        class: 'icon-round small',
        type: 'button',
        title: 'Edit playlist',
        'aria-label': `Edit ${playlist.name}`,
        onclick: () => openPlaylistEditor({
          playlist,
          onSaved: onChanged,
        }),
      }, '✎') : null,
      owner ? h('button', {
        class: 'icon-round small danger',
        type: 'button',
        title: 'Delete playlist',
        'aria-label': `Delete ${playlist.name}`,
        onclick: async () => {
          const ok = await confirmDialog(
            'Delete this playlist?',
            `“${playlist.name}” disappears. The media itself stays put, promise.`,
            { confirmLabel: 'Delete it' },
          );
          if (!ok) return;
          try {
            await del(`/api/playlists/${playlist.id}`);
            toast('Playlist deleted. Queue evacuated.', 'success');
            onChanged?.();
          } catch (error) {
            toast(errorCopy(error, 'Could not delete that playlist.'), 'error');
          }
        },
      }, '🗑') : null,
    ),
  );
}

export default async function render(container, ctx) {
  const { navigate } = ctx;
  const user = appState.user;
  let tab = 'all';
  let playlists = [];

  container.append(pageHeader('Playlists', ['Ordered queues · yours or the server’s'], [
    h('button', {
      class: 'btn primary',
      type: 'button',
      onclick: () => openPlaylistEditor({ onSaved: afterCreate }),
    }, '＋ New playlist'),
  ]));

  const tabsHost = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Playlist filters' });
  const host = h('div', { class: 'stack', style: { gap: '18px' } });
  container.append(tabsHost, host);

  const TABS = [
    { id: 'all', label: 'All playlists' },
    { id: 'mine', label: 'Mine' },
    { id: 'public', label: 'Public' },
  ];

  function renderTabs() {
    tabsHost.replaceChildren(...TABS.map((entry) => h('button', {
      class: `tab${tab === entry.id ? ' active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(tab === entry.id),
      onclick: () => { tab = entry.id; renderTabs(); renderList(); },
    }, entry.label)));
  }

  function ownedByMe(playlist) {
    if (!user) return false;
    if (playlist.createdBy === user.username || playlist.createdBy === user.displayName) return true;
    return String(playlist.createdBy) === String(user.id);
  }

  function filtered() {
    if (tab === 'mine') return playlists.filter(ownedByMe);
    if (tab === 'public') return playlists.filter((playlist) => playlist.isPublic);
    return playlists;
  }

  function renderList() {
    const visible = filtered();
    if (!visible.length) {
      const copy = {
        all: ['No playlists yet', 'Queue up some certified bangers. Or don’t. No pressure, coward.', '☰'],
        mine: ['You have no playlists', 'Make one. Be the curator you want to see in the world.', '🫡'],
        public: ['No public playlists', 'Everyone is hoarding their queues. Very private, very mysterious.', '🕵️'],
      }[tab];
      host.replaceChildren(emptyState(copy[0], copy[1], copy[2]));
      if (tab !== 'public') {
        host.append(h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: () => openPlaylistEditor({ onSaved: afterCreate }),
          }, '＋ Create a playlist'),
        ));
      }
      return;
    }
    host.replaceChildren(
      h('div', { class: 'playlist-grid' }, ...visible.map((playlist) => playlistCard(playlist, load, navigate))),
      h('p', { class: 'faint small' }, `${visible.length} playlist${visible.length === 1 ? '' : 's'} · order matters, obviously`),
    );
  }

  function afterCreate(created) {
    const pl = created?.playlist || created;
    if (pl?.id) navigate(`/playlists/${pl.id}`);
    else load();
  }

  async function load() {
    host.replaceChildren(h('div', { class: 'playlist-grid' }, ...skeletonCards(6, true)));
    try {
      const res = await get('/api/playlists?pageSize=100');
      playlists = listOf(res);
      renderList();
    } catch (error) {
      host.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'emoji' }, '💀'),
        h('h3', {}, 'Playlists failed to load'),
        h('p', {}, errorCopy(error, 'The queues are hiding.')),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Try again'),
      ));
    }
  }

  renderTabs();
  await load();
  return () => { /* stateless */ };
}
