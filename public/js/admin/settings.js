// Settings: grouped SiteSettings form, dirty tracking, validation, dangerous toggle confirmations.
import {
  h, adminGet, adminPatch, pageHead, card, btn, badge, errorState, skeletonRows,
  confirmDialog, toast, field, textInput, selectInput, state, apiError, fieldId,
} from './core.js';

const ACCENTS = [
  { value: 'slop', label: 'slop — lime on void' },
  { value: 'light', label: 'light — paper' },
  { value: 'midnight', label: 'midnight — cyan depths' },
  { value: 'goblin', label: 'goblin — swamp' },
];
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((preset) => ({ value: preset, label: preset }));
const HWACCEL = [
  { value: 'auto', label: 'auto — best available device' },
  { value: 'none', label: 'none — software (libx264)' },
  { value: 'nvenc', label: 'NVIDIA NVENC' },
  { value: 'qsv', label: 'Intel Quick Sync' },
  { value: 'vaapi', label: 'VAAPI (AMD/Intel, Linux)' },
  { value: 'rkmpp', label: 'Rockchip MPP (RK3588)' },
  { value: 'v4l2m2m', label: 'V4L2 mem2mem (Raspberry Pi 4)' },
  { value: 'vulkan', label: 'Vulkan Video' },
  { value: 'amf', label: 'AMD AMF (Windows)' },
  { value: 'videotoolbox', label: 'Apple VideoToolbox' },
];
const MANAGED = [
  'serverName', 'tagline', 'accent', 'allowSignups', 'requireInvite', 'tmdbApiKey',
  'tvdbApiKey', 'omdbApiKey', 'tvmazeEnabled', 'imdbEnabled', 'ingestWatch', 'ingestIntervalSeconds',
  'transcodeEnabled', 'subtitleBurnIn', 'maxTranscodeHeight', 'transcodePreset',
  'hwAccel', 'hwAccelDevice', 'hwAccelDecode', 'transcodeThrottleSeconds',
  'scanOnStart', 'autoMatch', 'generateArt', 'allowRequests', 'allowParties', 'maintenanceMode', 'memes',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(settings) {
  const result = {};
  for (const key of MANAGED) result[key] = settings[key];
  return result;
}

function sameSettings(a, b) {
  return JSON.stringify(snapshot(a)) === JSON.stringify(snapshot(b));
}

function validate(draft) {
  if (!String(draft.serverName || '').trim()) return 'Server name cannot be empty.';
  if (String(draft.serverName).trim().length > 60) return 'Server name must be 60 characters or fewer.';
  if (String(draft.tagline || '').length > 160) return 'Tagline must be 160 characters or fewer.';
  if (!ACCENTS.some((accent) => accent.value === draft.accent)) return 'Pick an accent from the allowlist.';
  const height = Number(draft.maxTranscodeHeight);
  if (!Number.isInteger(height) || height < 144 || height > 2160) return 'Max transcode height must be an integer between 144 and 2160.';
  if (!PRESETS.some((preset) => preset.value === draft.transcodePreset)) return 'Pick a valid ffmpeg preset.';
  if (!HWACCEL.some((mode) => mode.value === draft.hwAccel)) return 'Pick a valid hardware acceleration mode.';
  const hwDevice = String(draft.hwAccelDevice || '').trim();
  if (hwDevice !== '' && !/^\/dev\/[A-Za-z0-9_./-]{1,120}$/.test(hwDevice)) return 'Hardware device must look like /dev/dri/renderD128, or stay blank.';
  const throttle = Number(draft.transcodeThrottleSeconds);
  if (!Number.isInteger(throttle) || throttle < 0 || throttle > 900) return 'Transcode throttle must be 0–900 seconds (0 disables it).';
  const key = String(draft.tmdbApiKey || '').trim();
  if (key !== '' && !/^[A-Za-z0-9._-]{8,512}$/.test(key)) return 'TMDB key must be 8–512 letters, numbers, dot, dash or underscore, or blank to clear.';
  const tvdbKey = String(draft.tvdbApiKey || '').trim();
  if (tvdbKey !== '' && !/^[A-Za-z0-9._-]{8,512}$/.test(tvdbKey)) return 'TVDB key must be 8–512 letters, numbers, dot, dash or underscore, or blank to clear.';
  const omdbKey = String(draft.omdbApiKey || '').trim();
  if (omdbKey !== '' && !/^[A-Za-z0-9._-]{8,512}$/.test(omdbKey)) return 'OMDb key must be 8–512 letters, numbers, dot, dash or underscore, or blank to clear.';
  const interval = Number(draft.ingestIntervalSeconds);
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) return 'Ingestion watcher interval must be a whole number of seconds between 5 and 3600.';
  return null;
}

