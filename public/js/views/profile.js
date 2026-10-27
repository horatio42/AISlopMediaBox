// Profile & settings — identity, playback, security, sessions, data.
import { api, get, post, patch, del, initials, fmtDate, fmtRelative } from '../api.js';
import { h, toast, confirmDialog } from '../ui.js';
import { state as appState } from '../app.js';

const THEMES = [
  { value: 'slop', label: 'Slop — lime chaos (default)' },
  { value: 'dark', label: 'Dark — slop classic' },
  { value: 'midnight', label: 'Midnight — blue void' },
  { value: 'light', label: 'Daylight — unwise but valid' },
];

const SUBTITLE_OPTIONS = [
  { value: '', label: 'Off by default' },
  { value: 'en', label: 'English when available' },
  { value: 'forced', label: 'Forced only' },
  { value: 'auto', label: 'First available track' },
];

const AUDIO_OPTIONS = [
  { value: '', label: 'Server decides' },
  { value: 'eng', label: 'English preferred' },
  { value: 'jpn', label: 'Japanese preferred' },
  { value: 'original', label: 'Original language' },
];

function copy(error, fallback = 'The slop broke. Try again.') {
  return error?.message || fallback;
}

function applyThemeChoice(choice) {
  const theme = choice === 'dark' ? 'slop' : choice || 'slop';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('slop-theme', theme); } catch { /* private mode */ }
  if (appState) appState.theme = theme;
}

function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
      : /chrome|crios/i.test(ua) ? 'Chrome'
        : /safari/i.test(ua) ? 'Safari'
          : /curl/i.test(ua) ? 'curl (respect)' : 'Unknown browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
      : /iphone|ipad|ipod|ios/i.test(ua) ? 'iOS'
        : /mac os|macintosh/i.test(ua) ? 'macOS'
          : /linux/i.test(ua) ? 'Linux' : 'an unknown OS';
  return `${browser} on ${os}`;
}

function card(title, body, { sub, wide = false } = {}) {
  return h('section', { class: `card profile-card${wide ? ' wide' : ''}` },
    h('div', { class: 'card-title' },
      h('h3', {}, title),
      sub ? h('span', { class: 'faint small' }, sub) : null,
    ),
    body,
  );
}

