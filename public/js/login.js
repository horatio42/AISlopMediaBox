// Standalone auth page. No app shell, no framework, no funny business.
import { get, post } from './api.js';

const els = {
  artBrandName: document.getElementById('art-brand-name'),
  artTagline: document.getElementById('art-tagline'),
  mobileBrandName: document.getElementById('mobile-brand-name'),
  kicker: document.getElementById('auth-kicker'),
  title: document.getElementById('auth-title'),
  sub: document.getElementById('auth-sub'),
  alert: document.getElementById('auth-alert'),
  form: document.getElementById('auth-form'),
  username: document.getElementById('username'),
  usernameError: document.getElementById('username-error'),
  password: document.getElementById('password'),
  passwordError: document.getElementById('password-error'),
  passwordToggle: document.getElementById('password-toggle'),
  displayNameField: document.getElementById('display-name-field'),
  displayName: document.getElementById('display-name'),
  displayNameError: document.getElementById('display-name-error'),
  inviteField: document.getElementById('invite-field'),
  invite: document.getElementById('invite'),
  inviteStatus: document.getElementById('invite-status'),
  pinField: document.getElementById('pin-field'),
  pin: document.getElementById('pin'),
  submit: document.getElementById('auth-submit'),
  submitLabel: document.getElementById('auth-submit-label'),
  spinner: document.getElementById('auth-spinner'),
  authSwitch: document.getElementById('auth-switch'),
  authSwitchText: document.getElementById('auth-switch-text'),
  modeToggle: document.getElementById('mode-toggle'),
  signupClosed: document.getElementById('signup-closed'),
  demoHint: document.getElementById('demo-hint'),
  homeLink: document.getElementById('home-link'),
};

const params = new URLSearchParams(location.search);
const nextTarget = safeNext(params.get('next'));

let branding = {
  serverName: 'AISlopMediaBox',
  tagline: 'Certified fresh slop, served locally.',
  allowSignups: false,
  requireInvite: true,
  demoMode: false,
};
let mode = 'login';
let submitting = false;
let inviteCheckController = null;
let inviteTimer = null;

