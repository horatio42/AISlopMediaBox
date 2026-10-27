// Requests — ask for slop, review it, report content. Democracy-ish.
import { get, post, patch, del, fmtRelative, fmtDate } from '../api.js';
import { h, pageHeader, emptyState, modal, toast, confirmDialog, kindLabel } from '../ui.js';
import { state as appState } from '../app.js';
import { listOf, errorCopy } from './collections.js';

const STATUSES = ['pending', 'approved', 'rejected', 'fulfilled'];
const STATUS_LABELS = { pending: 'pending', approved: 'approved', rejected: 'rejected', fulfilled: 'fulfilled' };
const STATUS_PILL = { pending: 'warn', approved: 'good', rejected: 'bad', fulfilled: 'accent' };
const REQUEST_KINDS = [
  { value: 'movie', label: 'Movie' },
  { value: 'show', label: 'Show' },
  { value: 'music', label: 'Music' },
  { value: 'other', label: 'Other slop' },
];

function normalizeRequest(raw) {
  const status = STATUSES.includes(raw?.status) ? raw.status : 'pending';
  return {
    id: raw?.id,
    title: raw?.title || 'Untitled request',
    kind: raw?.kind || 'other',
    year: raw?.year ?? raw?.releaseYear ?? null,
    note: raw?.note || '',
    status,
    reviewNote: raw?.reviewNote ?? raw?.review_note ?? '',
    createdAt: raw?.createdAt ?? raw?.created_at ?? null,
    updatedAt: raw?.updatedAt ?? raw?.updated_at ?? null,
    reviewedBy: raw?.reviewedBy?.displayName ?? raw?.reviewedBy?.username
      ?? raw?.reviewed_by_name ?? (typeof raw?.reviewedBy === 'string' ? raw.reviewedBy : null),
    requester: raw?.user?.displayName ?? raw?.user?.username ?? raw?.requesterName
      ?? raw?.requester ?? raw?.username ?? raw?.userName ?? raw?.createdBy ?? null,
    userId: raw?.user?.id ?? raw?.userId ?? raw?.user_id ?? null,
  };
}

function deriveCounts(requests) {
  const counts = { total: requests.length, pending: 0, approved: 0, rejected: 0, fulfilled: 0 };
  for (const request of requests) {
    if (counts[request.status] !== undefined) counts[request.status] += 1;
  }
  return counts;
}

function normalizeStats(res) {
  if (!res || typeof res !== 'object') return null;
  const source = res.counts || res.byStatus || res.statusCounts || res;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const normalized = {
    total: num(source.total ?? source.all),
    pending: num(source.pending),
    approved: num(source.approved),
    rejected: num(source.rejected),
    fulfilled: num(source.fulfilled),
  };
  return normalized.total || normalized.pending || normalized.approved || normalized.rejected || normalized.fulfilled
    ? normalized
    : null;
}
function collectMedia(res) {
  const found = [];
  const push = (value) => {
    if (!value || typeof value !== 'object' || value.id === undefined || value.id === null) return;
    if (value.kind === 'season' || found.some((entry) => String(entry.id) === String(value.id) && entry.kind === value.kind)) return;
    found.push(value);
  };
  for (const item of listOf(res)) push(item);
  if (res?.groups && typeof res.groups === 'object') {
    for (const group of Object.values(res.groups)) {
      if (Array.isArray(group)) group.forEach(push);
    }
  }
  return found.slice(0, 30);
}

