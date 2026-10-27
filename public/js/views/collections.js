// Collections — curated piles of certified slop. Manual stacks + smart rules.
import { api, get, post, patch, del, placeholderArt, artFor } from '../api.js';
import {
  h, pageHeader, emptyState, modal, toast, confirmDialog, skeletonCards, kindLabel,
} from '../ui.js';
import { state as appState } from '../app.js';

const MEDIA_KINDS = ['movie', 'show', 'episode', 'artist', 'album', 'track', 'photo', 'video'];

const FIELD_META = {
  kind: { label: 'Kind', type: 'kind', ops: ['eq', 'neq', 'in'] },
  genre: { label: 'Genre', type: 'text', list: 'genres', ops: ['eq', 'neq', 'in'] },
  year: { label: 'Year', type: 'number', ops: ['eq', 'neq', 'gte', 'lte', 'gt', 'lt'] },
  rating: { label: 'Rating', type: 'number', ops: ['eq', 'neq', 'gte', 'lte', 'gt', 'lt'] },
  tag: { label: 'Tag', type: 'text', list: 'tags', ops: ['eq', 'neq', 'in'] },
  person: { label: 'Person', type: 'text', ops: ['eq', 'neq', 'contains'] },
  libraryId: { label: 'Library', type: 'library', ops: ['eq', 'neq'] },
  addedWithinDays: { label: 'Added within days', type: 'number', ops: ['lte', 'gte'] },
  titleContains: { label: 'Title contains', type: 'text', ops: ['contains'] },
};

const OP_LABELS = {
  eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of', contains: 'contains',
};