function safeNext(raw) {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return '/';
    if (url.pathname === '/login') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

function text(node, value) {
  if (node) node.textContent = value ?? '';
}

function setAlert(message, kind = 'error') {
  if (!els.alert) return;
  if (!message) {
    els.alert.hidden = true;
    els.alert.textContent = '';
    return;
  }
  els.alert.textContent = message;
  els.alert.dataset.kind = kind;
  els.alert.hidden = false;
}

function setFieldError(input, errorNode, message) {
  const field = input?.closest('.field');
  if (message) {
    field?.classList.add('invalid');
    input?.setAttribute('aria-invalid', 'true');
    if (errorNode) {
      errorNode.textContent = message;
      errorNode.hidden = false;
    }
  } else {
    field?.classList.remove('invalid');
    input?.removeAttribute('aria-invalid');
    if (errorNode) {
      errorNode.textContent = '';
      errorNode.hidden = true;
    }
  }
}

function clearErrors() {
  setAlert('');
  setFieldError(els.username, els.usernameError, '');
  setFieldError(els.password, els.passwordError, '');
  setFieldError(els.displayName, els.displayNameError, '');
}

function setLoading(loading) {
  submitting = loading;
  if (els.submit) els.submit.disabled = loading;
  if (els.spinner) els.spinner.hidden = !loading;
  if (els.submitLabel) els.submitLabel.textContent = loading
    ? (mode === 'register' ? 'Summoning your account…' : 'Checking your vibes…')
    : (mode === 'register' ? 'Create account' : 'Sign in');
  els.form?.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function setMode(nextMode) {
  mode = nextMode;
  const register = mode === 'register';
  if (els.displayNameField) els.displayNameField.hidden = !register;
  if (els.inviteField) els.inviteField.hidden = !(register && branding.requireInvite);
  if (els.pinField) els.pinField.hidden = true;
  if (els.password) els.password.autocomplete = register ? 'new-password' : 'current-password';
  if (els.password) els.password.minLength = register ? 6 : 1;
  text(els.kicker, register ? 'fresh meat' : 'members only');
  text(els.title, register ? 'Join the slop.' : 'Get in, slopper.');
  text(els.sub, register
    ? 'Make an account. Bring snacks. The library is warm.'
    : 'Your media server, your rules. Zero cloud, zero snitching.');
  text(els.authSwitchText, register ? 'Already certified?' : 'New here?');
  text(els.modeToggle, register ? 'Sign in instead' : 'Create an account');
  if (els.submitLabel) els.submitLabel.textContent = register ? 'Create account' : 'Sign in';
  clearErrors();
  setLoading(false);
  const focusTarget = register ? els.username : els.username;
  window.setTimeout(() => focusTarget?.focus(), 30);
  const url = new URL(location.href);
  if (register) url.searchParams.set('mode', 'register');
  else url.searchParams.delete('mode');
  history.replaceState(null, '', `${url.pathname}${url.search}`);
}

function applyBranding(data) {
  branding = { ...branding, ...(data || {}) };
  const name = branding.serverName || 'AISlopMediaBox';
  text(els.artBrandName, name);
  text(els.mobileBrandName, name);
  text(els.artTagline, branding.tagline || 'Certified fresh slop, served locally.');
  document.title = `Sign in — ${name}`;

  const canRegister = Boolean(branding.allowSignups);
  if (els.authSwitch) els.authSwitch.hidden = !canRegister;
  if (els.signupClosed) els.signupClosed.hidden = canRegister;
  if (els.demoHint) {
    els.demoHint.hidden = !branding.demoMode;
    if (branding.demoMode) {
      els.demoHint.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = 'Demo box';
      const span = document.createElement('span');
      span.textContent = 'username admin · password slop123';
      els.demoHint.append(strong, span);
    }
  }
  if (els.homeLink) els.homeLink.href = '/';

  const requested = params.get('mode') === 'register' && canRegister;
  setMode(requested ? 'register' : 'login');
}

function validate() {
  clearErrors();
  const username = els.username.value.trim();
  const password = els.password.value;
  const register = mode === 'register';
  let ok = true;

  if (!username) {
    setFieldError(els.username, els.usernameError, 'Username required. Even goblins have names.');
    ok = false;
  } else if (register && username.length < 2) {
    setFieldError(els.username, els.usernameError, 'At least 2 characters. Give us something.');
    ok = false;
  } else if (register && !/^[a-zA-Z0-9_.-]+$/.test(username)) {
    setFieldError(els.username, els.usernameError, 'Letters, numbers, dot, dash, underscore only.');
    ok = false;
  }

  if (!password) {
    setFieldError(els.password, els.passwordError, 'Password required. Security through vibes is not enough.');
    ok = false;
  } else if (register && password.length < 6) {
    setFieldError(els.password, els.passwordError, 'Six characters minimum. Make it slightly cursed.');
    ok = false;
  }

  if (register && !els.inviteField.hidden && !els.invite.value.trim()) {
    setAlert('An invite code is required. The council is strict about this one.');
    ok = false;
  }

  if (!els.pinField.hidden) {
    const pin = els.pin.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setAlert('PIN must be 4–8 digits. Numbers, not vibes.');
      ok = false;
    }
  }

  if (!ok) els.form.querySelector('.invalid input')?.focus();
  return ok;
}

async function submit(event) {
  event?.preventDefault();
  if (submitting || !validate()) return;
  setLoading(true);
  setAlert('');
  const username = els.username.value.trim();
  const password = els.password.value;
  try {
    if (mode === 'register') {
      const body = { username, password };
      const displayName = els.displayName.value.trim();
      if (displayName) body.displayName = displayName;
      if (!els.inviteField.hidden) body.invite = els.invite.value.trim();
      await post('/api/auth/register', body);
    } else {
      const body = { username, password };
      if (!els.pinField.hidden) body.pin = els.pin.value.trim();
      await post('/api/auth/login', body);
    }
    location.replace(nextTarget);
  } catch (error) {
    handleAuthError(error);
  } finally {
    setLoading(false);
  }
}

function handleAuthError(error) {
  const code = error?.code;
  if (code === 'pin_required') {
    const retry = els.pinField && !els.pinField.hidden;
    if (els.pinField) els.pinField.hidden = false;
    setAlert(retry ? 'That PIN did not work. Try again, carefully.' : 'PIN required for this profile. Punch it in.', 'info');
    els.pin?.focus();
    els.pin?.select();
    return;
  }
  if (code === 'invite_required' || code === 'invite_invalid') {
    if (els.inviteField) els.inviteField.hidden = false;
    setAlert(error.message || 'Invite is invalid, used, or expired. L.');
    els.invite?.focus();
    return;
  }
  if (code === 'signups_closed') {
    if (els.authSwitch) els.authSwitch.hidden = true;
    if (els.signupClosed) els.signupClosed.hidden = false;
    setAlert(error.message || 'Signups are closed.');
    return;
  }
  if (code === 'invalid_credentials') {
    setFieldError(els.password, els.passwordError, 'Wrong credentials. Skill issue.');
    setAlert(error.message || 'Wrong credentials. Skill issue.');
    els.password?.select();
    return;
  }
  if (code === 'account_disabled') {
    setAlert(error.message || 'This account is banned by the slop council.');
    return;
  }
  setAlert(error?.message || 'Login failed. The slop is having a moment. Try again.');
}

function togglePassword() {
  const showing = els.password.type === 'text';
  els.password.type = showing ? 'password' : 'text';
  els.passwordToggle.textContent = showing ? 'Show' : 'Hide';
  els.passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  els.passwordToggle.setAttribute('aria-pressed', String(!showing));
  els.password.focus({ preventScroll: true });
}

function scheduleInviteCheck() {
  window.clearTimeout(inviteTimer);
  if (inviteCheckController) inviteCheckController.abort();
  const code = els.invite.value.trim();
  if (!code) {
    text(els.inviteStatus, '');
    els.inviteStatus.dataset.state = '';
    return;
  }
  text(els.inviteStatus, 'Checking invite…');
  els.inviteStatus.dataset.state = 'checking';
  inviteTimer = window.setTimeout(async () => {
    inviteCheckController = new AbortController();
    try {
      const res = await get(`/api/auth/invites/check/${encodeURIComponent(code)}`, { signal: inviteCheckController.signal });
      const valid = Boolean(res?.valid);
      text(els.inviteStatus, valid ? 'Invite looks good. Welcome, allegedly.' : 'Invite invalid, used, or expired.');
      els.inviteStatus.dataset.state = valid ? 'good' : 'bad';
    } catch (error) {
      if (error?.name === 'AbortError') return;
      text(els.inviteStatus, '');
      els.inviteStatus.dataset.state = '';
    }
  }, 420);
}

function bind() {
  els.form?.addEventListener('submit', submit);
  els.passwordToggle?.addEventListener('click', togglePassword);
  els.modeToggle?.addEventListener('click', () => {
    setMode(mode === 'register' ? 'login' : 'register');
    const url = new URL(location.href);
    if (mode === 'register') url.searchParams.set('mode', 'register');
    else url.searchParams.delete('mode');
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  });
  els.invite?.addEventListener('input', scheduleInviteCheck);
  els.username?.addEventListener('input', () => setFieldError(els.username, els.usernameError, ''));
  els.password?.addEventListener('input', () => setFieldError(els.password, els.passwordError, ''));
  els.displayName?.addEventListener('input', () => setFieldError(els.displayName, els.displayNameError, ''));
  els.pin?.addEventListener('input', () => {
    els.pin.value = els.pin.value.replace(/\D/g, '').slice(0, 8);
  });
  for (const input of [els.username, els.password, els.pin]) {
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }
}

async function init() {
  try {
    const savedTheme = localStorage.getItem('slop-theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  } catch { /* private mode: default theme is fine */ }

  bind();

  try {
    const [brandingData, session] = await Promise.allSettled([get('/api/branding'), get('/api/auth/me')]);
    if (brandingData.status === 'fulfilled' && brandingData.value) applyBranding(brandingData.value);
    else setMode('login');
    const me = session.status === 'fulfilled' ? session.value : null;
    if (me?.authenticated) {
      location.replace(nextTarget);
      return;
    }
  } catch {
    setMode('login');
    setAlert('Could not load server settings. Logging in might still work — bold move either way.', 'info');
  }
}

init();