function openReportForm() {
  let picked = null;
  let controller = null;
  let timer = null;

  const searchInput = h('input', {
    class: 'input',
    id: 'report-search',
    type: 'search',
    placeholder: 'Search the title you want to report…',
    'aria-label': 'Search media to report',
    autocomplete: 'off',
  });
  const resultsHost = h('div', { class: 'report-results' });
  const pickedHost = h('div', { class: 'report-picked', hidden: true });
  const titleFallback = h('input', {
    class: 'input',
    id: 'report-title',
    maxlength: '200',
    placeholder: 'Title, if it is not in the library',
    'aria-label': 'Reported title',
  });
  const reason = h('textarea', {
    class: 'textarea',
    id: 'report-reason',
    rows: '4',
    maxlength: '600',
    placeholder: 'What is wrong? Wrong art? Unplayable? Offensive? Be specific, not feral.',
    'aria-label': 'Report reason',
  });
  const errorNode = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submitButton = h('button', { class: 'btn primary', type: 'button', onclick: send }, 'Send report');

  function showPicked() {
    pickedHost.replaceChildren();
    if (!picked) {
      pickedHost.hidden = true;
      return;
    }
    pickedHost.hidden = false;
    pickedHost.append(
      h('span', { class: 'pill accent' }, 'attached'),
      h('span', { class: 'truncate' }, `${picked.title || 'Untitled'} (${kindLabel(picked.kind)})`),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Remove attached title',
        onclick: () => { picked = null; showPicked(); },
      }, '✕'),
    );
  }

  async function search(query) {
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    try {
      let items = [];
      if (query) {
        const res = await get(`/api/browse/search?q=${encodeURIComponent(query)}`, { signal });
        items = collectMedia(res);
      } else {
        const res = await get('/api/browse?pageSize=12&sort=added', { signal });
        items = listOf(res);
      }
      resultsHost.replaceChildren();
      if (!items.length) {
        resultsHost.append(h('p', { class: 'help' }, query ? 'No matches. Maybe it is not here yet — file a request instead.' : 'No media in the library yet.'));
        return;
      }
      for (const item of items) {
        resultsHost.append(h('button', {
          class: 'report-result',
          type: 'button',
          onclick: () => { picked = item; showPicked(); searchInput.value = ''; search(''); },
        }, h('strong', { class: 'truncate' }, item.title || 'Untitled'), h('span', { class: 'faint small' }, kindLabel(item.kind))));
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      resultsHost.replaceChildren(h('p', { class: 'help' }, errorCopy(error, 'Search failed.')));
    }
  }

  async function send() {
    errorNode.hidden = true;
    const text = reason.value.trim();
    if (text.length < 5) {
      errorNode.textContent = 'Give us at least a few words. “It bad” helps nobody.';
      errorNode.hidden = false;
      reason.focus();
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';
    try {
      const body = { reason: text };
      if (picked?.id !== undefined) {
        body.mediaId = picked.id;
      } else {
        const title = titleFallback.value.trim();
        if (!title) {
          errorNode.textContent = 'Pick a title from the library, or type one below.';
          errorNode.hidden = false;
          titleFallback.focus();
          return;
        }
        body.title = title;
      }
      await post('/api/requests/reports', body);
      toast('Report sent to the council. They will judge.', 'success');
      ref?.close();
    } catch (error) {
      errorNode.textContent = errorCopy(error, 'Could not send that report.');
      errorNode.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Send report';
    }
  }

  searchInput.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => search(searchInput.value.trim()), 260);
  });

  const body = h('div', { class: 'stack', style: { gap: '12px' } },
    h('p', { class: 'muted small' }, 'Flag a broken or cursed title. Reports are logged locally; nobody outside this box hears about it.'),
    h('div', { class: 'field' }, h('label', { for: 'report-search' }, 'Find it in the library'), searchInput, resultsHost, pickedHost),
    h('div', { class: 'field' }, h('label', { for: 'report-title' }, 'Or type the title'), titleFallback,
      h('p', { class: 'help' }, 'Use this when the thing is not in the library yet. One of the two is required.')),
    h('div', { class: 'field' }, h('label', { for: 'report-reason' }, 'What is wrong?'), reason),
    errorNode,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, submitButton),
  );

  const ref = modal({ title: 'Report content', body, wide: true });
  search('');
}
function buildRequestForm(onCreated) {
  const titleInput = h('input', {
    class: 'input',
    id: 'request-title',
    maxlength: '120',
    placeholder: 'The Movie Everyone Keeps Yelling About (2019)',
    'aria-label': 'Requested title',
    required: true,
  });
  const kindSelect = h('select', { class: 'select', id: 'request-kind', 'aria-label': 'Request kind' },
    ...REQUEST_KINDS.map((entry) => h('option', { value: entry.value }, entry.label)));
  const yearInput = h('input', {
    class: 'input',
    id: 'request-year',
    type: 'number',
    min: '1888',
    max: '2100',
    placeholder: '2019',
    'aria-label': 'Release year (optional)',
  });
  const noteInput = h('textarea', {
    class: 'textarea',
    id: 'request-note',
    rows: '2',
    maxlength: '600',
    placeholder: 'Optional context. “It slaps” counts as context.',
    'aria-label': 'Request note (optional)',
  });
  const errorNode = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submitButton = h('button', { class: 'btn primary', type: 'submit' }, 'Send request');

  const form = h('form', { class: 'card request-form', novalidate: true },
    h('div', { class: 'form-head' },
      h('h2', {}, 'Request a title'),
      h('p', { class: 'help' }, 'The council checks these when they remember. No emails, no cloud, no promises.'),
    ),
    h('div', { class: 'request-form-grid' },
      h('div', { class: 'field request-title-field' }, h('label', { for: 'request-title' }, 'Title'), titleInput),
      h('div', { class: 'field' }, h('label', { for: 'request-kind' }, 'Kind'), kindSelect),
      h('div', { class: 'field' }, h('label', { for: 'request-year' }, 'Year'), yearInput),
    ),
    h('div', { class: 'field' }, h('label', { for: 'request-note' }, 'Note'), noteInput),
    errorNode,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, submitButton),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    const title = titleInput.value.trim();
    if (!title) {
      errorNode.textContent = 'Title required. Otherwise we are requesting vibes.';
      errorNode.hidden = false;
      titleInput.focus();
      return;
    }
    const yearRaw = yearInput.value.trim();
    let year = null;
    if (yearRaw) {
      year = Number(yearRaw);
      if (!Number.isInteger(year) || year < 1888 || year > 2100) {
        errorNode.textContent = 'Year should be a real number between 1888 and 2100.';
        errorNode.hidden = false;
        yearInput.focus();
        return;
      }
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';
    try {
      await post('/api/requests', {
        title,
        kind: kindSelect.value,
        year,
        note: noteInput.value.trim(),
      });
      toast('Request sent. The council will deliberate, slowly.', 'success', { emoji: '✉️' });
      titleInput.value = '';
      yearInput.value = '';
      noteInput.value = '';
      onCreated?.();
    } catch (error) {
      errorNode.textContent = errorCopy(error, 'Could not send that request.');
      errorNode.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Send request';
    }
  });

  return form;
}