export function listOf(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

export function errorCopy(error, fallback = 'The slop broke. Try again.') {
  return error?.message || fallback;
}

export function canManage(item) {
  const user = appState.user;
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  const owner = item?.createdBy;
  if (owner === undefined || owner === null) return false;
  return owner === user.username || owner === user.displayName || String(owner) === String(user.id);
}

export function normalizeRules(rules) {
  if (typeof rules === 'string') {
    try { return JSON.parse(rules); } catch { return null; }
  }
  return rules && typeof rules === 'object' ? rules : null;
}

export function playFirst(items, navigate) {
  const playable = items.filter((item) => ['movie', 'episode', 'video', 'track'].includes(item?.kind));
  if (!playable.length) {
    if (items.some((item) => item?.kind === 'photo')) {
      navigate('/photos');
      return;
    }
    toast('Nothing playable in this pile. Bold curatorial choice.', 'error');
    return;
  }
  try {
    sessionStorage.setItem('slop:queue', JSON.stringify(playable.map((item) => item.id)));
  } catch { /* private mode: queue is a nice-to-have */ }
  const first = playable[0];
  if (first.kind === 'track') navigate(`/item/${first.id}`);
  else navigate(`/watch/${first.id}`);
}

function ruleValueText(rule) {
  const meta = FIELD_META[rule.field];
  if (!meta) return String(rule.value ?? '');
  if (Array.isArray(rule.value)) return rule.value.join(', ');
  return String(rule.value ?? '');
}

export function describeRule(rule) {
  if (!rule || !FIELD_META[rule.field]) return '';
  const meta = FIELD_META[rule.field];
  const op = OP_LABELS[rule.op] || rule.op;
  const value = ruleValueText(rule);
  if (rule.field === 'addedWithinDays') return `added ${rule.op === 'gte' ? 'before' : 'within'} ${value} days`;
  if (rule.field === 'titleContains') return `title contains “${value}”`;
  if (rule.field === 'rating') return `rating ${op} ${value}`;
  if (rule.field === 'year') return `year ${op} ${value}`;
  if (rule.field === 'libraryId') return `library ${op} #${value}`;
  return `${meta.label.toLowerCase()} ${op} ${value}`;
}

export function describeRules(rules) {
  const normalized = normalizeRules(rules);
  if (!normalized || !Array.isArray(normalized.rules) || !normalized.rules.length) {
    return 'No rules yet — matches everything. Chaos mode.';
  }
  const joiner = normalized.match === 'any' ? ' or ' : ' and ';
  return normalized.rules.map(describeRule).filter(Boolean).join(joiner);
}

function parseRuleValue(meta, raw, op) {
  if (op === 'in') {
    return String(raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      .map((part) => (meta.type === 'number' ? Number(part) : part))
      .filter((part) => (meta.type === 'number' ? Number.isFinite(part) : true));
  }
  if (meta.type === 'number') {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }
  if (meta.type === 'library') {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : text;
  }
  return String(raw ?? '').trim();
}

function valueControlFor(rule, meta, filters, libraries, onChange) {
  if (meta.type === 'kind') {
    return h('select', {
      class: 'select',
      'aria-label': `${meta.label} value`,
      onchange: (event) => onChange(event.target.value),
    }, h('option', { value: '', disabled: true, selected: !rule.value }, 'pick a kind'),
    ...MEDIA_KINDS.map((kind) => h('option', { value: kind, selected: rule.value === kind }, kind)));
  }
  if (meta.type === 'library' && libraries.length) {
    return h('select', {
      class: 'select',
      'aria-label': `${meta.label} value`,
      onchange: (event) => onChange(event.target.value),
    }, h('option', { value: '', disabled: true, selected: rule.value === '' }, 'pick a library'),
    ...libraries.map((lib) => h('option', {
      value: String(lib.id),
      selected: String(rule.value) === String(lib.id),
    }, `${lib.name} (${lib.kind})`)));
  }
  const raw = Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value ?? '');
  const limits = { year: [1800, 2200], rating: [0, 10], addedWithinDays: [0, 3650] }[rule.field];
  return h('input', {
    class: 'input',
    type: meta.type === 'number' ? 'number' : 'text',
    value: String(raw),
    list: meta.list && filters?.[meta.list]?.length ? `rule-list-${meta.list}` : undefined,
    placeholder: meta.list === 'genres' ? 'Action, Comedy' : meta.type === 'number' ? '8' : 'value',
    min: limits ? String(limits[0]) : undefined,
    max: limits ? String(limits[1]) : undefined,
    step: rule.field === 'rating' ? '0.1' : meta.type === 'number' ? '1' : undefined,
    'aria-label': `${meta.label} value`,
    oninput: (event) => onChange(event.target.value),
  });
}
function createRulesEditor(initial, filters, libraries) {
  const state = {
    match: initial?.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(initial?.rules) && initial.rules.length
      ? initial.rules.map((rule) => ({
        field: FIELD_META[rule.field] ? rule.field : 'kind',
        op: FIELD_META[rule.field]?.ops.includes(rule.op) ? rule.op : 'eq',
        value: rule.value ?? '',
      }))
      : [{ field: 'kind', op: 'eq', value: '' }],
  };

  const rowsHost = h('div', { class: 'rule-rows' });
  const emptyHint = h('p', { class: 'help' }, 'No rules → everything matches. Add at least one to make it smart.');

  function renderRows() {
    rowsHost.replaceChildren();
    state.rules.forEach((rule, index) => {
      const meta = FIELD_META[rule.field];
      const fieldSelect = h('select', {
        class: 'select rule-field',
        'aria-label': `Rule ${index + 1} field`,
        onchange: (event) => {
          rule.field = event.target.value;
          const nextMeta = FIELD_META[rule.field];
          if (!nextMeta.ops.includes(rule.op)) rule.op = nextMeta.ops[0];
          rule.value = '';
          renderRows();
        },
      }, ...Object.entries(FIELD_META).map(([value, info]) => h('option', {
        value, selected: rule.field === value,
      }, info.label)));

      const opSelect = h('select', {
        class: 'select rule-op',
        'aria-label': `Rule ${index + 1} operator`,
        onchange: (event) => { rule.op = event.target.value; renderRows(); },
      }, ...meta.ops.map((op) => h('option', { value: op, selected: rule.op === op }, OP_LABELS[op])));

      const valueControl = valueControlFor(rule, meta, filters, libraries, (value) => { rule.value = value; });

      rowsHost.append(h('div', { class: 'rule-row' },
        fieldSelect,
        opSelect,
        valueControl,
        h('button', {
          class: 'icon-btn rule-remove',
          type: 'button',
          'aria-label': `Remove rule ${index + 1}`,
          title: 'Remove rule',
          onclick: () => { state.rules.splice(index, 1); renderRows(); },
        }, '✕'),
      ));
    });
    emptyHint.hidden = state.rules.length > 0;
  }

  const matchAll = h('button', {
    class: `chip${state.match === 'all' ? ' active' : ''}`,
    type: 'button',
    'aria-pressed': String(state.match === 'all'),
    onclick: () => setMatch('all'),
  }, 'match all');
  const matchAny = h('button', {
    class: `chip${state.match === 'any' ? ' active' : ''}`,
    type: 'button',
    'aria-pressed': String(state.match === 'any'),
    onclick: () => setMatch('any'),
  }, 'match any');
  function setMatch(match) {
    state.match = match;
    matchAll.classList.toggle('active', match === 'all');
    matchAny.classList.toggle('active', match === 'any');
    matchAll.setAttribute('aria-pressed', String(match === 'all'));
    matchAny.setAttribute('aria-pressed', String(match === 'any'));
  }

  const listHost = h('div', { hidden: true });
  for (const name of ['genres', 'tags']) {
    const values = filters?.[name];
    if (!Array.isArray(values) || !values.length) continue;
    listHost.append(h('datalist', { id: `rule-list-${name}` },
      ...values.map((value) => h('option', { value: String(value) }))));
  }

  const wrap = h('div', { class: 'rule-builder' },
    h('div', { class: 'row wrap', style: { gap: '6px' } }, h('span', { class: 'small muted' }, 'Titles matching'), matchAll, matchAny),
    rowsHost,
    emptyHint,
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      onclick: () => { state.rules.push({ field: 'genre', op: 'eq', value: '' }); renderRows(); },
    }, '＋ Add rule'),
    listHost,
    h('p', { class: 'help' }, 'Rules evaluate live against the whole library. Cap: 500 titles, so no infinite slop.'),
  );
  renderRows();

  return {
    node: wrap,
    build() {
      const rules = [];
      for (const rule of state.rules) {
        const meta = FIELD_META[rule.field];
        const value = parseRuleValue(meta, rule.value, rule.op);
        const missing = value === null || value === ''
          || (Array.isArray(value) && value.length === 0);
        if (missing) return { error: `Give rule “${meta.label}” a value. Rules without values are just vibes.` };
        rules.push({ field: rule.field, op: rule.op, value });
      }
      if (!rules.length) return { error: 'Smart collections need at least one rule.' };
      return { rules: { match: state.match, rules } };
    },
  };
}

