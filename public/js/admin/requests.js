// Requests: filter by status/kind, approve/reject/fulfil with review notes.
import {
  h, adminGet, adminPatch, pageHead, btn, badge, emptyState, errorState, skeletonRows,
  formModal, field, selectInput, textareaInput, toast, pagination, dataTable, toolbar,
  fmtNum, fmtAgo, fmtWhen, safeText, apiError, debounce,
} from './core.js';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'rejected', label: 'Rejected' },
];
const KIND_OPTIONS = [
  { value: '', label: 'All kinds' },
  { value: 'movie', label: 'Movie' },
  { value: 'show', label: 'Show' },
  { value: 'music', label: 'Music' },
  { value: 'other', label: 'Other' },
];
const uiState = { q: '', status: 'pending', kind: '', page: 1, pageSize: 25 };

function fieldOf(row, camel, snake, fallback = '') {
  const value = row?.[camel] ?? row?.[snake];
  return value === undefined || value === null ? fallback : value;
}

function requesterName(row) {
  const requester = row.requester || row.requestedBy || row.user;
  if (requester) return requester.displayName || requester.username || 'unknown';
  return fieldOf(row, 'username', 'username', 'unknown');
}

function reviewerName(row) {
  const reviewer = row.reviewer || row.reviewedBy;
  if (reviewer) return reviewer.displayName || reviewer.username || null;
  return null;
}

function reviewRequest(row, preset, draw) {
  let status = preset || fieldOf(row, 'status', 'status', 'pending');
  let note = fieldOf(row, 'reviewNote', 'review_note', '');
  const title = fieldOf(row, 'title', 'title');
  const requester = requesterName(row);
  const body = h('div', {},
    h('div', { class: 'adm-note' },
      h('strong', {}, title),
      ` requested by @${requester}`,
      fieldOf(row, 'year', 'year') ? ` · ${fieldOf(row, 'year', 'year')}` : '',
      fieldOf(row, 'kind', 'kind') ? ` · ${fieldOf(row, 'kind', 'kind')}` : '',
      fieldOf(row, 'note', 'note') ? h('div', { style: { marginTop: '6px' } }, `“${fieldOf(row, 'note', 'note')}”`) : null,
    ),
    field('Decision', selectInput({
      value: status,
      options: [
        { value: 'approved', label: 'Approved — looking for it' },
        { value: 'fulfilled', label: 'Fulfilled — it is in the library' },
        { value: 'rejected', label: 'Rejected — not happening' },
        { value: 'pending', label: 'Back to pending' },
      ],
      onInput: (value) => { status = value; },
    })),
    field('Review note (visible to the requester)', textareaInput({
      value: note, rows: 3, maxlength: 2000, placeholder: 'Optional context, or a dry joke. Mostly context.',
      onInput: (value) => { note = value; },
    }), { help: 'Max 2000 chars. Leave blank for no note.' }),
  );
  formModal({
    title: `Review request — ${title}`,
    body,
    submitLabel: 'Save decision',
    danger: status === 'rejected',
    onSubmit: async () => {
      if (!['pending', 'approved', 'rejected', 'fulfilled'].includes(status)) throw new Error('Pick a valid status.');
      if (note.length > 2000) throw new Error('Review note must be 2000 characters or fewer.');
      await adminPatch(`/api/admin/requests/${row.id}`, { status, reviewNote: note });
      toast('Request updated.', 'success');
      draw();
    },
  });
}