export default async function render(container) {
  const user = appState.user;
  const reviewer = ['admin', 'manager'].includes(user?.role);
  const currentUserId = user?.id;
  let requests = [];
  let filter = 'all';

  const branding = await get('/api/branding').catch(() => ({ allowRequests: true }));
  const allowsRequests = branding?.allowRequests !== false;

  container.append(pageHeader('Requests', [
    reviewer ? 'You are the council. Judge wisely.' : 'Ask for slop · the council reviews',
    'local-only, no emails',
  ], [
    h('button', { class: 'btn', type: 'button', onclick: openReportForm }, '⚑ Report content'),
  ]));

  const statsHost = h('div', { class: 'stat-grid request-stats' });
  const formHost = h('div');
  const tabsHost = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Request status filters' });
  const listHost = h('div', { class: 'stack' });
  container.append(statsHost, formHost, tabsHost, listHost);

  if (allowsRequests) {
    formHost.append(buildRequestForm(() => { filter = 'all'; load(); }));
  } else {
    formHost.append(h('div', { class: 'notice' },
      h('span', { class: 'notice-emoji', 'aria-hidden': 'true' }, '🔒'),
      h('div', {},
        h('strong', {}, 'Requests are closed'),
        h('p', { class: 'muted small' }, 'The council is not taking submissions right now. Reports still work — snitching remains enabled.'),
      ),
    ));
  }

  renderTabs();
  await load();

  return () => { /* no retained listeners */ };

  function statusCounts() {
    return deriveCounts(requests);
  }

  function renderStats(counts) {
    const cards = [
      { label: 'total', value: counts.total, accent: false },
      { label: 'pending', value: counts.pending, accent: true },
      { label: 'approved', value: counts.approved, accent: false },
      { label: 'fulfilled', value: counts.fulfilled, accent: false },
      { label: 'rejected', value: counts.rejected, accent: false },
    ];
    statsHost.replaceChildren(...cards.map((card) => h('div', { class: 'stat' },
      h('div', { class: 'label' }, card.label),
      h('div', { class: `value${card.accent ? ' accent' : ''}` }, String(card.value)),
    )));
  }

  function renderTabs() {
    const counts = statusCounts();
    const entries = [
      { id: 'all', label: 'All', count: counts.total },
      ...STATUSES.map((status) => ({ id: status, label: STATUS_LABELS[status], count: counts[status] })),
    ];
    tabsHost.replaceChildren(...entries.map((entry) => h('button', {
      class: `tab${filter === entry.id ? ' active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(filter === entry.id),
      onclick: () => { filter = entry.id; renderList(); },
    }, entry.label, h('span', { class: 'tab-count mono' }, String(entry.count)))));
  }

  function renderList() {
    const visible = filter === 'all' ? requests : requests.filter((request) => request.status === filter);
    if (!visible.length) {
      const copy = requests.length
        ? ['Nothing in this bucket', 'That status is empty. Try another tab, or make some history.', '🫗']
        : ['No requests yet', allowsRequests
          ? 'The wishlist is empty. Ask for a certified banger and the council will pretend to deliberate.'
          : 'Requests are closed and nobody has filed one. The silence is peaceful.', '📭'];
      listHost.replaceChildren(emptyState(copy[0], copy[1], copy[2]));
      return;
    }
    listHost.replaceChildren(h('div', { class: 'request-list' },
      ...visible.map((request) => requestCard(request))));
  }

  function requestCard(request) {
    const own = currentUserId !== undefined && request.userId !== null
      && String(request.userId) === String(currentUserId);
    const canCancel = own && request.status === 'pending';
    const noteInput = h('textarea', {
      class: 'textarea',
      rows: '2',
      maxlength: '400',
      placeholder: 'Review note for the requester (optional, judging encouraged).',
      'aria-label': `Review note for ${request.title}`,
    });
    noteInput.value = request.reviewNote || '';

    const transitions = request.status === 'pending'
      ? [
        { label: 'Approve', status: 'approved', kind: 'good' },
        { label: 'Reject', status: 'rejected', kind: 'danger' },
        { label: 'Fulfill', status: 'fulfilled', kind: 'primary' },
      ]
      : request.status === 'approved'
        ? [{ label: 'Fulfill', status: 'fulfilled', kind: 'primary' }]
        : [];
    const canReview = reviewer && transitions.length > 0;

    const reviewBox = canReview ? h('div', { class: 'review-box', hidden: true },
      noteInput,
      h('div', { class: 'row wrap' },
        ...transitions.map((transition) => reviewButton(transition.label, transition.status, transition.kind)),
      ),
    ) : null;

    function reviewButton(label, status, kind) {
      return h('button', {
        class: `btn small ${kind}`,
        type: 'button',
        onclick: () => reviewRequest(request, status, noteInput.value),
      }, label);
    }

    const reviewToggle = canReview ? h('button', {
      class: 'btn small',
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        const show = reviewBox.hidden;
        reviewBox.hidden = !show;
        reviewToggle.setAttribute('aria-expanded', String(show));
        reviewToggle.textContent = show ? 'Close review' : 'Review';
        if (show) noteInput.focus();
      },
    }, 'Review') : null;

    const metaParts = [];
    if (request.requester) metaParts.push(`by ${request.requester}`);
    if (request.createdAt) metaParts.push(fmtRelative(request.createdAt));

    return h('article', { class: 'request-card', 'data-request-id': String(request.id) },
      h('div', { class: 'request-top' },
        h('div', { class: 'request-head' },
          h('strong', { class: 'request-title' }, request.title),
          h('span', { class: `pill ${STATUS_PILL[request.status] || ''}` }, request.status),
          h('span', { class: 'pill' }, kindLabel(request.kind)),
          request.year ? h('span', { class: 'pill mono' }, String(request.year)) : null,
        ),
        h('div', { class: 'row wrap', style: { gap: '8px' } },
          own ? h('span', { class: 'pill' }, 'yours') : null,
          reviewToggle,
          canCancel ? h('button', {
            class: 'btn small danger',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog('Cancel this request?', `“${request.title}” will be withdrawn from the council’s inbox.`, { confirmLabel: 'Withdraw' });
              if (!ok) return;
              try {
                await del(`/api/requests/${request.id}`);
                toast('Request withdrawn. No hard feelings.', 'success');
                await load();
              } catch (error) {
                toast(errorCopy(error, 'Could not cancel that request.'), 'error');
              }
            },
          }, 'Cancel') : null,
        ),
      ),
      metaParts.length ? h('p', { class: 'request-meta faint small', title: request.createdAt ? fmtDate(request.createdAt, true) : '' }, metaParts.join(' · ')) : null,
      request.note ? h('p', { class: 'request-note' }, request.note) : null,
      request.reviewNote && request.status !== 'pending'
        ? h('div', { class: 'review-note' },
          h('span', { class: 'eyebrow' }, 'review note'),
          h('p', {}, request.reviewNote),
          request.reviewedBy ? h('small', { class: 'faint' }, `— ${request.reviewedBy}`) : null,
        )
        : null,
      reviewBox,
    );
  }

  async function reviewRequest(request, status, reviewNote) {
    try {
      await patch(`/api/requests/${request.id}`, { status, reviewNote: reviewNote.trim() });
      toast(`Marked ${status}. The wheels of slop justice turn.`, 'success', { emoji: status === 'rejected' ? '🫡' : '✅' });
      await load();
    } catch (error) {
      toast(errorCopy(error, 'Could not update that request.'), 'error');
    }
  }

  async function load() {
    listHost.replaceChildren(h('div', { class: 'view-loading' }, h('div', { class: 'spinner' })));
    try {
      const [listRes, statsRes] = await Promise.allSettled([
        get('/api/requests?pageSize=100'),
        get('/api/requests/stats'),
      ]);
      if (listRes.status === 'rejected') throw listRes.reason;
      requests = listOf(listRes.value).map(normalizeRequest);
      const apiCounts = statsRes.status === 'fulfilled' ? normalizeStats(statsRes.value) : null;
      const counts = apiCounts || deriveCounts(requests);
      if (counts.total < requests.length) counts.total = requests.length;
      renderStats(counts);
      renderTabs();
      renderList();
    } catch (error) {
      listHost.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'emoji' }, '💀'),
        h('h3', {}, 'Requests failed to load'),
        h('p', {}, errorCopy(error, 'The inbox is a void right now.')),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Try again'),
      ));
    }
  }
}