export async function openCollectionEditor({ collection = null, onSaved } = {}) {
  const isEdit = Boolean(collection?.id);
  const [filtersRes, libsRes] = await Promise.allSettled([get('/api/browse/filters'), get('/api/libraries')]);
  const filters = filtersRes.status === 'fulfilled' ? filtersRes.value : null;
  const libraries = libsRes.status === 'fulfilled' ? listOf(libsRes.value) : [];
  const existingRules = normalizeRules(collection?.rules);

  const nameInput = h('input', {
    class: 'input',
    id: 'collection-name',
    maxlength: '80',
    required: true,
    value: collection?.name || '',
    placeholder: 'Certified Bangers',
    'aria-label': 'Collection name',
  });
  const descriptionInput = h('textarea', {
    class: 'textarea',
    id: 'collection-description',
    maxlength: '500',
    rows: '3',
    placeholder: 'Why does this pile exist? Be honest.',
    'aria-label': 'Collection description',
  });
  descriptionInput.value = collection?.description || '';

  const rulesEditor = createRulesEditor(existingRules, filters, libraries);
  let kind = collection?.kind === 'smart' ? 'smart' : 'manual';

  const manualChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, 'manual');
  const smartChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, 'smart rules');
  const rulesHost = h('div', { class: 'stack' }, rulesEditor.node);
  const kindHint = h('p', { class: 'help' });

  function setKind(next) {
    kind = next;
    manualChip.classList.toggle('active', kind === 'manual');
    smartChip.classList.toggle('active', kind === 'smart');
    manualChip.setAttribute('aria-pressed', String(kind === 'manual'));
    smartChip.setAttribute('aria-pressed', String(kind === 'smart'));
    rulesHost.hidden = kind !== 'smart';
    kindHint.textContent = kind === 'smart'
      ? 'Smart collections evaluate rules at read time. No stale piles.'
      : 'Manual collections are hand-picked. You are the algorithm.';
  }
  manualChip.addEventListener('click', () => setKind('manual'));
  smartChip.addEventListener('click', () => setKind('smart'));
  setKind(kind);

  const errorNode = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const body = h('div', { class: 'stack', style: { gap: '14px' } },
    h('div', { class: 'field' }, h('label', { for: 'collection-name' }, 'Name'), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'collection-description' }, 'Description'), descriptionInput),
    h('div', { class: 'field' },
      h('label', {}, 'Type'),
      h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Collection type' }, manualChip, smartChip),
      kindHint,
    ),
    rulesHost,
    errorNode,
  );

  modal({
    title: isEdit ? 'Edit collection' : 'New collection',
    body,
    wide: true,
    actions: [
      { label: 'Cancel' },
      {
        label: isEdit ? 'Save changes' : 'Create collection',
        kind: 'primary',
        onClick: async () => {
          errorNode.hidden = true;
          const name = nameInput.value.trim();
          if (!name) {
            errorNode.textContent = 'Name required. A nameless pile is just a drawer.';
            errorNode.hidden = false;
            nameInput.focus();
            return false;
          }
          const payload = {
            name,
            description: descriptionInput.value.trim(),
            kind,
          };
          if (kind === 'smart') {
            const built = rulesEditor.build();
            if (built.error) {
              errorNode.textContent = built.error;
              errorNode.hidden = false;
              return false;
            }
            payload.rules = built.rules;
          }
          try {
            if (isEdit) await patch(`/api/collections/${collection.id}`, payload);
            else await post('/api/collections', payload);
            toast(isEdit ? 'Collection updated. Curation arc.' : 'Collection created. Certified shelf.', 'success');
            onSaved?.();
          } catch (error) {
            errorNode.textContent = errorCopy(error, 'Could not save that collection.');
            errorNode.hidden = false;
            return false;
          }
          return true;
        },
      },
    ],
  });
}
function collectSearchItems(res) {
  const items = [];
  const push = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === undefined || value.id === null) return;
    if (!items.some((item) => String(item.id) === String(value.id) && item.kind === value.kind)) items.push(value);
  };
  for (const item of listOf(res)) push(item);
  if (res?.groups && typeof res.groups === 'object') {
    for (const group of Object.values(res.groups)) {
      if (Array.isArray(group)) group.forEach(push);
    }
  }
  return items;
}