function countsRow(byStatus) {
  const entries = [
    ['pending', byStatus?.pending ?? 0],
    ['approved', byStatus?.approved ?? 0],
    ['fulfilled', byStatus?.fulfilled ?? 0],
    ['rejected', byStatus?.rejected ?? 0],
  ];
  return h('div', { class: 'row wrap', style: { gap: '6px' } },
    ...entries.map(([status, count]) => badge(status, `${status} ${fmtNum(count)}`)),
  );
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(6)));
    const draw = async () => {
      const params = new URLSearchParams({ page: String(uiState.page), pageSize: String(uiState.pageSize) });
      if (uiState.status) params.set('status', uiState.status);
      if (uiState.kind) params.set('kind', uiState.kind);
      if (uiState.q) params.set('q', uiState.q);
      try {
        const res = await adminGet(`/api/admin/requests?${params.toString()}`, { signal: ctx.signal });
        const items = res?.items || [];
        const total = res?.total ?? items.length;
        const byStatus = res?.byStatus || {};
        const search = h('input', { class: 'input grow', type: 'search', placeholder: 'Search requested titles…', value: uiState.q, 'aria-label': 'Search requests' });
        search.addEventListener('input', debounce(() => { uiState.q = search.value; uiState.page = 1; draw(); }, 320));
        const columns = [
          {
            label: 'Request',
            className: 'adm-cell-title',
            render: (row) => h('div', {},
              h('strong', { title: fieldOf(row, 'title', 'title') }, safeText(fieldOf(row, 'title', 'title'))),
              h('span', {}, [fieldOf(row, 'kind', 'kind'), fieldOf(row, 'year', 'year'), `#${row.id}`].filter(Boolean).join(' · ')),
            ),
          },
          { label: 'Requester', render: (row) => h('span', {}, `@${requesterName(row)}`) },
          {
            label: 'Note',
            className: 'wrap adm-muted',
            render: (row) => {
              const note = fieldOf(row, 'note', 'note');
              return note ? h('span', { title: note }, note.length > 120 ? `${note.slice(0, 120)}…` : note) : '—';
            },
          },
          { label: 'Status', render: (row) => badge(fieldOf(row, 'status', 'status')) },
          { label: 'Submitted', render: (row) => h('span', { class: 'num', title: fmtWhen(fieldOf(row, 'createdAt', 'created_at')) }, fmtAgo(fieldOf(row, 'createdAt', 'created_at'))) },
          {
            label: 'Review',
            className: 'wrap',
            render: (row) => h('span', { class: 'adm-muted' },
              fieldOf(row, 'reviewNote', 'review_note') || '—',
              reviewerName(row) ? h('div', { class: 'mono', style: { fontSize: '9px', color: 'var(--faint)', marginTop: '2px' } }, `by @${reviewerName(row)}`) : null,
            ),
          },
          {
            label: 'Actions',
            className: 'nowrap',
            render: (row) => h('div', { class: 'actions' },
              btn('Approve', () => reviewRequest(row, 'approved', draw), { small: true }),
              btn('Fulfil', () => reviewRequest(row, 'fulfilled', draw), { small: true, title: 'Mark as fulfilled (found and imported)' }),
              btn('Reject', () => reviewRequest(row, 'rejected', draw), { kind: 'danger', small: true }),
              btn('Review', () => reviewRequest(row, fieldOf(row, 'status', 'status'), draw), { small: true, title: 'Open review form with a note' }),
              h('a', {
                class: 'btn ghost small', href: `/search?q=${encodeURIComponent(fieldOf(row, 'title', 'title'))}`,
                target: '_blank', rel: 'noopener', title: 'Search the library for this title in the main app',
              }, 'Find'),
            ),
          },
        ];
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Requests', `${fmtNum(total)} matching · review the queue, leave a note, keep it honest`, [
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          countsRow(byStatus),
          toolbar([
            search,
            (() => {
              const status = selectInput({ value: uiState.status, options: STATUS_OPTIONS, onInput: (value) => { uiState.status = value; uiState.page = 1; draw(); } });
              status.setAttribute('aria-label', 'Filter by status');
              return status;
            })(),
            (() => {
              const kind = selectInput({ value: uiState.kind, options: KIND_OPTIONS, onInput: (value) => { uiState.kind = value; uiState.page = 1; draw(); } });
              kind.setAttribute('aria-label', 'Filter by kind');
              return kind;
            })(),
            (() => {
              const size = selectInput({ value: String(uiState.pageSize), options: [10, 25, 50, 100].map((n) => ({ value: String(n), label: `${n} per page` })), onInput: (value) => { uiState.pageSize = Number(value); uiState.page = 1; draw(); } });
              size.setAttribute('aria-label', 'Requests per page');
              return size;
            })(),
          ]),
          dataTable({
            columns,
            rows: items,
            caption: 'Media requests',
            empty: emptyState(
              uiState.status === 'pending' ? 'Pending queue is empty' : 'No requests match',
              uiState.status === 'pending' ? 'Nobody is asking for anything. Either the library is complete or everyone gave up.' : 'Try a different status or clear the search.',
              { emoji: '✉' },
            ),
          }),
          pagination({ page: res?.page ?? uiState.page, pageSize: res?.pageSize ?? uiState.pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          h('div', { class: 'adm-note' }, 'Approving signals intent; fulfilling should follow an import/scan. Nothing on this page moves files — it only updates request state.'),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Requests', 'Review what people want'),
          errorState(error, draw, { title: 'Requests did not load' }),
        ));
      }
    };
    await draw();
  },
};