export default async function render(container) {
  let user = appState?.user ? { ...appState.user } : null;
  try {
    const res = await get('/api/users/me');
    const fetched = res?.user || res;
    if (fetched && typeof fetched === 'object') user = { ...(user || {}), ...fetched };
  } catch {
    /* app shell already has a user; profile just works read-only-ish if the call fails */
  }
  if (!user) {
    container.append(h('div', { class: 'empty-state' },
      h('div', { class: 'emoji' }, '💀'),
      h('h3', {}, 'No user loaded'),
      h('p', {}, 'Reload the page. The session is confused.'),
    ));
    return;
  }

  let prefs = {
    autoPlayNext: true,
    defaultSubtitle: '',
    defaultAudio: '',
    spoilerBlur: false,
    cardDensity: 'cozy',
    memes: true,
    theme: 'slop',
    ...(user.preferences && typeof user.preferences === 'object' ? user.preferences : {}),
  };
  // The theme allowlist is slop|dark|light|midnight; anything else (e.g. local goblin) must not be persisted.
  if (!['slop', 'dark', 'light', 'midnight'].includes(prefs.theme)) prefs.theme = 'slop';
  document.body.dataset.density = prefs.cardDensity === 'compact' ? 'compact' : 'cozy';

  const avatarEl = h('span', { class: 'avatar profile-avatar' }, initials(user.displayName || user.username));
  avatarEl.style.setProperty('--avatar-hue', String(user.avatarHue ?? 280));

  const pinPill = h('span', { class: 'pill good', hidden: !user.hasPin }, 'PIN locked');
  const header = h('header', { class: 'profile-hero' },
    avatarEl,
    h('div', { class: 'profile-hero-copy' },
      h('h1', { id: 'profile-display-name' }, user.displayName || user.username),
      h('p', { class: 'muted' }, `@${user.username} · ${user.role || 'user'}`),
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        h('span', { class: 'pill accent' }, user.role === 'admin' ? 'slop council' : user.role === 'manager' ? 'manager' : 'certified slopper'),
        pinPill,
        user.createdAt ? h('span', { class: 'pill' }, `joined ${fmtDate(user.createdAt)}`) : null,
      ),
    ),
  );
  container.append(header);

  const grid = h('div', { class: 'profile-grid' });
  container.append(grid);

  function syncChrome() {
    if (appState?.user) {
      appState.user.displayName = user.displayName;
      appState.user.avatarHue = user.avatarHue;
    }
    const nameEl = document.getElementById('me-name');
    if (nameEl) nameEl.textContent = user.displayName;
    const avatar = document.getElementById('me-avatar');
    if (avatar) {
      avatar.textContent = initials(user.displayName || user.username);
      avatar.style.setProperty('--avatar-hue', String(user.avatarHue ?? 280));
    }
    const heading = document.getElementById('profile-display-name');
    if (heading) heading.textContent = user.displayName || user.username;
  }

  async function saveUser(payload, successMessage = 'Saved. Character development.') {
    const res = await patch('/api/users/me', payload);
    const updated = res?.user || (res && typeof res === 'object' && !res.ok ? res : null);
    if (updated && typeof updated === 'object') user = { ...user, ...updated };
    if (payload.displayName !== undefined) user.displayName = payload.displayName;
    if (payload.avatarHue !== undefined) user.avatarHue = payload.avatarHue;
    if (payload.preferences !== undefined) {
      user.preferences = payload.preferences;
      if (appState?.user) appState.user.preferences = payload.preferences;
    }
    toast(successMessage, 'success');
    syncChrome();
    return user;
  }

  async function savePrefs(changes, successMessage = 'Preferences saved.') {
    const merged = { ...prefs, ...changes };
    try {
      await saveUser({ preferences: merged }, successMessage);
      prefs = merged;
      if (appState) appState.preferences = merged;
      return true;
    } catch (error) {
      toast(copy(error, 'Could not save preferences.'), 'error');
      return false;
    }
  }

  // --- Identity ---------------------------------------------------------
  const nameInput = h('input', {
    class: 'input',
    maxlength: '40',
    value: user.displayName || '',
    'aria-label': 'Display name',
  });
  const hueInput = h('input', {
    type: 'range',
    min: '0',
    max: '359',
    step: '1',
    value: String(user.avatarHue ?? 280),
    class: 'hue-range',
    'aria-label': 'Avatar hue',
  });
  const hueValue = h('span', { class: 'mono small faint' }, `${user.avatarHue ?? 280}°`);
  const identityPreview = h('span', { class: 'avatar profile-avatar small-preview' }, initials(user.displayName || user.username));
  identityPreview.style.setProperty('--avatar-hue', String(user.avatarHue ?? 280));

  function refreshPreview() {
    identityPreview.textContent = initials(nameInput.value.trim() || user.username);
    identityPreview.style.setProperty('--avatar-hue', hueInput.value);
    hueValue.textContent = `${hueInput.value}°`;
  }
  nameInput.addEventListener('input', refreshPreview);
  hueInput.addEventListener('input', refreshPreview);

  const identityError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const identitySave = h('button', {
    class: 'btn primary',
    type: 'button',
    onclick: async () => {
      identityError.hidden = true;
      const displayName = nameInput.value.trim();
      if (!displayName) {
        identityError.textContent = 'Display name cannot be empty. Even sloppers have names.';
        identityError.hidden = false;
        nameInput.focus();
        return;
      }
      identitySave.disabled = true;
      identitySave.textContent = 'Saving…';
      try {
        await saveUser({ displayName, avatarHue: Number(hueInput.value) }, 'Identity updated. Looking certified.');
        avatarEl.textContent = initials(user.displayName || user.username);
        avatarEl.style.setProperty('--avatar-hue', String(user.avatarHue));
      } catch (error) {
        identityError.textContent = copy(error, 'Could not save your identity.');
        identityError.hidden = false;
      } finally {
        identitySave.disabled = false;
        identitySave.textContent = 'Save identity';
      }
    },
  }, 'Save identity');

  grid.append(card('Identity', h('div', { class: 'profile-form' },
    h('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } },
      identityPreview,
      h('div', { class: 'stack', style: { gap: '4px', flex: '1' } },
        h('label', { class: 'small muted', for: 'profile-name-input' }, 'Display name'),
        nameInput,
      ),
    ),
    h('div', { class: 'field' },
      h('label', { for: 'profile-hue-input' }, 'Avatar hue'),
      h('div', { class: 'row', style: { gap: '10px' } }, hueInput, hueValue),
      h('p', { class: 'help' }, 'Drag the hue. The gradient does the rest. Zero external assets, obviously.'),
    ),
    identityError,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, identitySave),
  )));
  nameInput.id = 'profile-name-input';
  hueInput.id = 'profile-hue-input';

  // --- Appearance -------------------------------------------------------
  const themeSelect = h('select', { class: 'select', id: 'profile-theme', 'aria-label': 'Theme preference' },
    ...THEMES.map((theme) => h('option', { value: theme.value, selected: (prefs.theme || 'slop') === theme.value }, theme.label)));
  themeSelect.addEventListener('change', async () => {
    const chosen = themeSelect.value;
    applyThemeChoice(chosen);
    const ok = await savePrefs({ theme: chosen }, `Theme set to ${chosen}. Aesthetic maxing.`);
    if (!ok) {
      applyThemeChoice(prefs.theme || 'slop');
      themeSelect.value = prefs.theme || 'slop';
    }
  });

  grid.append(card('Appearance', h('div', { class: 'profile-form' },
    h('div', { class: 'field' }, h('label', { for: 'profile-theme' }, 'Theme'), themeSelect,
      h('p', { class: 'help' }, 'Applied instantly across the app and saved to your profile.'),
    ),
  )));
  // --- Playback ---------------------------------------------------------
  const autoplayCheck = h('input', { type: 'checkbox', checked: prefs.autoPlayNext !== false });
  const spoilerCheck = h('input', { type: 'checkbox', checked: Boolean(prefs.spoilerBlur) });
  const memesCheck = h('input', { type: 'checkbox', checked: prefs.memes !== false });
  const densitySelect = h('select', { class: 'select', id: 'profile-density', 'aria-label': 'Card density' },
    h('option', { value: 'cozy', selected: (prefs.cardDensity || 'cozy') === 'cozy' }, 'Cozy — room to breathe'),
    h('option', { value: 'compact', selected: prefs.cardDensity === 'compact' }, 'Compact — more posters, less air'));
  const subtitleSelect = h('select', { class: 'select', id: 'profile-subtitles', 'aria-label': 'Default subtitles' },
    ...SUBTITLE_OPTIONS.map((option) => h('option', { value: option.value, selected: (prefs.defaultSubtitle || '') === option.value }, option.label)));
  const audioSelect = h('select', { class: 'select', id: 'profile-audio', 'aria-label': 'Default audio track' },
    ...AUDIO_OPTIONS.map((option) => h('option', { value: option.value, selected: (prefs.defaultAudio || '') === option.value }, option.label)));
  const playbackSave = h('button', { class: 'btn primary', type: 'button' }, 'Save playback prefs');
  playbackSave.addEventListener('click', async () => {
    playbackSave.disabled = true;
    playbackSave.textContent = 'Saving…';
    const changes = {
      autoPlayNext: autoplayCheck.checked,
      spoilerBlur: spoilerCheck.checked,
      memes: memesCheck.checked,
      cardDensity: densitySelect.value,
      defaultSubtitle: subtitleSelect.value,
      defaultAudio: audioSelect.value,
    };
    const ok = await savePrefs(changes, 'Playback prefs saved. Cinema optimized.');
    if (ok) document.body.dataset.density = changes.cardDensity;
    playbackSave.disabled = false;
    playbackSave.textContent = 'Save playback prefs';
  });

  grid.append(card('Playback', h('div', { class: 'profile-form' },
    h('label', { class: 'check' }, autoplayCheck, h('span', {}, 'Autoplay the next episode (or next track)')),
    h('label', { class: 'check' }, spoilerCheck, h('span', {}, 'Spoiler blur on episode descriptions until hovered')),
    h('label', { class: 'check' }, memesCheck, h('span', {}, 'Meme copy — turn off if you are no fun')),
    h('div', { class: 'profile-two-col' },
      h('div', { class: 'field' }, h('label', { for: 'profile-subtitles' }, 'Subtitles'), subtitleSelect),
      h('div', { class: 'field' }, h('label', { for: 'profile-audio' }, 'Audio track'), audioSelect),
    ),
    h('div', { class: 'field' }, h('label', { for: 'profile-density' }, 'Card density'), densitySelect),
    h('p', { class: 'help' }, 'Preferences stay in your profile in the local database. No cloud, no shadow profile.'),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, playbackSave),
  )));

  // --- Password ---------------------------------------------------------
  const currentPassword = h('input', {
    class: 'input', id: 'profile-current-password', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password',
  });
  const nextPassword = h('input', {
    class: 'input', id: 'profile-new-password', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password',
  });
  const confirmPassword = h('input', {
    class: 'input', id: 'profile-confirm-password', type: 'password', autocomplete: 'new-password', 'aria-label': 'Confirm new password',
  });
  const passwordError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const passwordSave = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const passwordForm = h('form', { class: 'profile-form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'profile-current-password' }, 'Current password'), currentPassword),
    h('div', { class: 'profile-two-col' },
      h('div', { class: 'field' }, h('label', { for: 'profile-new-password' }, 'New password'), nextPassword),
      h('div', { class: 'field' }, h('label', { for: 'profile-confirm-password' }, 'Confirm new password'), confirmPassword),
    ),
    passwordError,
    h('p', { class: 'help' }, 'Minimum 6 characters. There is no reset email — the box has no mouth.'),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, passwordSave),
  );
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    passwordError.hidden = true;
    const current = currentPassword.value;
    const next = nextPassword.value;
    const confirm = confirmPassword.value;
    if (!current) {
      passwordError.textContent = 'Current password required. Prove it is you.';
      passwordError.hidden = false;
      currentPassword.focus();
      return;
    }
    if (next.length < 6) {
      passwordError.textContent = 'New password needs at least 6 characters.';
      passwordError.hidden = false;
      nextPassword.focus();
      return;
    }
    if (next !== confirm) {
      passwordError.textContent = 'New passwords do not match. Classic.';
      passwordError.hidden = false;
      confirmPassword.focus();
      return;
    }
    passwordSave.disabled = true;
    passwordSave.textContent = 'Changing…';
    try {
      await post('/api/users/me/password', { current, next });
      currentPassword.value = '';
      nextPassword.value = '';
      confirmPassword.value = '';
      toast('Password changed. Other sessions were revoked — this one survived.', 'success');
      loadSessions();
    } catch (error) {
      passwordError.textContent = copy(error, 'Could not change the password.');
      passwordError.hidden = false;
    } finally {
      passwordSave.disabled = false;
      passwordSave.textContent = 'Change password';
    }
  });
  grid.append(card('Password', passwordForm, { sub: 'local scrypt, no recovery email' }));

  // --- PIN --------------------------------------------------------------
  const pinInput = h('input', {
    class: 'input mono pin-input',
    id: 'profile-pin',
    type: 'password',
    inputmode: 'numeric',
    maxlength: '8',
    autocomplete: 'off',
    placeholder: user.hasPin ? 'Enter a new 4–8 digit PIN' : '4–8 digits',
    'aria-label': 'Profile PIN',
  });
  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 8);
  });
  const pinStatus = h('p', { class: 'help' }, user.hasPin
    ? 'This profile asks for a PIN on login.'
    : 'No PIN set. Add one if your screen is in a chaotic household.');
  const pinError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const pinSave = h('button', { class: 'btn primary', type: 'button' }, user.hasPin ? 'Update PIN' : 'Set PIN');
  const pinClear = h('button', { class: 'btn danger', type: 'button', hidden: !user.hasPin }, 'Clear PIN');

  pinSave.addEventListener('click', async () => {
    pinError.hidden = true;
    const pin = pinInput.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      pinError.textContent = 'PIN must be 4–8 digits. Numbers only, no letters.';
      pinError.hidden = false;
      pinInput.focus();
      return;
    }
    pinSave.disabled = true;
    try {
      await post('/api/auth/pin', { pin });
      user.hasPin = true;
      pinInput.value = '';
      pinSave.textContent = 'Update PIN';
      pinClear.hidden = false;
      pinPill.hidden = false;
      pinStatus.textContent = 'PIN is set. Login will ask for it.';
      toast('PIN saved. Locked and loaded.', 'success', { emoji: '🔢' });
    } catch (error) {
      pinError.textContent = copy(error, 'Could not save the PIN.');
      pinError.hidden = false;
    } finally {
      pinSave.disabled = false;
    }
  });

  pinClear.addEventListener('click', async () => {
    const ok = await confirmDialog('Clear your PIN?', 'Login will only need username and password. Simpler, slightly less locked.', { confirmLabel: 'Clear it' });
    if (!ok) return;
    pinError.hidden = true;
    try {
      await post('/api/auth/pin', { pin: null });
      user.hasPin = false;
      pinClear.hidden = true;
      pinSave.textContent = 'Set PIN';
      pinPill.hidden = true;
      pinStatus.textContent = 'No PIN set. Add one if your screen is in a chaotic household.';
      toast('PIN cleared. The door is just a door again.', 'success');
    } catch (error) {
      pinError.textContent = copy(error, 'Could not clear the PIN.');
      pinError.hidden = false;
    }
  });

  grid.append(card('Profile PIN', h('div', { class: 'profile-form' },
    pinStatus,
    h('div', { class: 'field' }, h('label', { for: 'profile-pin' }, 'PIN'), pinInput),
    pinError,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, pinClear, pinSave),
  ), { sub: 'extra lock, same account' }));
  // --- Sessions ---------------------------------------------------------
  const sessionsHost = h('div', { class: 'session-list' }, h('div', { class: 'view-loading', style: { minHeight: '80px' } }, h('div', { class: 'spinner' })));
  grid.append(card('Active sessions', sessionsHost, { sub: 'revoke anything suspicious', wide: true }));

  async function loadSessions() {
    try {
      const res = await get('/api/auth/sessions');
      const sessions = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
      if (!sessions.length) {
        sessionsHost.replaceChildren(h('p', { class: 'help' }, 'No sessions listed. Either you are a ghost or the session table is shy.'));
        return;
      }
      sessionsHost.replaceChildren(...sessions.map((session) => {
        const isCurrent = Boolean(session.current);
        const ua = session.userAgent || '';
        const row = h('div', { class: `session-row${isCurrent ? ' current' : ''}` },
          h('span', { class: 'session-icon', 'aria-hidden': 'true' }, /android|iphone|ipad|mobile/i.test(ua) ? '📱' : '💻'),
          h('div', { class: 'session-copy' },
            h('strong', {}, deviceLabel(ua)),
            h('small', {}, [
              session.ip || 'unknown IP',
              session.createdAt ? `started ${fmtRelative(session.createdAt)}` : null,
              session.expiresAt ? `expires ${fmtDate(session.expiresAt)}` : null,
            ].filter(Boolean).join(' · ')),
          ),
          isCurrent ? h('span', { class: 'pill good' }, 'this device') : null,
          h('button', {
            class: `btn small${isCurrent ? ' danger' : ''}`,
            type: 'button',
            onclick: async () => {
              if (isCurrent) {
                const ok = await confirmDialog('Sign out this device?', 'You will be bounced to the login page. Bold move.', { confirmLabel: 'Sign out' });
                if (!ok) return;
              }
              try {
                await del(`/api/auth/sessions/${encodeURIComponent(session.id)}`);
                if (isCurrent) {
                  location.href = '/login';
                  return;
                }
                toast('Session revoked. The door swung shut.', 'success');
                await loadSessions();
              } catch (error) {
                toast(copy(error, 'Could not revoke that session.'), 'error');
              }
            },
          }, isCurrent ? 'Sign out' : 'Revoke'),
        );
        return row;
      }));
    } catch (error) {
      sessionsHost.replaceChildren(h('div', { class: 'stack' },
        h('p', { class: 'form-error' }, copy(error, 'Could not list sessions.')),
        h('button', { class: 'btn small', type: 'button', onclick: loadSessions }, 'Retry'),
      ));
    }
  }
  loadSessions();

  // --- Data & privacy ---------------------------------------------------
  const exportButton = h('button', { class: 'btn', type: 'button' }, '⇩ Export my data');
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    exportButton.textContent = 'Packaging…';
    try {
      const res = await api('/api/users/me/export', { raw: true });
      if (!res.ok) {
        let message = `Export failed (${res.status}).`;
        try {
          const payload = await res.json();
          if (payload?.error?.message) message = payload.error.message;
        } catch { /* non-JSON error body */ }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `aislopmediabox-${user.username}-export.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('Export downloaded. Your data, your rules.', 'success');
    } catch (error) {
      toast(copy(error, 'Could not export your data.'), 'error');
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = '⇩ Export my data';
    }
  });

  const logoutButton = h('button', {
    class: 'btn danger',
    type: 'button',
    onclick: async () => {
      const ok = await confirmDialog('Log out?', 'You will need the password again. Hopefully you remember it.', { confirmLabel: 'Log out' });
      if (!ok) return;
      try {
        await post('/api/auth/logout', {});
      } catch {
        /* even if the call flakes, clearing the cookie is the server's job; head to login */
      }
      location.href = '/login';
    },
  }, 'Log out');

  grid.append(card('Data & privacy', h('div', { class: 'profile-form' },
    h('p', { class: 'muted small' },
      'Everything here lives in this box’s SQLite file. No telemetry, no analytics, no external assets, no shadow profile. '
      + 'Export gives you a raw JSON copy of your progress, favorites, collections, playlists, requests, and sessions.'),
    h('div', { class: 'row wrap' },
      exportButton,
      appState?.user?.role === 'admin'
        ? h('a', { class: 'btn', href: '/admin', target: '_blank', rel: 'noopener' }, 'Admin panel')
        : null,
      logoutButton,
    ),
    h('p', { class: 'help' }, 'Account deletion is an admin action. Ask the council; they are mostly reasonable.'),
  ), { sub: 'yours, locally', wide: true }));

  return () => { /* stateless */ };
}