export function openMediaPicker({ title = 'Add titles', excludeIds = [], kinds = null, onPick } = {}) {
  const excluded = new Set(excludeIds.map(String));
  const allowedKinds = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const selected = new Map();
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search movies, shows, episodes, tracks…',
    'aria-label': 'Search media to add',
    autocomplete: 'off',
  });
  const status = h('p', { class: 'help', role: 'status' }, 'Loading the pile…');
  const results = h('div', { class: 'picker-results' });
  const errorNode = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const addButton = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Add selected');
  let controller = null;
  let timer = null;

  function updateAddButton() {
    addButton.disabled = selected.size === 0;
    addButton.textContent = selected.size ? `Add ${selected.size} title${selected.size === 1 ? '' : 's'}` : 'Add selected';
  }

  function renderResults(items) {
    results.replaceChildren();
    if (!items.length) {
      results.append(h('div', { class: 'picker-empty' }, 'Nothing found. Try fewer words, more vibes.'));
      return;
    }
    for (const item of items) {
      const isSelected = selected.has(String(item.id));
      const row = h('button', {
        class: `picker-row${isSelected ? ' selected' : ''}`,
        type: 'button',
        'aria-pressed': String(isSelected),
        onclick: () => {
          const key = String(item.id);
          if (selected.has(key)) selected.delete(key);
          else selected.set(key, item);
          row.classList.toggle('selected', selected.has(key));
          row.setAttribute('aria-pressed', String(selected.has(key)));
          row.querySelector('.picker-check').textContent = selected.has(key) ? '✓' : '＋';
          updateAddButton();
        },
      },
      h('img', { src: artFor(item, 'poster'), alt: '', loading: 'lazy' }),
      h('span', { class: 'picker-copy' },
        h('strong', {}, item.title || 'Untitled slop'),
        h('small', {}, [kindLabel(item.kind), item.year, item.artistName].filter(Boolean).join(' · ')),
      ),
      h('span', { class: 'picker-check' }, isSelected ? '✓' : '＋'),
      );
      results.append(row);
    }
  }

  async function load(query) {
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    status.hidden = false;
    status.textContent = query ? 'Searching the slop…' : 'Loading suggestions…';
    errorNode.hidden = true;
    try {
      let items;
      if (query) {
        const res = await get(`/api/browse/search?q=${encodeURIComponent(query)}`, { signal });
        items = collectSearchItems(res);
      } else {
        const res = await get('/api/browse?pageSize=24&sort=added', { signal });
        items = listOf(res);
      }
      const filtered = items.filter((item) => !excluded.has(String(item.id))
        && (!allowedKinds || allowedKinds.has(item.kind)));
      status.hidden = true;
      if (!filtered.length && allowedKinds) {
        renderResults([]);
        status.hidden = false;
        status.textContent = 'Nothing compatible here. This playlist is picky.';
        return;
      }
      renderResults(filtered.slice(0, 60));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      status.hidden = true;
      errorNode.textContent = errorCopy(error, 'Search failed. The slop is shy.');
      errorNode.hidden = false;
    }
  }

  searchInput.addEventListener('input', () => {
    window.clearTimeout(timer);
    const query = searchInput.value.trim();
    timer = window.setTimeout(() => load(query), 280);
  });

  addButton.addEventListener('click', async () => {
    if (!selected.size) return;
    addButton.disabled = true;
    addButton.textContent = 'Adding…';
    try {
      await onPick?.([...selected.keys()].map((id) => (/^\d+$/.test(id) ? Number(id) : id)));
      ref?.close();
    } catch (error) {
      errorNode.textContent = errorCopy(error, 'Could not add those titles.');
      errorNode.hidden = false;
      updateAddButton();
    }
  });

  const body = h('div', { class: 'stack', style: { gap: '12px' } },
    searchInput,
    status,
    errorNode,
    results,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('span', { class: 'faint small' }, 'Episodes, tracks, photos — all fair game.'),
      addButton,
    ),
  );

  const ref = modal({ title, body, wide: true });
  load('');
  return ref;
}

