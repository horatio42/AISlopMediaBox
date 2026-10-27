// Privacy: outbound-network audit, data location, instance metadata export/import, cache wipe.
import {
  h, adminGet, adminPost, pageHead, card, btn, badge, emptyState, errorState, skeletonRows,
  confirmDialog, toast, modal, downloadPath, readFileText, fmtBytesSafe, fmtNum, safeText, apiError,
  jsonPretty,
} from './core.js';

function auditItem(label, value, detail) {
  return h('div', { class: 'adm-audit-item' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value instanceof Node ? value : safeText(value)),
    detail ? h('div', { class: 'detail' }, detail) : null,
  );
}

function setOf(value) {
  return value === false ? badge('ok', 'off') : value === true ? badge('warn', 'on') : badge('neutral', safeText(value));
}

function outboundTable(endpoints) {
  if (!endpoints?.length) {
    return emptyState('No outbound endpoints', 'The server makes zero outbound requests. Everything — fonts, art, hls.js, jokes — is served from this box.', { emoji: '🔒' });
  }
  return h('div', { class: 'adm-table-wrap' },
    h('table', { class: 'adm-table' },
      h('caption', {}, 'Outbound endpoints'),
      h('thead', {}, h('tr', {}, h('th', {}, 'Host'), h('th', {}, 'Reason'), h('th', {}, 'Enabled'))),
      h('tbody', {}, ...endpoints.map((endpoint) => h('tr', {},
        h('td', { class: 'mono' }, safeText(endpoint.host)),
        h('td', { class: 'wrap' }, safeText(endpoint.reason, '—')),
        h('td', {}, endpoint.enabled ? badge('warn', 'enabled') : badge('ok', 'disabled')),
      ))),
    ),
  );
}

function importAction(draw) {
  const input = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Choose instance metadata JSON' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('That import is over 12 MB. Instance metadata should be far smaller.', 'error'); return; }
    let parsed;
    try {
      parsed = JSON.parse(await readFileText(file));
    } catch (error) {
      toast(`That file is not valid JSON: ${apiError(error)}`, 'error');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast('Import must be a JSON object with settings/libraries/collections/playlists.', 'error');
      return;
    }
    const payload = {};
    if (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) payload.settings = parsed.settings;
    if (Array.isArray(parsed.libraries)) {
      payload.libraries = parsed.libraries.map((library) => {
        let settings = library?.settings;
        if (typeof settings === 'string') {
          try { settings = JSON.parse(settings); } catch { settings = {}; }
        }
        return {
          ...library,
          scanSchedule: library?.scanSchedule || library?.scan_schedule || 'daily',
          settings: settings && typeof settings === 'object' ? settings : {},
        };
      });
    }
    if (Array.isArray(parsed.collections)) payload.collections = parsed.collections;
    if (Array.isArray(parsed.playlists)) payload.playlists = parsed.playlists;
    const counts = {
      settings: payload.settings ? 1 : 0,
      libraries: payload.libraries?.length || 0,
      collections: payload.collections?.length || 0,
      playlists: payload.playlists?.length || 0,
    };
    const total = counts.settings + counts.libraries + counts.collections + counts.playlists;
    if (!total) {
      toast('No importable metadata found. This importer accepts settings, libraries, collections and playlists.', 'error');
      return;
    }
    const noun = (count, singular, pluralWord) => `${count} ${count === 1 ? singular : pluralWord}`;
    const ok = await confirmDialog(
      `Import metadata from ${file.name}?`,
      `Imports ${counts.settings ? 'settings, ' : ''}${noun(counts.libraries, 'library', 'libraries')}, ${noun(counts.collections, 'collection', 'collections')} and ${noun(counts.playlists, 'playlist', 'playlists')}. Media rows, users and reports in the file are ignored — this server only imports configuration and curation metadata. Existing names/paths are skipped, not overwritten.`,
      { confirmLabel: 'Import metadata', danger: true },
    );
    if (!ok) return;
    try {
      const result = await adminPost('/api/admin/import', payload);
      const imported = result?.imported || {};
      const skipped = result?.skipped || [];
      modal({
        title: 'Import finished',
        body: h('div', {},
          h('pre', { class: 'adm-code' }, jsonPretty({ imported, skipped })),
          h('div', { class: 'adm-note', style: { marginTop: '10px' } }, 'If media rows were imported without files, run a scan to reconcile paths. Nothing outside the metadata tables was touched.'),
        ),
        wide: true,
        actions: [{ label: 'Close' }],
      });
      toast('Metadata import completed.', 'success');
      draw();
    } catch (error) {
      toast(apiError(error), 'error');
    }
  });
  return h('div', { class: 'adm-file-input' },
    h('span', { class: 'help' }, 'Choose a metadata JSON export…'),
    input,
  );
}

function exportAction() {
  return btn('Export instance metadata', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await downloadPath('/api/admin/export', `aislop-instance-${new Date().toISOString().slice(0, 10)}.json`);
      toast('Instance metadata exported. Passwords and media bytes are not included.', 'success');
    } catch (error) {
      toast(apiError(error), 'error');
    } finally {
      button.disabled = false;
    }
  }, { kind: 'primary', iconText: '⇩' });
}

function wipeCache(draw) {
  return btn('Wipe transient cache', async () => {
    const ok = await confirmDialog(
      'Wipe transient caches?',
      'Deletes transcode sessions, converted subtitles and temp files. Cached artwork and the database are not touched. Ongoing streams may stutter or need a restart.',
      { confirmLabel: 'Wipe cache', danger: true },
    );
    if (!ok) return;
    try {
      const result = await adminPost('/api/admin/maintenance', { action: 'clear-cache' });
      toast(`Cache wiped: ${fmtNum(result?.removedFiles ?? 0)} file(s), ${fmtBytesSafe(result?.freedBytes ?? 0)} reclaimed.`, 'success');
      draw();
    } catch (error) {
      toast(apiError(error), 'error');
    }
  }, { kind: 'danger' });
}

