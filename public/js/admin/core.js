// Shared admin plumbing: api wrappers, event bus, formatting, DOM/table/form builders.
import { ApiError, copyText, fmtBytes, fmtDate, fmtRelative, get, post, patch, del, qs } from '../api.js';
import { h, toast, modal, confirmDialog } from '../ui.js';

export { h, toast, modal, confirmDialog, fmtBytes, fmtDate, fmtRelative, qs, ApiError };
export const state = {
  user: null,
  branding: { serverName: 'AISlopMediaBox', version: '1.0.0' },
  health: null,
  section: 'dashboard',
  events: null,
  dirtyGuard: null,
  dirty: false,
  setTitle: null,
};

const subscribers = new Map();
export function onAdminEvent(name, handler) {
  const set = subscribers.get(name) || new Set();
  set.add(handler);
  subscribers.set(name, set);
  return () => set.delete(handler);
}
export function emitAdminEvent(name, data) {
  for (const handler of subscribers.get(name) || []) {
    try { handler(data); } catch (error) { console.error(`admin event handler failed (${name})`, error); }
  }
}

export function redirectToLogin() {
  const next = encodeURIComponent('/admin' + (location.hash || ''));
  location.replace(`/login?next=${next}`);
}

export async function adminGet(path, options = {}) {
  try {
    return await get(path, options);
  } catch (error) {
    if (error.status === 401) redirectToLogin();
    throw error;
  }
}
export async function adminPost(path, body, options = {}) {
  try {
    return await post(path, body, options);
  } catch (error) {
    if (error.status === 401) redirectToLogin();
    throw error;
  }
}
export async function adminPatch(path, body, options = {}) {
  try {
    return await patch(path, body, options);
  } catch (error) {
    if (error.status === 401) redirectToLogin();
    throw error;
  }
}
export async function adminDel(path, options = {}) {
  try {
    return await del(path, options);
  } catch (error) {
    if (error.status === 401) redirectToLogin();
    throw error;
  }
}

/** Raw authenticated request for downloads/uploads we can't express with JSON helpers. */
export async function adminRaw(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.headers || {}) } });
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'unauthorized', 'Session expired. Redirecting to login.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    let code = 'error';
    let details;
    try {
      const payload = await res.clone().json();
      message = payload?.error?.message || message;
      code = payload?.error?.code || code;
      details = payload?.error?.details;
    } catch { /* non-json response */ }
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

export function apiError(error) {
  if (error instanceof ApiError) return error.message || 'Request failed.';
  return error?.message || String(error || 'Unknown error.');
}