function collectionCard(collection, onChanged) {
  const art = collection.art?.poster || collection.art?.thumb
    || placeholderArt(`collection:${collection.id}`, 'backdrop', collection.name);
  const manage = canManage(collection);
  return h('article', { class: 'collection-tile', 'data-focus': true },
    h('a', {
      class: 'collection-tile-hit',
      href: `/collections/${collection.id}`,
      'data-link': true,
      'aria-label': `${collection.name} — ${collection.itemCount ?? 0} items`,
    },
    h('img', { class: 'collection-tile-art', src: art, alt: '', loading: 'lazy', decoding: 'async' }),
    h('div', { class: 'collection-tile-shade' }),
    h('div', { class: 'collection-tile-body' },
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        h('span', { class: `pill${collection.kind === 'smart' ? ' accent' : ''}` }, collection.kind === 'smart' ? 'smart' : 'manual'),
        collection.pinned ? h('span', { class: 'pill warn' }, 'pinned') : null,
        h('span', { class: 'faint small' }, `${collection.itemCount ?? 0} items`),
      ),
      h('strong', { class: 'collection-tile-name' }, collection.name || 'Untitled pile'),
      collection.description ? h('p', { class: 'small muted clamp-2' }, collection.description) : null,
    ),
    ),
    manage ? h('div', { class: 'collection-tile-tools' },
      h('button', {
        class: 'icon-round small',
        type: 'button',
        'aria-label': `Edit ${collection.name}`,
        title: 'Edit collection',
        onclick: () => openCollectionEditor({ collection, onSaved: onChanged }),
      }, '✎'),
      h('button', {
        class: 'icon-round small danger',
        type: 'button',
        'aria-label': `Delete ${collection.name}`,
        title: 'Delete collection',
        onclick: async () => {
          const ok = await confirmDialog(
            'Delete this collection?',
            `“${collection.name}” goes poof. The media files stay exactly where they are.`,
            { confirmLabel: 'Delete it' },
          );
          if (!ok) return;
          try {
            await del(`/api/collections/${collection.id}`);
            toast('Collection deleted. No thoughts head empty.', 'success');
            onChanged?.();
          } catch (error) {
            toast(errorCopy(error, 'Could not delete that collection.'), 'error');
          }
        },
      }, '🗑'),
    ) : null,
  );
}

export default async function render(container, ctx) {
  const user = appState.user;
  container.append(h('div', { class: 'view-head' },
    pageHeader('Collections', ['Curated piles · smart rules · zero cloud'], [
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => openCollectionEditor({ onSaved: load }),
      }, '＋ New collection'),
    ]),
  ));

  const host = h('div', { class: 'stack', style: { gap: '20px' } });
  container.append(host);

  async function load() {
    host.replaceChildren(h('div', { class: 'collection-grid' }, ...skeletonCards(8, true)));
    try {
      const res = await get('/api/collections?pageSize=100');
      const collections = listOf(res)
        .map((collection) => ({ ...collection, kind: collection.kind === 'smart' ? 'smart' : 'manual' }));
      if (!collections.length) {
        host.replaceChildren(emptyState(
          'No collections yet',
          'The shelves are bare. Make a pile of certified bangers, or let smart rules cook.',
          '🗃️',
        ));
        host.append(h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: () => openCollectionEditor({ onSaved: load }),
          }, '＋ Create the first one'),
        ));
        return;
      }
      host.replaceChildren(
        h('div', { class: 'collection-grid' }, ...collections.map((collection) => collectionCard(collection, load))),
        h('p', { class: 'faint small' },
          `${collections.length} collection${collections.length === 1 ? '' : 's'} · ${user?.role === 'admin' ? 'you can edit everything' : 'you can edit your own'}`),
      );
    } catch (error) {
      host.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'emoji' }, '💀'),
        h('h3', {}, 'Collections failed to load'),
        h('p', {}, errorCopy(error, 'The piles are shy today.')),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Try again'),
      ));
    }
  }

  await load();
  return () => { /* no listeners to clean up */ };
}