async function drawPrivacy(host, ctx) {
  try {
    const privacy = await adminGet('/api/admin/privacy', { signal: ctx.signal });
    const tmdb = privacy.tmdb || {};
    const cookie = privacy.cookie || {};
    const logs = privacy.logs || {};
    const endpoints = Array.isArray(privacy.outboundEndpoints) ? privacy.outboundEndpoints : [];
    const exportsInfo = privacy.exports || {};
    host.replaceChildren(h('div', { class: 'adm-section' },
      pageHead('Privacy', 'A truthful audit of what leaves this box. Spoiler: nothing, unless you configured TMDB.', [
        exportAction(),
        btn('Refresh', () => drawPrivacy(host, ctx), { iconText: '↻' }),
      ]),
      h('div', { class: 'adm-audit' },
        auditItem('telemetry', setOf(privacy.telemetry), 'Hard-coded off in the server. There is no toggle to enable it.'),
        auditItem('analytics', setOf(privacy.analytics), 'No counters, no pings, no “anonymous usage”.'),
        auditItem('external assets', h('span', { class: 'num' }, `${fmtNum(privacy.externalFonts ?? 0)} fonts · ${fmtNum(privacy.cdnAssets ?? 0)} CDN · ${fmtNum(privacy.thirdPartyScripts ?? 0)} scripts`), 'CSP default-src self. External assets would fail even if added.'),
        auditItem('TMDB', tmdb.configured ? badge('warn', 'configured') : badge('ok', 'disabled'), tmdb.configured ? `${safeText(tmdb.host || 'api.themoviedb.org')} · autoMatch ${tmdb.autoMatch ? 'on' : 'off'} · source ${safeText(tmdb.source)}` : 'No key set. Zero outbound metadata requests.'),
        auditItem('outbound network', privacy.zeroOutbound ? badge('ok', 'zero by default') : badge('warn', 'exceptions listed'), 'The only allowed host is TMDB, and only when configured.'),
        auditItem('session cookie', h('span', { class: 'mono small' }, safeText(cookie.name || 'slop_session')), `${cookie.httpOnly ? 'HttpOnly' : 'NOT HttpOnly'} · SameSite=${safeText(cookie.sameSite)}${cookie.secure ? ' · Secure' : ''}`),
        auditItem('password hashing', h('span', { class: 'mono' }, safeText(privacy.passwordHashing, 'scrypt')), 'Local hashes, no recovery email, no external identity provider.'),
        auditItem('logs', logs.local ? badge('ok', 'local only') : badge('warn', 'review'), `Stored in ${safeText(logs.store || 'sqlite')} under the data dir. No sinks, no telemetry.`),
        auditItem('data location', h('span', { class: 'mono small', style: { overflowWrap: 'anywhere' } }, safeText(privacy.dataDir)), 'Everything persistent lives here: DB, caches, artwork, logs.'),
      ),
      h('div', { class: 'adm-grid-2 even' },
        card('Outbound endpoints', [outboundTable(endpoints)], { sub: `${endpoints.length} declared` }),
        card('Data export', [
          h('div', { class: 'adm-note' }, h('strong', {}, 'Instance metadata: '), 'settings, libraries, media rows, art paths, collections, playlists, requests and reports. No media bytes and no password hashes. TMDB key is redacted in exports.'),
          h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '10px' } },
            exportAction(),
          ),
          h('div', { class: 'divider' }),
          h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, 'import metadata'),
          importAction(() => drawPrivacy(host, ctx)),
          h('p', { class: 'faint small', style: { marginTop: '8px' } }, `Exports available in the API: ${safeText(exportsInfo.instance, 'instance')}${exportsInfo.user ? ` · ${exportsInfo.user}` : ''}.`),
        ], { sub: 'no bytes, no secrets' }),
      ),
      h('div', { class: 'adm-grid-2' },
        card('Player-facing privacy promises', [
          h('div', { class: 'adm-list' },
            ...['Zero external fonts, CDNs, analytics or third-party scripts.',
              'Images, video, subtitles and HLS are all served same-origin.',
              'Session cookie is HttpOnly and SameSite=Strict; mutations check Origin.',
              'Logs never record passwords, tokens or cookies.',
              'Data never leaves the data dir unless you download an export.',
            ].map((line) => h('div', { class: 'adm-list-row' },
              h('span', { class: 'adm-nav-icon', 'aria-hidden': 'true' }, '✓'),
              h('div', { class: 'adm-list-main' }, h('strong', {}, line)),
            )),
          ),
        ], { sub: 'truthful, not marketing' }),
        card('Cache & cleanup', [
          h('p', { class: 'help', style: { marginBottom: '10px' } }, 'Transcode segments, converted subtitles and temp files are disposable. Artwork and the DB are persistent — clear those from Storage or Media.'),
          cleanCacheAction(() => drawPrivacy(host, ctx)),
          h('div', { class: 'adm-note', style: { marginTop: '10px' } }, 'Zero outbound by default means even cover art is generated locally or read from disk. No silent metadata phone-home.'),
        ], { sub: 'not the DB' }),
      ),
    ));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    host.replaceChildren(h('div', { class: 'adm-section' },
      pageHead('Privacy', 'Outbound audit'),
      errorState(error, () => drawPrivacy(host, ctx), { title: 'Privacy audit did not load' }),
    ));
  }
}

function cleanCacheAction(draw) {
  const action = wipeCache(draw);
  return h('div', {}, action);
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(7)));
    await drawPrivacy(host, ctx);
  },
};
