// Logs: level/scope/search filters, pagination, JSONL export, clear with confirmation.
import {
  h, adminGet, adminRaw, pageHead, btn, badge, emptyState, errorState, skeletonRows, levelBadge,
  confirmDialog, toast, pagination, dataTable, toolbar, modal, downloadPath, fmtNum, fmtAgo, fmtWhen,
  safeText, apiError, debounce, jsonPretty,
} from './core.js';

const LEVEL_OPTIONS = [
  { value: '', label: 'All levels' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];
const uiState = { level: '', scope: '', q: '', page: 1, pageSize: 50 };
let knownScopes = [];

function queryParams(extra = {}) {
  const params = new URLSearchParams();
  for (const key of ['level', 'scope', 'q']) if (uiState[key]) params.set(key, uiState[key]);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params;
}

function metaCell(entry) {
  if (entry.meta === null || entry.meta === undefined) return h('span', { class: 'adm-muted' }, '—');
  const size = typeof entry.meta === 'object' ? Object.keys(entry.meta).length : 1;
  return btn(`meta (${size})`, () => {
    modal({
      title: `Log metadata #${entry.id}`,
      body: h('div', {},
        h('div', { class: 'adm-note' }, 'Metadata is whatever the logger attached. It never includes passwords, cookies or tokens by policy.'),
        h('pre', { class: 'adm-code' }, jsonPretty(entry.meta)),
      ),
      wide: true,
      actions: [{ label: 'Close' }],
    });
  }, { small: true, iconText: 'ⓘ' });
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(8)));
    const draw = async () => {
      const params = queryParams({ page: uiState.page, pageSize: uiState.pageSize });
      try {
        const res = await adminGet(`/api/admin/logs?${params.toString()}`, { signal: ctx.signal });
        const items = res?.items || [];
        const total = res?.total ?? items.length;
        const byLevel = res?.byLevel || {};
        const scopes = Array.isArray(res?.scopes) ? res.scopes : [];
        knownScopes = scopes.length ? scopes : knownScopes;
        const search = h('input', {
          class: 'input grow', type: 'search', value: uiState.q,
          placeholder: 'Search log messages…', 'aria-label': 'Search log messages',
        });
        search.addEventListener('input', debounce(() => { uiState.q = search.value; uiState.page = 1; draw(); }, 320));
        const columns = [
          { label: 'When', className: 'nowrap', render: (entry) => h('span', { class: 'num', title: fmtWhen(entry.createdAt) }, fmtAgo(entry.createdAt)) },
          { label: 'Level', render: (entry) => levelBadge(entry.level) },
          { label: 'Scope', render: (entry) => h('span', { class: 'mono', style: { fontSize: '10px' } }, safeText(entry.scope)) },
          { label: 'Message', className: 'wrap', render: (entry) => h('span', { title: entry.message }, safeText(entry.message)) },
          { label: 'Meta', render: (entry) => metaCell(entry) },
        ];
        const exportButton = btn('Export JSONL', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const exportParams = queryParams({ limit: 10000 });
            await downloadPath(`/api/admin/logs/export?${exportParams.toString()}`, `aislop-logs-${new Date().toISOString().slice(0, 10)}.jsonl`);
            toast('Logs exported as JSONL.', 'success');
          } catch (error) {
            toast(apiError(error), 'error');
          } finally {
            button.disabled = false;
          }
        }, { iconText: '⇩', title: 'Download matching log lines as newline-delimited JSON' });
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Logs', `${fmtNum(total)} matching · echoed in SQLite under the data dir · debug ${fmtNum(byLevel.debug)} / info ${fmtNum(byLevel.info)} / warn ${fmtNum(byLevel.warn)} / error ${fmtNum(byLevel.error)}`, [
            exportButton,
            btn('Clear logs', async () => {
              const ok = await confirmDialog(
                'Clear all logs?',
                'Deletes every row in the logs table. The server keeps logging new events immediately, so this is not “disable logging” — it is a one-time purge. There is no undo.',
                { confirmLabel: 'Delete all logs', danger: true },
              );
              if (!ok) return;
              try {
                const res = await adminRaw('/api/admin/logs', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ all: true }),
                });
                const result = await res.json().catch(() => ({}));
                toast(`Cleared ${fmtNum(result?.deleted ?? 0)} log row(s).`, 'success');
                uiState.page = 1;
                draw();
              } catch (error) {
                toast(apiError(error), 'error');
              }
            }, { kind: 'danger' }),
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          toolbar([
            search,
            (() => {
              const level = h('select', { class: 'select' });
              for (const option of LEVEL_OPTIONS) level.append(h('option', { value: option.value, selected: uiState.level === option.value ? true : undefined }, option.label));
              level.setAttribute('aria-label', 'Filter by log level');
              level.addEventListener('change', () => { uiState.level = level.value; uiState.page = 1; draw(); });
              return level;
            })(),
            (() => {
              const scope = h('select', { class: 'select' });
              scope.append(h('option', { value: '', selected: uiState.scope === '' ? true : undefined }, 'All scopes'));
              for (const name of knownScopes) scope.append(h('option', { value: name, selected: uiState.scope === name ? true : undefined }, name));
              scope.setAttribute('aria-label', 'Filter by log scope');
              scope.addEventListener('change', () => { uiState.scope = scope.value; uiState.page = 1; draw(); });
              return scope;
            })(),
            (() => {
              const size = h('select', { class: 'select' });
              for (const n of [25, 50, 100, 200]) size.append(h('option', { value: String(n), selected: uiState.pageSize === n ? true : undefined }, `${n} per page`));
              size.setAttribute('aria-label', 'Log lines per page');
              size.addEventListener('change', () => { uiState.pageSize = Number(size.value); uiState.page = 1; draw(); });
              return size;
            })(),
            h('span', { class: 'spacer' }),
            badge('error', `${fmtNum(byLevel.error ?? 0)} errors`),
          ]),
          dataTable({
            columns,
            rows: items,
            caption: 'Log lines (newest first)',
            empty: emptyState('No log lines match', 'Adjust the filters or do something worth logging. The logger is watching.', { emoji: '▦' }),
          }),
          pagination({ page: res?.page ?? uiState.page, pageSize: res?.pageSize ?? uiState.pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          h('div', { class: 'adm-note' }, 'Logs live in SQLite (no external sink, no telemetry). Export is a local JSONL download; debug lines may be filtered by LOG_LEVEL before they ever reach the DB.'),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Logs', 'Server log lines'),
          errorState(error, draw, { title: 'Logs did not load' }),
        ));
      }
    };
    await draw();
  },
};