function group(title, description, children) {
  return card(title, [
    description ? h('p', { class: 'group-desc' }, description) : null,
    ...children,
  ], { className: 'adm-settings-group' });
}

function boundToggle({ key, label, help, draft, markDirty, dangerMessage, dangerLabel, dangerWhen = true }) {
  const box = h('input', { type: 'checkbox', checked: draft[key] ? true : undefined });
  box.addEventListener('change', async () => {
    if (box.checked === dangerWhen && dangerMessage) {
      const ok = await confirmDialog('Confirm this toggle', dangerMessage, { confirmLabel: dangerLabel || 'Confirm', danger: true });
      if (!ok) { box.checked = !box.checked; return; }
    }
    draft[key] = box.checked;
    markDirty();
  });
  return h('label', { class: `adm-check${dangerMessage ? ' danger' : ''}` },
    box,
    h('span', { class: 'adm-check-copy' }, h('strong', {}, label), help ? h('span', {}, help) : null),
  );
}

function textSetting({ label, key, draft, markDirty, help, type = 'text', placeholder, maxlength }) {
  const input = h('input', {
    class: 'input', type, value: draft[key] ?? '', placeholder: placeholder || undefined,
    maxlength: maxlength || undefined, autocomplete: 'off',
  });
  input.addEventListener('input', () => { draft[key] = input.value; markDirty(); });
  return field(label, input, { help });
}

function selectSetting({ label, key, draft, markDirty, options, help }) {
  const select = selectInput({ value: draft[key], options, onInput: (value) => { draft[key] = value; markDirty(); } });
  return field(label, select, { help });
}

function keySetting({ label, key, draft, markDirty, help, placeholder }) {
  const input = h('input', {
    class: 'input', type: 'password', value: draft[key] || '', autocomplete: 'off',
    placeholder: placeholder || (draft[key] ? 'configured — hidden' : 'not configured'),
  });
  const inputId = fieldId('adm-key');
  input.id = inputId;
  input.addEventListener('input', () => { draft[key] = input.value.trim(); markDirty(); });
  const reveal = btn('Show', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? 'Show' : 'Hide';
  }, { small: true });
  return h('div', { class: 'adm-field' },
    h('label', { for: inputId }, label),
    h('div', { class: 'adm-input-row' }, input, reveal),
    help ? h('div', { class: 'help' }, help) : null,
  );
}

function numberSetting({ label, key, draft, markDirty, help, min, max, step = 1 }) {
  const input = h('input', { class: 'input', type: 'number', value: draft[key] ?? '', min, max, step, autocomplete: 'off' });
  input.addEventListener('input', () => { draft[key] = input.value === '' ? '' : Number(input.value); markDirty(); });
  return field(label, input, { help });
}

