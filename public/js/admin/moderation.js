// Moderation: report queue with resolve/dismiss + notes.
import {
  h, adminGet, adminPatch, pageHead, btn, badge, emptyState, errorState, skeletonRows,
  formModal, field, selectInput, textareaInput, toast, pagination, dataTable, toolbar,
  fmtNum, fmtAgo, fmtWhen, safeText, apiError,
} from './core.js';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: '', label: 'All statuses' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];
const uiState = { status: 'open', page: 1, pageSize: 25 };

function reportMedia(row) {
  const media = row.media || {};
  const title = media.title || row.mediaTitle || (row.mediaId ? `media #${row.mediaId}` : 'deleted item');
  return { id: media.id ?? row.mediaId, title, kind: media.kind };
}

function reporterName(row) {
  return row.reporter?.displayName || row.reporter?.username || (row.user ? row.user.username : null) || 'unknown';
}

function reviewReport(row, preset, draw) {
  let status = preset || row.status || 'resolved';
  let notes = row.notes || '';
  const media = reportMedia(row);
  const body = h('div', {},
    h('div', { class: 'adm-note' },
      h('strong', {}, media.title),
      media.kind ? ` · ${media.kind}` : '',
      h('div', { style: { marginTop: '6px' } }, `Reported reason: “${safeText(row.reason)}”`),
      h('div', { class: 'faint small', style: { marginTop: '4px' } }, `by @${reporterName(row)} · ${fmtWhen(row.createdAt)}`),
    ),
    field('Resolution', selectInput({
      value: status,
      options: [
        { value: 'resolved', label: 'Resolved — action taken' },
        { value: 'dismissed', label: 'Dismissed — no action' },
        { value: 'open', label: 'Reopen — needs another look' },
      ],
      onInput: (value) => { status = value; },
    })),
    field('Moderator notes', textareaInput({
      value: notes, rows: 3, maxlength: 2000,
      onInput: (value) => { notes = value; },
      placeholder: 'What happened, and why. Notes stay local.',
    }), { help: 'Max 2000 chars.' }),
  );
  formModal({
    title: 'Review report',
    body,
    submitLabel: 'Save resolution',
    danger: status === 'dismissed',
    onSubmit: async () => {
      if (notes.length > 2000) throw new Error('Notes must be 2000 characters or fewer.');
      await adminPatch(`/api/admin/reports/${row.id}`, { status, notes });
      toast('Report updated.', 'success');
      draw();
    },
  });
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(6)));
    const draw = async () => {
      const params = new URLSearchParams({ page: String(uiState.page), pageSize: String(uiState.pageSize) });
      if (uiState.status) params.set('status', uiState.status);
      try {
        const res = await adminGet(`/api/admin/reports?${params.toString()}`, { signal: ctx.signal });
        const items = res?.items || [];
        const total = res?.total ?? items.length;
        const byStatus = res?.byStatus || {};
        const columns = [
          {
            label: 'Item',
            className: 'adm-cell-title',
            render: (row) => {
              const media = reportMedia(row);
              return h('div', {},
                media.id
                  ? h('a', { class: 'adm-title-link', href: `/item/${media.id}`, target: '_blank', rel: 'noopener', title: media.title }, media.title)
                  : h('strong', {}, media.title),
                h('span', {}, [media.kind, `report #${row.id}`].filter(Boolean).join(' · ')),
              );
            },
          },
          {
            label: 'Reason',
            className: 'wrap',
            render: (row) => h('span', { title: row.reason }, row.reason || '—'),
          },
          { label: 'Reporter', render: (row) => h('span', {}, `@${reporterName(row)}`) },
          { label: 'Reported', render: (row) => h('span', { class: 'num', title: fmtWhen(row.createdAt) }, fmtAgo(row.createdAt)) },
          { label: 'Status', render: (row) => badge(row.status) },
          {
            label: 'Notes',
            className: 'wrap',
            render: (row) => h('span', { class: 'adm-muted' },
              row.notes || '—',
              row.resolvedBy ? h('div', { class: 'mono', style: { fontSize: '9px', color: 'var(--faint)', marginTop: '2px' } }, `by @${row.resolvedBy.username || row.resolvedBy.displayName || 'admin'} · ${fmtAgo(row.resolvedAt)}`) : null,
            ),
          },
          {
            label: 'Actions',
            className: 'nowrap',
            render: (row) => h('div', { class: 'actions' },
              row.status === 'open' ? btn('Resolve', () => reviewReport(row, 'resolved', draw), { small: true }) : null,
              row.status === 'open' ? btn('Dismiss', () => reviewReport(row, 'dismissed', draw), { kind: 'danger', small: true }) : null,
              btn(row.status === 'open' ? 'Add note' : 'Edit', () => reviewReport(row, row.status, draw), { small: true }),
              row.mediaId ? h('a', { class: 'btn ghost small', href: `/item/${row.mediaId}`, target: '_blank', rel: 'noopener' }, 'Open') : null,
            ),
          },
        ];
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Moderation', `${fmtNum(total)} reports matching · ${fmtNum(byStatus.open ?? 0)} open · ${fmtNum(byStatus.resolved ?? 0)} resolved · ${fmtNum(byStatus.dismissed ?? 0)} dismissed`, [
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          toolbar([
            (() => {
              const status = selectInput({ value: uiState.status, options: STATUS_OPTIONS, onInput: (value) => { uiState.status = value; uiState.page = 1; draw(); } });
              status.setAttribute('aria-label', 'Filter reports by status');
              return status;
            })(),
            (() => {
              const size = selectInput({ value: String(uiState.pageSize), options: [10, 25, 50, 100].map((n) => ({ value: String(n), label: `${n} per page` })), onInput: (value) => { uiState.pageSize = Number(value); uiState.page = 1; draw(); } });
              size.setAttribute('aria-label', 'Reports per page');
              return size;
            })(),
            h('span', { class: 'spacer' }),
            h('span', { class: 'faint small' }, 'Reports are created by users via the API; this queue only reviews them.'),
          ]),
          dataTable({
            columns,
            rows: items,
            caption: 'Reports',
            empty: emptyState(
              uiState.status === 'open' ? 'Queue is clear' : 'No reports match',
              uiState.status === 'open' ? 'No open reports. Either the community is behaving, or they have given up on the report button.' : 'Try a different status filter.',
              { emoji: '⚑' },
            ),
          }),
          pagination({ page: res?.page ?? uiState.page, pageSize: res?.pageSize ?? uiState.pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          h('div', { class: 'adm-note' }, 'Resolving does not delete the reported media. If it needs to disappear, use Media → Hide. Report notes stay local.'),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Moderation', 'Review reports'),
          errorState(error, draw, { title: 'Reports did not load' }),
        ));
      }
    };
    await draw();
  },
};