export function showBanner(message, tone = 'warn', { dismissible = true } = {}) {
  const host = document.getElementById('adm-alert');
  if (!host) return;
  host.replaceChildren(
    h('span', {}, message),
    dismissible ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => { host.hidden = true; } }, 'Dismiss') : null,
  );
  host.dataset.tone = tone;
  host.hidden = false;
}
export function hideBanner() {
  const host = document.getElementById('adm-alert');
  if (host) host.hidden = true;
}

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
export function fmtNum(value) {
  return new Intl.NumberFormat().format(num(value));
}
export function fmtBytesSafe(value) {
  return Number.isFinite(Number(value)) ? fmtBytes(Number(value)) : '—';
}
export function fmtPct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}
export function shortId(id) {
  const value = String(id || '');
  return value.length > 10 ? value.slice(0, 8) : value || '—';
}
export function fmtUptime(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}
export function fmtWhen(iso) {
  return iso ? fmtDate(iso, true) : '—';
}
export function fmtAgo(iso) {
  return iso ? fmtRelative(iso) : '—';
}
export function relTime(iso) {
  const text = fmtRelative(iso);
  return text || '—';
}
export function jsDate(iso) {
  const date = new Date(iso || '');
  return Number.isNaN(date.getTime()) ? null : date;
}
export function debounce(fn, wait = 260) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
export function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}
export function jsonPretty(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function statusTone(status) {
  const map = {
    done: 'good', resolved: 'good', approved: 'good', fulfilled: 'good', ok: 'good', healthy: 'good',
    running: 'accent', queued: 'warn', pending: 'warn', open: 'warn',
    warn: 'warn', warning: 'warn', paused: 'warn',
    error: 'bad', failed: 'bad', rejected: 'bad', dismissed: 'bad', disabled: 'bad',
    cancelled: 'neutral',
  };
  return map[String(status || '').toLowerCase()] || 'neutral';
}
export function badge(status, label) {
  return h('span', { class: `pill ${statusTone(status)}` }, label || safeText(status, 'unknown'));
}
export function levelBadge(level) {
  const l = String(level || 'info').toLowerCase();
  const cls = l === 'error' ? 'bad' : l === 'warn' ? 'warn' : l === 'debug' ? 'neutral' : 'neutral';
  return h('span', { class: `pill ${cls}` }, l);
}

// ---- DOM builders ----
export function btn(label, onClick, { kind = '', small = true, title, type = 'button', disabled = false, iconText } = {}) {
  return h('button', {
    type,
    class: `btn ${kind}`.trim(),
    title: title || undefined,
    disabled,
    onclick: onClick,
  }, iconText ? h('span', { 'aria-hidden': 'true' }, iconText) : null, label);
}

export function pageHead(title, sub, actions = []) {
  return h('header', { class: 'adm-page-head' },
    h('div', {},
      h('h1', {}, title),
      sub ? h('p', { class: 'sub' }, sub) : null,
    ),
    actions.length ? h('div', { class: 'adm-head-actions' }, ...actions) : null,
  );
}

export function card(title, children, { sub, actions = [], className = '', pad = false } = {}) {
  return h('section', { class: `adm-card${pad ? ' pad-lg' : ''}${className ? ` ${className}` : ''}`.trim() },
    title ? h('div', { class: 'adm-card-head' },
      h('h2', {}, title),
      sub ? h('span', { class: 'adm-card-sub' }, sub) : null,
      h('span', { class: 'spacer' }),
      ...actions,
    ) : null,
    ...children,
  );
}

export function emptyState(title, message, { emoji = '🫥', actions = [] } = {}) {
  return h('div', { class: 'adm-empty' },
    h('div', { class: 'emoji', 'aria-hidden': 'true' }, emoji),
    h('h3', {}, title),
    message ? h('p', {}, message) : null,
    actions.length ? h('div', { class: 'row wrap', style: { justifyContent: 'center', marginTop: '6px' } }, ...actions) : null,
  );
}

export function errorState(error, retry, { title = 'That did not load' } = {}) {
  const status = error?.status ? `HTTP ${error.status} · ` : '';
  return h('div', { class: 'adm-empty' },
    h('div', { class: 'emoji', 'aria-hidden': 'true' }, error?.status === 403 ? '🚫' : '💀'),
    h('h3', {}, error?.status === 403 ? 'Access denied' : title),
    h('p', { class: 'mono small' }, `${status}${apiError(error)}`),
    retry ? btn('Try again', retry, { kind: 'primary', small: false }) : null,
  );
}

export function skeletonGrid(cards = 4) {
  return h('div', { class: 'adm-skel-grid', 'aria-hidden': 'true', 'aria-busy': 'true' },
    ...Array.from({ length: cards }, () => h('div', { class: 'adm-skeleton', style: { height: '88px' } })),
  );
}
export function skeletonRows(rows = 6) {
  return h('div', { class: 'adm-skel-stack', 'aria-hidden': 'true', 'aria-busy': 'true' },
    ...Array.from({ length: rows }, () => h('div', { class: 'adm-skeleton', style: { height: '30px' } })),
  );
}

export function kv(pairs) {
  return h('dl', { class: 'adm-kv' },
    ...pairs.filter(Boolean).flatMap(([key, value]) => [
      h('dt', {}, key),
      h('dd', {}, value instanceof Node ? value : safeText(value)),
    ]),
  );
}

export function listRow(main, side) {
  return h('div', { class: 'adm-list-row' },
    h('div', { class: 'adm-list-main' }, main),
    side ? h('div', { class: 'adm-list-side' }, side) : null,
  );
}

let fieldSeq = 0;
export function fieldId(prefix = 'adm-f') {
  fieldSeq += 1;
  return `${prefix}-${fieldSeq}`;
}

export function field(label, control, { help, span = false, id } = {}) {
  const controlId = id || control.id || fieldId();
  if (!control.id) control.id = controlId;
  const labelNode = label ? h('label', { for: controlId }, label) : null;
  return h('div', { class: `adm-field${span ? ' span-2' : ''}` },
    labelNode,
    control,
    help ? h('div', { class: 'help' }, help) : null,
  );
}

export function textInput({ value = '', placeholder = '', type = 'text', name, autocomplete = 'off', min, max, step, minlength, maxlength, required = false, disabled = false, onInput, onChange } = {}) {
  const input = h('input', {
    class: 'input', type, value: value ?? '', placeholder: placeholder || undefined,
    name: name || undefined, autocomplete, min, max, step, minlength, maxlength, required, disabled,
  });
  if (onInput) input.addEventListener('input', () => onInput(input.value, input));
  if (onChange) input.addEventListener('change', () => onChange(input.value, input));
  return input;
}

export function textField({ label, value = '', placeholder, type = 'text', help, span, required, disabled, min, max, step, minlength, maxlength, autocomplete, onInput, onChange, id }) {
  const input = textInput({ value, placeholder, type, required, disabled, min, max, step, minlength, maxlength, autocomplete, onInput, onChange });
  return field(label, input, { help, span, id });
}

export function textareaInput({ value = '', placeholder, rows = 4, maxlength, onInput } = {}) {
  const area = h('textarea', { class: 'textarea', rows, placeholder: placeholder || undefined, maxlength });
  area.value = value ?? '';
  if (onInput) area.addEventListener('input', () => onInput(area.value, area));
  return area;
}

export function selectInput({ value, options = [], onInput, disabled = false, id, name } = {}) {
  const select = h('select', { class: 'select', disabled, id, name });
  for (const option of options) {
    const opt = typeof option === 'string' ? { value: option, label: option } : option;
    select.append(h('option', { value: String(opt.value), selected: String(opt.value) === String(value) ? true : undefined }, opt.label ?? String(opt.value)));
  }
  if (onInput) select.addEventListener('change', () => onInput(select.value, select));
  return select;
}

export function selectField({ label, value, options, help, span, onInput, disabled, id }) {
  const select = selectInput({ value, options, onInput, disabled, id });
  return field(label, select, { help, span, id });
}

export function formGrid(...children) {
  return h('div', { class: 'adm-form-grid' }, ...children);
}

export function toolbar(children) {
  return h('div', { class: 'adm-toolbar' }, ...children.filter(Boolean));
}

export function dataTable({ columns, rows, caption, empty, rowClass }) {
  const table = h('table', { class: 'adm-table' });
  if (caption) table.append(h('caption', {}, caption));
  const thead = h('thead', {}, h('tr', {}, ...columns.map((col) => h('th', { scope: 'col', class: col.className || undefined }, col.label || ''))));
  table.append(thead);
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h('tr', { class: rowClass?.(row) || undefined });
    for (const col of columns) {
      const cell = h('td', { class: col.className || undefined });
      const value = col.render ? col.render(row) : row[col.key];
      if (value instanceof Node) cell.append(value);
      else if (Array.isArray(value)) cell.append(...value.map((v) => (v instanceof Node ? v : document.createTextNode(safeText(v, '')))));
      else cell.append(document.createTextNode(safeText(value, '—')));
      tr.append(cell);
    }
    tbody.append(tr);
  }
  if (!rows.length && empty) {
    tbody.append(h('tr', {}, h('td', { colspan: columns.length }, empty)));
  }
  table.append(tbody);
  return h('div', { class: 'adm-table-wrap' }, table);
}