async function buildSettings(host, ctx, draw) {
  const loaded = await adminGet('/api/admin/settings', { signal: ctx.signal });
  let hwReport = null;
  try {
    hwReport = await adminGet('/api/hwaccel', { signal: ctx.signal });
  } catch {
    /* capability report is a nice-to-have; settings still work */
  }
  let initial = snapshot(loaded?.settings || loaded || {});
  let draft = clone(initial);
  let saveButton = null;
  let discardButton = null;
  let dirtyPill = null;
  let outboundSlot = null;
  let errorLine = h('div', { class: 'form-error', role: 'alert', hidden: true });

  function outboundProviders() {
    return [
      draft.tmdbApiKey ? 'TMDB' : null,
      draft.tvdbApiKey ? 'TVDB' : null,
      draft.omdbApiKey ? 'OMDb' : null,
      draft.tvmazeEnabled ? 'TVmaze' : null,
      draft.imdbEnabled ? 'IMDb' : null,
    ].filter(Boolean);
  }

  function paintOutboundAudit() {
    if (!outboundSlot) return;
    const providers = outboundProviders();
    outboundSlot.replaceChildren(
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'telemetry'), h('div', { class: 'value' }, badge('ok', 'off forever'), h('span', { class: 'faint small' }, 'hard-coded'))),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'external assets'), h('div', { class: 'value' }, h('span', { class: 'num' }, '0')), h('div', { class: 'detail' }, 'CSP blocks them anyway.')),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'outbound-capable providers'), h('div', { class: 'value' }, providers.length ? badge('warn', `${providers.length} enabled`) : badge('ok', 'none')), h('div', { class: 'detail' }, providers.length ? providers.join(', ') : 'No provider keys or keyless toggles in this form.')),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'automatic matching'), h('div', { class: 'value' }, draft.autoMatch && providers.length ? badge('warn', 'on') : badge('ok', 'off')), h('div', { class: 'detail' }, draft.autoMatch ? 'Scans may search enabled providers.' : 'Manual search only.')),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'environment keys'), h('div', { class: 'value' }, h('span', { class: 'small' }, 'not shown here')), h('div', { class: 'detail' }, 'TMDB_API_KEY, TVDB_API_KEY or OMDB_API_KEY in the environment can enable a provider outside this form. Privacy is the live audit.')),
    );
  }

  const isDirty = () => !sameSettings(draft, initial);
  const markDirty = () => {
    const dirty = isDirty();
    state.dirty = dirty;
    if (dirtyPill) {
      dirtyPill.textContent = dirty ? '● unsaved changes' : 'all settings saved';
      dirtyPill.className = `adm-dirty-pill${dirty ? '' : ' clean'}`;
    }
    if (saveButton) saveButton.disabled = !dirty;
    if (discardButton) discardButton.disabled = !dirty;
    if (!dirty) { errorLine.hidden = true; errorLine.textContent = ''; }
    paintOutboundAudit();
  };

  const save = async () => {
    const problem = validate(draft);
    if (problem) {
      errorLine.textContent = problem;
      errorLine.hidden = false;
      toast(problem, 'error');
      return;
    }
    const patch = {};
    for (const key of MANAGED) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(initial[key])) patch[key] = draft[key];
    }
    if ('serverName' in patch) {
      patch.serverName = String(patch.serverName).trim() || 'AISlopMediaBox';
    }
    if ('tagline' in patch) patch.tagline = String(patch.tagline || '').trim();
    if (!Object.keys(patch).length) { markDirty(); toast('No changes to save.', 'info'); return; }
    saveButton.disabled = true;
    const scrollY = window.scrollY;
    try {
      const result = await adminPatch('/api/admin/settings', patch);
      initial = snapshot(result?.settings || { ...initial, ...patch });
      draft = clone(initial);
      errorLine.hidden = true;
      toast(`Settings saved (${Array.isArray(result?.changed) ? result.changed.length : Object.keys(patch).length} key(s)).`, 'success');
      await draw({ scrollY });
    } catch (error) {
      errorLine.textContent = apiError(error);
      errorLine.hidden = false;
      saveButton.disabled = false;
      toast(apiError(error), 'error');
    }
  };

  dirtyPill = h('span', { class: 'adm-dirty-pill' });
  saveButton = btn('Save settings', save, { kind: 'primary', title: 'Save only changed settings' });
  discardButton = btn('Discard changes', () => {
    draft = clone(initial);
    markDirty();
    draw({ scrollY: window.scrollY });
    toast('Changes discarded.', 'info');
  }, { small: true });

  const body = h('div', { class: 'adm-section' },
    pageHead('Settings', 'SiteSettings — explicit save, dirty tracking, and confirmations on the switches that can bite', [
      btn('Reload from server', async () => {
        if (isDirty()) {
          const ok = await confirmDialog('Discard unsaved edits?', 'Reloading replaces the form with what the server currently has.', { confirmLabel: 'Discard and reload', danger: true });
          if (!ok) return;
        }
        await draw();
      }, { small: true }),
    ]),
    h('div', { class: 'adm-note' }, 'Changes are saved only when you press Save. Settings apply immediately after saving — the server publishes settings.changed over SSE.'),
    h('div', { class: 'adm-grid-2 even' },
      group('Branding', 'What people see on the login screen and in the app shell.', [
        textSetting({ label: 'Server name', key: 'serverName', draft, markDirty, help: 'Shown in the sidebar and page title. 60 chars max.', maxlength: 60 }),
        textSetting({ label: 'Tagline', key: 'tagline', draft, markDirty, help: 'Dry wit allowed. 160 chars max.', maxlength: 160 }),
        selectSetting({ label: 'Accent theme', key: 'accent', draft, markDirty, options: ACCENTS, help: 'Applies the same local palette everywhere. No external assets involved.' }),
      ]),
      group('Access & invitations', 'Gate who can get in. There is no email recovery, by design.', [
        boundToggle({
          key: 'allowSignups', label: 'Allow open signups', draft, markDirty,
          help: 'Anyone reaching the login page can create an account (invite rules still apply).',
          dangerMessage: 'Turning this on opens registration to anyone who can reach this server. If it is exposed to the internet, this is how “surprise guests” happen.',
          dangerLabel: 'Open signups',
        }),
        boundToggle({
          key: 'requireInvite', label: 'Require an invite code', draft, markDirty,
          help: 'New accounts need a valid, unused invite.',
          dangerMessage: 'Turning this off means signups need no invite. Combined with open signups, literally anyone can register.',
          dangerLabel: 'Disable invites',
          dangerWhen: false,
        }),
      ]),
      group('Playback & transcoding', 'Server-side ffmpeg behaviour. Direct play is always preferred when the browser can handle it.', [
        boundToggle({
          key: 'transcodeEnabled', label: 'Enable transcoding', draft, markDirty,
          help: 'Disable only if every client can direct-play. Phones will cope… probably not.',
          dangerMessage: 'Disabling the transcoder means incompatible clients get errors instead of converted streams. HLS sessions stop working for non-native codecs.',
          dangerLabel: 'Disable transcoding',
          dangerWhen: false,
        }),
        boundToggle({ key: 'subtitleBurnIn', label: 'Allow burned-in subtitles', draft, markDirty, help: 'Burn-in re-encodes video and costs CPU. Used only when a client requests burn=1.' }),
        selectSetting({ label: 'Transcode preset', key: 'transcodePreset', draft, markDirty, options: PRESETS, help: 'Faster presets trade quality/CPU. veryfast is the default. This is ffmpeg’s allowlist, not vibes.' }),
        numberSetting({ label: 'Max transcode height', key: 'maxTranscodeHeight', draft, markDirty, min: 144, max: 2160, step: 1, help: 'Vertical pixels, 144–2160. 1080 is the sane default; 2160 will make the CPU sweat.' }),
        h('p', { class: 'group-desc' }, hwReport?.encoders?.length
          ? `Detected working encoders: ${hwReport.encoders.map((entry) => `${entry.label} (${entry.encoder})`).join(' · ')}. Active: ${hwReport.active?.hardware ? `${hwReport.active.encoder}` : 'software (libx264)'}.`
          : `No working hardware encoder detected. Software x264 will be used.${hwReport?.notes?.length ? ` ${hwReport.notes.join(' ')}` : ''}`),
        selectSetting({ label: 'Hardware acceleration', key: 'hwAccel', draft, markDirty, options: HWACCEL, help: 'auto probes ffmpeg and the device nodes at boot; each candidate is smoke-encoded before use. Devices are passed through to the container with --device=/dev/dri.' }),
        textSetting({ label: 'Hardware device override', key: 'hwAccelDevice', draft, markDirty, placeholder: '/dev/dri/renderD128', help: 'Optional. Blank means autodetect. Useful on multi-GPU hosts or when VAAPI picks the wrong render node.' }),
        boundToggle({ key: 'hwAccelDecode', label: 'Hardware decoding', draft, markDirty, help: 'Decode on the GPU too when the encoder supports a zero-copy chain (VAAPI/QSV/CUDA). Falls back to software automatically if a file fails.' }),
        numberSetting({ label: 'Transcode throttle (seconds)', key: 'transcodeThrottleSeconds', draft, markDirty, min: 0, max: 900, step: 10, help: 'Pause ffmpeg once it is this far ahead of the client. 120 keeps seeking snappy without filling the disk; 0 disables throttling.' }),
      ]),
      group('Scanning & matching', 'How the scanner behaves at boot and after import.', [
        boundToggle({ key: 'scanOnStart', label: 'Scan libraries on start', draft, markDirty, help: 'Runs due scheduled scans when the server boots. Can make startup feel busy.' }),
        boundToggle({ key: 'autoMatch', label: 'Automatic provider matching', draft, markDirty, help: 'Lets scans and ingestion search enabled providers (TMDB/TVDB/OMDb with keys, TVmaze/IMDb when toggled). Local NFO/filename inference always runs first. Manual provider search ignores this switch.' }),
        boundToggle({ key: 'generateArt', label: 'Generate artwork', draft, markDirty, help: 'ffmpeg-frame posters and sidecars. Placeholder art is client-side, so the UI never depends on this.' }),
      ]),
      group('Requests, parties & memes', 'Social surface area. All local, no third-party services.', [
        boundToggle({ key: 'allowRequests', label: 'Allow media requests', draft, markDirty, help: 'Users can ask for titles; you review them in Requests.' }),
        boundToggle({ key: 'allowParties', label: 'Allow watch parties', draft, markDirty, help: 'Synced playback rooms, max 20 attendees, all local state.' }),
        boundToggle({ key: 'memes', label: 'Meme copy', draft, markDirty, help: 'Dry jokes in empty states and toasts. Never at the expense of clarity.' }),
      ]),
      group('Maintenance', 'Take the app down for major work. Streaming truth stays honest.', [
        boundToggle({
          key: 'maintenanceMode', label: 'Maintenance mode', draft, markDirty,
          help: 'Shows a maintenance notice in the app. Admin and APIs remain reachable.',
          dangerMessage: 'Maintenance mode changes what regular users see and may interrupt their session flow. Turn it on deliberately.',
          dangerLabel: 'Enable maintenance',
        }),
      ]),
      group('Metadata providers & privacy', 'Zero outbound by default. A provider only talks out when a key or an explicit keyless toggle enables it.', [
        keySetting({ label: 'TMDB API key', key: 'tmdbApiKey', draft, markDirty, placeholder: draft.tmdbApiKey ? 'configured — hidden' : 'not configured', help: 'v3 key or v4 bearer token. Clearing disables TMDB metadata and art. (api.themoviedb.org, image.tmdb.org)' }),
        keySetting({ label: 'TVDB v4 API key', key: 'tvdbApiKey', draft, markDirty, placeholder: draft.tvdbApiKey ? 'configured — hidden' : 'not configured', help: 'TVDB v4 key, or set TVDB_API_KEY in the environment. Clearing the field disables the TVDB provider. (api4.thetvdb.com, artworks.thetvdb.com)' }),
        keySetting({ label: 'OMDb API key', key: 'omdbApiKey', draft, markDirty, placeholder: draft.omdbApiKey ? 'configured — hidden' : 'not configured', help: 'OMDb key, or set OMDB_API_KEY. Used for movie details; clearing disables it. (www.omdbapi.com, m.media-amazon.com)' }),
        boundToggle({ key: 'tvmazeEnabled', label: 'Use TVmaze (keyless)', draft, markDirty, help: 'Show lookup without a key. Explicit opt-in: api.tvmaze.com and static.tvmaze.com image URLs.' }),
        boundToggle({ key: 'imdbEnabled', label: 'Use IMDb suggestions (keyless, unofficial)', draft, markDirty, help: 'Unofficial suggestion endpoint at v2.sg.media-imdb.com; posters load from m.media-amazon.com. Community service; can change without notice.' }),
        h('div', { class: 'span-2 adm-note' },
          h('strong', {}, 'Privacy note: '),
          'No provider is contacted unless it is configured/enabled. Manual provider search sends the title/year query you type; choosing a candidate sends its provider id. Automatic matching additionally requires the autoMatch switch. Keys are stored plaintext in local SQLite (there is no vault) and are never logged or broadcast. Possible hosts: TMDB api.themoviedb.org + image.tmdb.org; TVDB api4.thetvdb.com + artworks.thetvdb.com; OMDb www.omdbapi.com + m.media-amazon.com; TVmaze api.tvmaze.com + static.tvmaze.com; IMDb suggestions v2.sg.media-imdb.com + m.media-amazon.com. No telemetry, analytics, external fonts, CDNs or scripts are ever loaded; CSP blocks third-party images. The Ingestion and Privacy pages show the server’s live host registry.'),
        (outboundSlot = h('div', { class: 'adm-audit', style: { marginTop: '10px' } })),
      ]),
      group('Ingestion watcher', 'Background discovery for configured drop folders. Editing sources and running scans lives on the Ingestion page.', [
        boundToggle({ key: 'ingestWatch', label: 'Watch drop folders', draft, markDirty, help: 'Periodically enqueues one ingest job for enabled sources. Off means manual Scan now / Scan all only.' }),
        numberSetting({ label: 'Watcher interval (seconds)', key: 'ingestIntervalSeconds', draft, markDirty, min: 5, max: 3600, step: 1, help: 'Whole seconds between checks, 5–3600. The server persists this and unrefs its timer; changes apply after saving.' }),
        h('div', { class: 'span-2 adm-note' }, 'The watcher only queues discovery. Processing still respects each source’s settle delay, confidence threshold, auto-match and hold-in-review settings. Files are never deleted by ingestion; destination collisions get a “ (2)” suffix.'),
      ]),
    ),
    h('div', { class: 'adm-settings-actions' },
      dirtyPill,
      errorLine,
      h('span', { class: 'spacer' }),
      discardButton,
      saveButton,
    ),
  );

  host.replaceChildren(body);
  markDirty();
  state.dirtyGuard = async () => {
    if (!isDirty()) return true;
    const ok = await confirmDialog(
      'Leave settings with unsaved changes?',
      'Your edits exist only in this tab. Leaving discards them unless you save first. This is the part where we pretend that is fine.',
      { confirmLabel: 'Discard and leave', danger: true },
    );
    if (ok) state.dirty = false;
    return ok;
  };
  return () => {
    state.dirtyGuard = null;
    state.dirty = false;
  };
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(9)));
    const draw = async ({ scrollY } = {}) => {
      if (state.dirtyGuard) { state.dirtyGuard = null; state.dirty = false; }
      try {
        const cleanup = await buildSettings(host, ctx, draw);
        if (typeof cleanup === 'function') {
          ctx.onCleanup(cleanup);
        }
        if (scrollY !== undefined) window.scrollTo({ top: scrollY, behavior: 'instant' });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Settings', 'SiteSettings'),
          errorState(error, () => draw(), { title: 'Settings did not load' }),
        ));
      }
    };
    await draw();
  },
};
