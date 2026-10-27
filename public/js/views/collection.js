// Collection detail — poster grid, smart rules explanation, manual curation.
import { api, get, post, del, artFor, placeholderArt } from '../api.js';
import { h, kindLabel, pageHeader, emptyState, toast, confirmDialog, posterGrid } from '../ui.js';
import { rerender } from '../router.js';
import {
  canManage, errorCopy, playFirst, describeRules, openCollectionEditor, openMediaPicker,
} from './collections.js';

function renderLoadError(root, error, navigate) {
  root.append(
    pageHeader('Collection', ['that pile is missing']),
    h('div', { class: 'empty-state' },
      h('div', { class: 'emoji' }, '🧐'),
      h('h3', {}, 'This collection is not here'),
      h('p', {}, errorCopy(error, 'Either it was deleted or the rules ate it.')),
      h('a', { class: 'btn', href: '/collections', 'data-link': true }, '← Back to collections'),
    ),
  );
}

export default async function render(container, ctx) {
  const { params, navigate } = ctx;
  const root = h('div', { class: 'collection-detail' });
  container.append(root);

  let payload;
  try {
    payload = await get(`/api/collections/${encodeURIComponent(params.id)}`);
  } catch (error) {
    renderLoadError(root, error, navigate);
    return;
  }

  const collection = payload?.collection || payload || {};
  let items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(collection.items) ? collection.items : [];
  const manual = collection.kind !== 'smart';
  const allowed = canManage(collection);
  const title = collection.name || 'Untitled pile';
  document.title = `${title} — Collections`;

  const heroArt = collection.art?.backdrop || collection.art?.poster
    || (items[0] ? artFor(items[0], 'backdrop') : placeholderArt(`collection:${collection.id}`, 'backdrop', title));

  const countBadge = h('span', { class: 'pill' }, `${items.length} titles`);
  const gridHost = h('div', { class: 'collection-items' });
  const manageHost = h('div', { class: 'manage-panel', hidden: true });

  const playButton = h('button', {
    class: 'btn primary',
    type: 'button',
    disabled: items.length === 0,
    onclick: () => playFirst(items, navigate),
  }, '▶ Play all');

  const addButton = manual && allowed ? h('button', {
    class: 'btn',
    type: 'button',
    onclick: openAdd,
  }, '＋ Add titles') : null;

  const manageButton = manual && allowed ? h('button', {
    class: 'btn',
    type: 'button',
    'aria-pressed': 'false',
    onclick: () => {
      const showing = !manageHost.hidden;
      manageHost.hidden = showing;
      manageButton.setAttribute('aria-pressed', String(!showing));
      manageButton.classList.toggle('primary', !showing);
      if (!showing) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        manageHost.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      }
    },
  }, '⠿ Arrange') : null;

  const editButton = allowed ? h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => openCollectionEditor({ collection, onSaved: () => rerender() }),
  }, '✎ Edit') : null;

  const deleteButton = allowed ? h('button', {
    class: 'btn danger',
    type: 'button',
    onclick: deleteCollection,
  }, 'Delete') : null;

  root.append(
    h('header', { class: 'collection-hero' },
      h('img', { class: 'collection-hero-art', src: heroArt, alt: '', 'aria-hidden': 'true' }),
      h('div', { class: 'collection-hero-shade' }),
      h('div', { class: 'collection-hero-body' },
        h('div', { class: 'hero-kicker' },
          h('span', { class: `pill${manual ? '' : ' accent'}` }, manual ? 'manual' : 'smart'),
          collection.pinned ? h('span', { class: 'pill warn' }, 'pinned') : null,
          h('span', { class: 'pill' }, `${items.length} title${items.length === 1 ? '' : 's'}`),
        ),
        h('h1', { class: 'collection-hero-title' }, title),
        collection.description ? h('p', { class: 'collection-hero-desc' }, collection.description) : null,
        h('div', { class: 'hero-actions' }, playButton, addButton, manageButton, editButton, deleteButton),
      ),
    ),
  );

  if (!manual) {
    root.append(h('section', { class: 'smart-note' },
      h('div', { class: 'row wrap', style: { gap: '8px' } },
        h('span', { class: 'pill accent' }, 'smart rules'),
        h('strong', {}, 'Evaluated live, never stale'),
      ),
      h('p', { class: 'muted smart-rule-copy' }, describeRules(collection.rules)),
      allowed ? h('button', {
        class: 'btn small',
        type: 'button',
        onclick: () => openCollectionEditor({ collection, onSaved: () => rerender() }),
      }, 'Edit rules') : null,
    ));
  }

  root.append(
    h('div', { class: 'collection-toolbar' },
      countBadge,
      manual && allowed
        ? h('span', { class: 'help' }, 'Arrange mode: drag rows or use arrows. Order saves automatically.')
        : null,
      !allowed && !manual ? h('span', { class: 'help' }, 'Rules are managed by the curator.') : null,
    ),
    gridHost,
    manageHost,
  );

  renderGrid();
  renderManage();
  return () => { /* nothing retained */ };

  function renderGrid() {
    countBadge.textContent = `${items.length} title${items.length === 1 ? '' : 's'}`;
    playButton.disabled = items.length === 0;
    if (!items.length) {
      gridHost.replaceChildren(emptyState(
        manual ? 'Nothing collected yet' : 'No matches (yet)',
        manual
          ? 'Add a few certified bangers and this pile gets a personality.'
          : 'The rules match zero titles right now. Either the library is empty or the rules are too spicy.',
        manual ? '📭' : '🧠',
      ));
      if (manual && allowed) {
        gridHost.append(h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', type: 'button', onclick: openAdd }, '＋ Add titles'),
        ));
      }
      return;
    }
    gridHost.replaceChildren(posterGrid(items, { showKind: true }));
  }

  function renderManage() {
    if (!manual || !allowed) return;
    manageHost.replaceChildren(
      h('div', { class: 'manage-head' },
        h('h2', {}, 'Arrange this pile'),
        h('span', { class: 'help' }, 'Drag rows, or tap the arrows. Save happens on every move.'),
      ),
      items.length
        ? h('div', { class: 'manage-list' }, ...items.map((item, index) => manageRow(item, index)))
        : h('p', { class: 'help' }, 'Nothing to arrange yet. Add titles first.'),
    );
  }

  function manageRow(item, index) {
    const row = h('div', {
      class: 'manage-row',
      draggable: 'true',
      'data-media-id': String(item.id),
    },
    h('span', { class: 'manage-grip', 'aria-hidden': 'true' }, '⠿'),
    h('span', { class: 'manage-num num' }, String(index + 1).padStart(2, '0')),
    h('img', { src: artFor(item, 'poster'), alt: '', loading: 'lazy' }),
    h('div', { class: 'manage-copy' },
      h('strong', { class: 'truncate' }, item.title || 'Untitled slop'),
      h('small', {}, [kindLabel(item.kind), item.year].filter(Boolean).join(' · ')),
    ),
    h('div', { class: 'manage-actions' },
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Move ${item.title || 'title'} up`,
        disabled: index === 0,
        onclick: () => move(index, -1),
      }, '↑'),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Move ${item.title || 'title'} down`,
        disabled: index === items.length - 1,
        onclick: () => move(index, 1),
      }, '↓'),
      h('button', {
        class: 'icon-btn danger',
        type: 'button',
        'aria-label': `Remove ${item.title || 'title'} from collection`,
        onclick: () => removeItem(index),
      }, '✕'),
    ),
    );

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
      manageHost.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
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
      renderGrid();
      renderManage();
      saveOrder();
    });
    return row;
  }
  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const [moved] = items.splice(index, 1);
    items.splice(target, 0, moved);
    renderGrid();
    renderManage();
    saveOrder();
  }

  async function removeItem(index) {
    const item = items[index];
    if (!item) return;
    try {
      await del(`/api/collections/${encodeURIComponent(collection.id)}/items/${encodeURIComponent(item.id)}`);
      items.splice(index, 1);
      renderGrid();
      renderManage();
      toast(`${item.title || 'Title'} removed. The pile is lighter.`, 'success');
    } catch (error) {
      toast(errorCopy(error, 'Could not remove that title.'), 'error');
    }
  }

  async function saveOrder() {
    try {
      await api(`/api/collections/${encodeURIComponent(collection.id)}/items`, {
        method: 'PUT',
        body: { mediaIds: items.map((item) => item.id) },
      });
    } catch (error) {
      toast(`Order did not stick: ${errorCopy(error)}`, 'error');
    }
  }

  function openAdd() {
    openMediaPicker({
      title: 'Add to collection',
      excludeIds: items.map((item) => String(item.id)),
      onPick: async (ids) => {
        await post(`/api/collections/${encodeURIComponent(collection.id)}/items`, { mediaIds: ids });
        toast(`${ids.length} title${ids.length === 1 ? '' : 's'} added. Certified shelf.`, 'success');
        rerender();
      },
    });
  }

  async function deleteCollection() {
    const ok = await confirmDialog(
      'Delete this collection?',
      `“${title}” goes poof. The actual media files stay exactly where they are.`,
      { confirmLabel: 'Delete it' },
    );
    if (!ok) return;
    try {
      await del(`/api/collections/${encodeURIComponent(collection.id)}`);
      toast('Collection deleted. No thoughts head empty.', 'success');
      navigate('/collections');
    } catch (error) {
      toast(errorCopy(error, 'Could not delete that collection.'), 'error');
    }
  }
}

