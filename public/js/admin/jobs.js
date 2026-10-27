// Jobs: active queue, live job.update progress, history, cancel, clear, details.
import {
  h, adminGet, adminPost, adminDel, pageHead, card, btn, badge, emptyState, errorState, skeletonRows,
  confirmDialog, toast, pagination, dataTable, toolbar, modal, fmtNum, fmtAgo, fmtWhen, fmtUptime,
  safeText, apiError, onAdminEvent, jsDate, jsonPretty,
} from './core.js';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'error', label: 'Error' },
  { value: 'cancelled', label: 'Cancelled' },
];
const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'scan', label: 'scan' },
  { value: 'match', label: 'match' },
  { value: 'art', label: 'art' },
  { value: 'probe', label: 'probe' },
  { value: 'cleanup', label: 'cleanup' },
];
const uiState = { status: '', type: '', page: 1, pageSize: 25 };

function jobDuration(job) {
  const start = jsDate(job.startedAt || job.createdAt);
  if (!start) return '—';
  const end = jsDate(job.finishedAt) || new Date();
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return fmtUptime(seconds);
}

function payloadSummary(job) {
  const payload = job.payload || {};
  const bits = [];
  if (payload.libraryId !== undefined) bits.push(`library ${payload.libraryId}`);
  if (payload.mediaId !== undefined) bits.push(`media ${payload.mediaId}`);
  if (payload.libraryName) bits.push(payload.libraryName);
  if (payload.scope) bits.push(payload.scope);
  if (payload.force) bits.push('force');
  return bits.join(' · ') || '—';
}

function liveProgress(job) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(job.progress) || 0)) * 100);
  return h('div', { class: 'adm-progress', title: job.message || `${pct}%` },
    h('div', { class: 'adm-meter' }, h('i', { class: 'job-progress-fill', style: { width: `${pct}%` } })),
    h('span', { class: 'num job-progress-pct' }, `${pct}%`),
  );
}

function statusNode(job) {
  return h('span', { class: 'job-status', 'data-status': job.status }, badge(job.status));
}

function activeNode(job) {
  return h('span', { class: 'job-status', 'data-status': job.status }, badge(job.status));
}

function details(job) {
  const payload = payloadSummary(job);
  const body = h('div', {},
    h('dl', { class: 'adm-kv', style: { marginBottom: '14px' } },
      h('dt', {}, 'id'), h('dd', {}, job.id),
      h('dt', {}, 'type'), h('dd', {}, safeText(job.type)),
      h('dt', {}, 'status'), h('dd', {}, badge(job.status)),
      h('dt', {}, 'progress'), h('dd', {}, `${Math.round(Number(job.progress || 0) * 100)}%`),
      h('dt', {}, 'message'), h('dd', {}, safeText(job.message)),
      h('dt', {}, 'created'), h('dd', {}, fmtWhen(job.createdAt)),
      h('dt', {}, 'started'), h('dd', {}, fmtWhen(job.startedAt)),
      h('dt', {}, 'finished'), h('dd', {}, fmtWhen(job.finishedAt)),
      h('dt', {}, 'duration'), h('dd', {}, jobDuration(job)),
      h('dt', {}, 'created by'), h('dd', {}, safeText(job.createdBy)),
      h('dt', {}, 'payload hint'), h('dd', {}, payload),
      h('dt', {}, 'error'), h('dd', { style: { color: job.error ? 'var(--error)' : undefined } }, safeText(job.error, '—')),
    ),
    h('div', { class: 'eyebrow', style: { marginBottom: '4px' } }, 'payload'),
    h('pre', { class: 'adm-code' }, jsonPretty(job.payload)),
    job.result !== null && job.result !== undefined
      ? h('div', {}, h('div', { class: 'eyebrow', style: { margin: '10px 0 4px' } }, 'result'), h('pre', { class: 'adm-code' }, jsonPretty(job.result)))
      : null,
  );
  modal({ title: `Job ${String(job.id).slice(0, 8)}`, body, wide: true, actions: [{ label: 'Close' }] });
}

async function cancelJob(job, draw) {
  const ok = await confirmDialog(
    `Cancel ${job.type} job?`,
    'Queued/running work stops as soon as the handler checks the cancel flag. Partial results may already be written to the database; a rescan is safe and idempotent.',
    { confirmLabel: 'Cancel job', danger: true },
  );
  if (!ok) return;
  try {
    await adminPost(`/api/jobs/${job.id}/cancel`, {});
    toast('Job cancelled.', 'success');
    draw();
  } catch (error) {
    toast(apiError(error), 'error');
  }
}

function jobColumns(draw, { active = false } = {}) {
  return [
    { label: 'Job', render: (job) => h('div', {},
      h('strong', { class: 'mono', style: { fontSize: '11px' }, title: job.id }, `${String(job.type)} · ${String(job.id).slice(0, 8)}`),
      h('span', { style: { color: 'var(--faint)', fontSize: '10px' } }, payloadSummary(job)),
    ) },
    { label: 'Status', render: (job) => (active ? activeNode(job) : statusNode(job)) },
    { label: 'Progress', render: (job) => liveProgress(job) },
    { label: 'Message', className: 'wrap', render: (job) => h('span', { class: 'job-message', title: job.message }, safeText(job.message, '—')) },
    { label: active ? 'Started' : 'Created', render: (job) => h('span', { class: 'num', title: fmtWhen(active ? job.startedAt : job.createdAt) }, fmtAgo(active ? job.startedAt : job.createdAt)) },
    { label: active ? 'Elapsed' : 'Duration', render: (job) => h('span', { class: 'num' }, jobDuration(job)) },
    {
      label: 'Actions',
      className: 'nowrap',
      render: (job) => h('div', { class: 'actions' },
        ['queued', 'running'].includes(job.status) ? btn('Cancel', () => cancelJob(job, draw), { kind: 'danger', small: true }) : null,
        btn('Details', () => details(job), { small: true, iconText: 'ⓘ' }),
      ),
    },
  ];
}