export function pagination({ page = 1, pageSize = 25, total = 0, onPage }) {
  const pages = Math.max(1, Math.ceil(num(total) / Math.max(1, num(pageSize))));
  const current = Math.min(Math.max(1, num(page)), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);
  return h('nav', { class: 'adm-pagination', 'aria-label': 'Pagination' },
    h('span', { class: 'page-info' }, `${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(total)}`),
    h('button', { class: 'btn ghost small', type: 'button', disabled: current <= 1, onclick: () => onPage(current - 1) }, '‹ Prev'),
    h('span', { class: 'page-info' }, `page ${current} / ${pages}`),
    h('button', { class: 'btn ghost small', type: 'button', disabled: current >= pages, onclick: () => onPage(current + 1) }, 'Next ›'),
  );
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { href: url, download: filename || 'download' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadPath(path, filename) {
  const res = await adminRaw(path);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const suggested = match ? decodeURIComponent(match[1].replace(/"/g, '')) : '';
  downloadBlob(blob, filename || suggested || 'download');
}

export async function copyToClipboard(text, label = 'Copied.') {
  const ok = await copyText(text);
  toast(ok ? label : 'Copy failed — your browser is being weird.', ok ? 'success' : 'error');
  return ok;
}

export async function withBusy(button, task, busyLabel = 'Working…') {
  if (!button) return task();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

/** Form-friendly modal with inline validation errors and Enter-to-submit. */
export function formModal({ title, body, submitLabel = 'Save', onSubmit, wide = false, danger = false, onClose, extraActions = [] }) {
  const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { novalidate: true });
  form.append(body, errorBox, h('button', { type: 'submit', hidden: true }, 'submit'));
  let handle = null;
  let submitting = false;
  let closed = false;
  const close = () => { if (!closed) handle?.close(); };
  const run = async () => {
    if (submitting) return false;
    errorBox.hidden = true;
    submitting = true;
    try {
      const result = await onSubmit?.({ close });
      if (result === false) return false;
      closed = true;
      handle?.close();
      return true;
    } catch (error) {
      errorBox.textContent = apiError(error);
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return false;
    } finally {
      submitting = false;
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });
  handle = modal({
    title,
    body: form,
    wide,
    onClose,
    actions: [
      { label: 'Cancel' },
      ...extraActions.map((action) => ({ ...action, onClick: async () => action.onClick?.({ close }) })),
      { label: submitLabel, kind: danger ? 'danger' : 'primary', onClick: run },
    ],
  });
  setTimeout(() => form.querySelector('input:not([type="hidden"]), select, textarea')?.focus(), 30);
  return handle;
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