function paintJobEvent(job) {
  if (!job?.id) return false;
  const nodes = document.querySelectorAll(`[data-job-id="${CSS.escape(String(job.id))}"]`);
  if (!nodes.length) return false;
  let statusChanged = false;
  const pct = Math.round(Math.max(0, Math.min(1, Number(job.progress) || 0)) * 100);
  nodes.forEach((node) => {
    const fill = node.querySelector('.job-progress-fill');
    const pctNode = node.querySelector('.job-progress-pct');
    const message = node.querySelector('.job-message');
    const status = node.querySelector('.job-status');
    if (fill) fill.style.width = `${pct}%`;
    if (pctNode) pctNode.textContent = `${pct}%`;
    if (message) message.textContent = job.message || '—';
    if (status && status.dataset.status !== job.status) statusChanged = true;
  });
  return !statusChanged;
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(6)));
    let timer = null;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (host.isConnected) draw(); }, 450);
    };
    const off = onAdminEvent('job.update', (job) => {
      const painted = paintJobEvent(job);
      if (!painted) scheduleRefresh();
      if (['done', 'error', 'cancelled'].includes(job?.status)) scheduleRefresh();
    });

    const draw = async () => {
      const params = new URLSearchParams({ page: String(uiState.page), pageSize: String(uiState.pageSize) });
      if (uiState.status) params.set('status', uiState.status);
      if (uiState.type) params.set('type', uiState.type);
      try {
        const [historyRes, activeRes] = await Promise.all([
          adminGet(`/api/jobs?${params.toString()}`, { signal: ctx.signal }),
          adminGet('/api/jobs/active', { signal: ctx.signal }),
        ]);
        const items = historyRes?.items || [];
        const active = activeRes?.items || [];
        const counts = historyRes?.counts || {};
        const total = historyRes?.total ?? items.length;
        const activeRows = dataTable({
          columns: jobColumns(draw, { active: true }),
          rows: active,
          caption: 'Active queue',
          empty: emptyState('Queue is empty', 'No queued or running jobs. The slot machine is idle.', { emoji: '⚡' }),
        });
        const historyRows = dataTable({
          columns: jobColumns(draw),
          rows: items,
          caption: 'Job history (newest first)',
          empty: emptyState('No jobs match', 'Clear the filters or run a scan. The queue has no memories to show.', { emoji: '⚡' }),
        });
        const mark = (table, rows) => {
          table.querySelectorAll('tbody tr').forEach((row, index) => {
            if (rows[index]?.id) row.dataset.jobId = String(rows[index].id);
          });
        };
        mark(activeRows, active);
        mark(historyRows, items);

        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Jobs', `${fmtNum(active.length)} active · ${fmtNum(counts.queued ?? 0)} queued · ${fmtNum(counts.running ?? 0)} running · ${fmtNum(counts.done ?? 0)} done · ${fmtNum(counts.error ?? 0)} error`, [
            btn('Clear history', async () => {
              const ok = await confirmDialog('Clear finished job history?', 'Deletes done/error/cancelled job rows older than 3 days. Active jobs are untouched. The DB wants closure.', { confirmLabel: 'Clear old jobs', danger: true });
              if (!ok) return;
              try {
                const result = await adminDel('/api/jobs/history?olderThanDays=3');
                toast(`Cleared ${fmtNum(result?.deleted ?? 0)} old job row(s).`, 'success');
                draw();
              } catch (error) { toast(apiError(error), 'error'); }
            }, { kind: 'danger' }),
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          card('Active', [activeRows], { sub: `${active.length} in flight` }),
          toolbar([
            (() => {
              const status = h('select', { class: 'select' });
              for (const option of STATUS_OPTIONS) status.append(h('option', { value: option.value, selected: uiState.status === option.value ? true : undefined }, option.label));
              status.setAttribute('aria-label', 'Filter jobs by status');
              status.addEventListener('change', () => { uiState.status = status.value; uiState.page = 1; draw(); });
              return status;
            })(),
            (() => {
              const type = h('select', { class: 'select' });
              for (const option of TYPE_OPTIONS) type.append(h('option', { value: option.value, selected: uiState.type === option.value ? true : undefined }, option.label));
              type.setAttribute('aria-label', 'Filter jobs by type');
              type.addEventListener('change', () => { uiState.type = type.value; uiState.page = 1; draw(); });
              return type;
            })(),
            (() => {
              const size = h('select', { class: 'select' });
              for (const n of [10, 25, 50, 100]) size.append(h('option', { value: String(n), selected: uiState.pageSize === n ? true : undefined }, `${n} per page`));
              size.setAttribute('aria-label', 'Jobs per page');
              size.addEventListener('change', () => { uiState.pageSize = Number(size.value); uiState.page = 1; draw(); });
              return size;
            })(),
            h('span', { class: 'spacer' }),
            badge('running', `live SSE · ${fmtNum(counts.running ?? 0)} running`),
          ]),
          historyRows,
          pagination({ page: historyRes?.page ?? uiState.page, pageSize: historyRes?.pageSize ?? uiState.pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          h('div', { class: 'adm-note' }, 'One job per type runs at a time; the queue persists in SQLite across restarts. Jobs marked running at boot are reported as errors, not silently resumed.'),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Jobs', 'Queue and history'),
          errorState(error, draw, { title: 'Jobs did not load' }),
        ));
      }
    };
    await draw();
    return () => { off(); clearTimeout(timer); };
  },
};
