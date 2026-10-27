// Users & invites: search, create, role/disable/reset/delete, invite generation.
import { initials } from '../api.js';
import {
  h, adminGet, adminPost, adminPatch, adminDel, pageHead, card, btn, badge, emptyState, errorState,
  skeletonRows, formModal, formGrid, field, textInput, selectInput, confirmDialog, toast, copyToClipboard,
  withBusy, pagination, dataTable, toolbar, fmtNum, fmtAgo, fmtWhen, safeText, apiError, debounce, modal, state,
} from './core.js';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'admin' },
  { value: 'manager', label: 'manager' },
  { value: 'user', label: 'user' },
];
const uiState = { q: '', role: '', page: 1, pageSize: 25 };

function userKey(user) {
  return `@${user.username}`;
}

function avatarCell(user) {
  return h('span', {
    class: 'avatar',
    style: { '--avatar-hue': user.avatarHue ?? 280, width: '30px', height: '30px', fontSize: '12px' },
    'aria-hidden': 'true',
  }, initials(user.displayName || user.username));
}

function createUser(draw) {
  let username = '';
  let displayName = '';
  let password = '';
  let role = 'user';
  const usernameInput = textInput({ value: '', placeholder: 'grease_trap', autocomplete: 'off', onInput: (value) => { username = value; } });
  usernameInput.maxLength = 32;
  const displayNameInput = textInput({ value: '', placeholder: 'Grease Trap', onInput: (value) => { displayName = value; } });
  displayNameInput.maxLength = 40;
  const passwordInput = textInput({ value: '', type: 'password', autocomplete: 'new-password', onInput: (value) => { password = value; } });
  passwordInput.maxLength = 200;
  const body = h('div', {},
    formGrid(
      field('Username', usernameInput, {
        help: 'Letters, numbers, dot, dash, underscore. 2–32 chars.',
      }),
      field('Display name', displayNameInput),
      field('Password', passwordInput, {
        help: '6–200 characters. There is no email recovery — this is a local server.',
      }),
      field('Role', selectInput({ value: role, options: ROLE_OPTIONS, onInput: (value) => { role = value; } }), {
        help: 'Manager can curate media; admin can see this console.',
      }),
    ),
    h('div', { class: 'adm-note' }, 'Accounts are local-only. Passwords are scrypt-hashed on the server; nothing leaves this box.'),
  );
  formModal({
    title: 'Create user',
    body,
    submitLabel: 'Create account',
    onSubmit: async () => {
      const clean = username.trim();
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(clean)) throw new Error('Username must be 2–32 letters, numbers, dot, dash or underscore.');
      if (password.length < 6) throw new Error('Password needs at least 6 characters. Security through vibes has a floor.');
      if (password.length > 200) throw new Error('Password must be 200 characters or fewer.');
      if (displayName.trim().length > 40) throw new Error('Display name must be 40 characters or fewer.');
      await adminPost('/api/admin/users', {
        username: clean,
        displayName: displayName.trim() || clean,
        password,
        role,
      });
      toast(`Account @${clean} created.`, 'success');
      draw();
    },
  });
}

function resetPassword(user, draw) {
  let nextPassword = '';
  const resetInput = textInput({ type: 'password', autocomplete: 'new-password', placeholder: 'blank = generate random', onInput: (value) => { nextPassword = value; } });
  resetInput.maxLength = 200;
  const body = h('div', {},
    h('div', { class: 'adm-note' }, `Resetting @${user.username} revokes their active sessions. Leave the field blank and the server generates a strong password once.`),
    field('New password', resetInput, {
      help: '6–200 characters if you set one manually; blank lets the server generate one.',
    }),
  );
  formModal({
    title: `Reset password — ${userKey(user)}`,
    body,
    submitLabel: 'Reset password',
    danger: true,
    onSubmit: async () => {
      if (nextPassword && nextPassword.length < 6) throw new Error('Manual password needs at least 6 characters.');
      if (nextPassword && nextPassword.length > 200) throw new Error('Manual password must be 200 characters or fewer.');
      const result = await adminPost(`/api/admin/users/${user.id}/reset-password`, nextPassword ? { password: nextPassword } : {});
      if (result?.password) {
        const code = h('div', { class: 'adm-code', style: { fontSize: '13px' } }, result.password);
        modal({
          title: 'New password',
          body: h('div', {},
            h('div', { class: 'adm-note warn' }, 'Copy this now. It will not be shown again, and there is no email recovery on this server.'),
            code,
            h('div', { class: 'row', style: { marginTop: '10px' } },
              btn('Copy password', () => copyToClipboard(result.password, 'Password copied.'), { kind: 'primary' }),
            ),
            h('p', { class: 'faint small' }, `${fmtNum(result.sessionsRevoked || 0)} session(s) revoked.`),
          ),
          actions: [{ label: 'Done' }],
        });
      } else {
        toast(`Password set for @${user.username}. ${fmtNum(result?.sessionsRevoked || 0)} session(s) revoked.`, 'success');
      }
      draw();
    },
  });
}

async function changeRole(user, nextRole, select, me, draw) {
  if (nextRole === user.role) return;
  if (nextRole === 'admin') {
    const ok = await confirmDialog('Grant admin access?', `@${user.username} would get full access to the control room, including user management, logs, and destructive maintenance.`, { confirmLabel: 'Make admin' });
    if (!ok) { select.value = user.role; return; }
  }
  select.disabled = true;
  try {
    await adminPatch(`/api/admin/users/${user.id}`, { role: nextRole });
    toast(`@${user.username} is now ${nextRole}.`, 'success');
    draw();
    if (user.id === me.id) setTimeout(() => location.reload(), 400);
  } catch (error) {
    toast(apiError(error), 'error');
    select.disabled = false;
    select.value = user.role;
  }
}

function usersTable(users, me, draw) {
  const columns = [
    {
      label: 'User',
      render: (user) => h('div', { class: 'row', style: { gap: '9px', minWidth: '160px' } },
        avatarCell(user),
        h('div', { style: { minWidth: 0 } },
          h('strong', { class: 'truncate', style: { display: 'block', fontSize: '12px' } }, user.displayName || user.username),
          h('span', { class: 'mono', style: { color: 'var(--faint)', fontSize: '10px' } }, `${userKey(user)} · #${user.id}`),
        ),
      ),
    },
    {
      label: 'Role',
      render: (user) => {
        const select = selectInput({
          value: user.role, options: ROLE_OPTIONS, disabled: user.id === me.id,
          onInput: (value) => changeRole(user, value, select, me, draw),
        });
        select.style.width = '104px';
        select.style.padding = '5px 8px';
        select.style.fontSize = '11px';
        select.setAttribute('aria-label', `Role for ${user.displayName || user.username}`);
        return select;
      },
    },
    {
      label: 'Status',
      render: (user) => h('div', { class: 'row wrap', style: { gap: '4px' } },
        user.disabled ? badge('disabled', 'disabled') : badge('ok', 'active'),
        user.hasPin ? badge('neutral', 'PIN') : null,
        user.id === me.id ? badge('neutral', 'you') : null,
      ),
    },
    { label: 'Sessions', render: (user) => h('span', { class: 'num' }, fmtNum(user.activeSessions ?? 0)) },
    { label: 'Created', render: (user) => h('span', { class: 'num', title: fmtWhen(user.createdAt) }, fmtAgo(user.createdAt)) },
    { label: 'Last login', render: (user) => h('span', { class: 'num', title: fmtWhen(user.lastLoginAt) }, user.lastLoginAt ? fmtAgo(user.lastLoginAt) : 'never') },
    {
      label: 'Actions',
      className: 'nowrap',
      render: (user) => h('div', { class: 'actions' },
        btn(user.disabled ? 'Enable' : 'Disable', async () => {
          if (user.id === me.id) { toast('You cannot disable yourself. Nice try though.', 'error'); return; }
          const nowDisabled = !user.disabled;
          const ok = await confirmDialog(
            nowDisabled ? `Disable @${user.username}?` : `Re-enable @${user.username}?`,
            nowDisabled ? 'Active sessions stop working on their next request. Existing sessions are not deleted automatically unless the server does it — but the account can no longer log in.' : 'The account can log in again.',
            { confirmLabel: nowDisabled ? 'Disable account' : 'Enable account', danger: nowDisabled },
          );
          if (!ok) return;
          try {
            await adminPatch(`/api/admin/users/${user.id}`, { disabled: nowDisabled });
            toast(nowDisabled ? 'Account disabled.' : 'Account re-enabled.', 'success');
            draw();
          } catch (error) { toast(apiError(error), 'error'); }
        }, { small: true }),
        btn('Reset password', () => resetPassword(user, draw), { small: true }),
        btn('Delete', async () => {
          if (user.id === me.id) { toast('Deleting yourself is a skill issue. Use the profile page.', 'error'); return; }
          const ok = await confirmDialog(
            `Delete @${user.username}?`,
            `This removes the account (role ${user.role}) and its sessions, progress, favorites and requests attribution. The last admin cannot be deleted, and the server will refuse if that would lock everyone out.`,
            { confirmLabel: 'Delete account', danger: true },
          );
          if (!ok) return;
          try {
            await adminDel(`/api/admin/users/${user.id}`);
            toast('Account deleted.', 'success');
            draw();
          } catch (error) { toast(apiError(error), 'error'); }
        }, { kind: 'danger', small: true }),
      ),
    },
  ];
  return dataTable({
    columns,
    rows: users,
    caption: 'Accounts',
    empty: emptyState('No users match', 'Try a different search or role filter. The void has no accounts.', { emoji: '👤' }),
  });
}

function invitesCard(invites, draw) {
  let role = 'user';
  let ttlHours = 72;
  const generate = async (event) => {
    await withBusy(event.currentTarget, async () => {
      try {
        const result = await adminPost('/api/admin/invites', { role, ttlHours });
        const invite = result?.invite || result;
        const code = invite?.code;
        if (!code) throw new Error('Invite created but the server returned no code.');
        const codeNode = h('div', { class: 'adm-code', style: { fontSize: '15px', letterSpacing: '0.08em' } }, code);
        modal({
          title: 'Invite created',
          body: h('div', {},
            h('div', { class: 'adm-note' }, 'Share this code out-of-band. Treat it like a password: it can create one account with the assigned role until it expires or is used.'),
            codeNode,
            h('div', { class: 'row', style: { marginTop: '10px' } },
              btn('Copy code', () => copyToClipboard(code, 'Invite code copied.'), { kind: 'primary' }),
            ),
            h('p', { class: 'faint small' }, `Role ${invite.role || role} · expires ${fmtWhen(invite.expiresAt)}`),
          ),
          actions: [{ label: 'Done' }],
        });
        toast('Invite generated.', 'success');
        draw();
      } catch (error) {
        toast(apiError(error), 'error');
      }
    }, 'Generating…');
  };
  const columns = [
    {
      label: 'Code',
      render: (invite) => h('div', { class: 'row', style: { gap: '6px' } },
        h('span', { class: 'mono', style: { fontWeight: 700, letterSpacing: '0.05em' } }, safeText(invite.code)),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => copyToClipboard(invite.code, 'Invite code copied.'), 'aria-label': `Copy invite ${invite.code}` }, 'Copy'),
      ),
    },
    { label: 'Role', render: (invite) => badge('neutral', invite.role) },
    {
      label: 'Status',
      render: (invite) => invite.usedAt
        ? badge('neutral', 'used')
        : invite.expired ? badge('error', 'expired') : badge('ok', 'valid'),
    },
    { label: 'Created by', render: (invite) => safeText(invite.createdBy?.username ? `@${invite.createdBy.username}` : '—') },
    { label: 'Expires', render: (invite) => h('span', { class: 'num' }, invite.expiresAt ? fmtWhen(invite.expiresAt) : 'never') },
    { label: 'Used by', render: (invite) => safeText(invite.usedBy?.username ? `@${invite.usedBy.username}` : '—') },
    {
      label: 'Actions',
      render: (invite) => h('div', { class: 'actions' },
        btn('Delete', async () => {
          const ok = await confirmDialog(`Delete invite ${invite.code}?`, invite.usedAt ? 'This invite was already used; deleting the record only cleans up history.' : 'The code stops working immediately.', { confirmLabel: 'Delete invite', danger: true });
          if (!ok) return;
          try { await adminDel(`/api/admin/invites/${invite.id}`); toast('Invite deleted.', 'success'); draw(); } catch (error) { toast(apiError(error), 'error'); }
        }, { kind: 'danger', small: true }),
      ),
    },
  ];
  return card('Invites', [
    h('div', { class: 'row wrap', style: { marginBottom: '12px', gap: '8px' } },
      selectInput({ value: role, options: [{ value: 'user', label: 'user' }, { value: 'manager', label: 'manager' }], onInput: (value) => { role = value; } }),
      selectInput({ value: String(ttlHours), options: [1, 24, 72, 168, 720].map((hours) => ({ value: String(hours), label: hours >= 24 ? `${hours / 24} day${hours / 24 === 1 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}` })), onInput: (value) => { ttlHours = Number(value); } }),
      btn('Generate invite', generate, { kind: 'primary', iconText: '＋' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'faint small' }, `${fmtNum(invites.length)} total`),
    ),
    dataTable({
      columns,
      rows: invites,
      caption: 'Invite codes',
      empty: emptyState('No invites', 'Generate one if signups are closed and require-invite is on. Or let people in — your call.', { emoji: '✉' }),
    }),
    h('div', { class: 'adm-note', style: { marginTop: '10px' } }, 'Invites only matter when Access → “Require invite” is enabled. Admins can always create accounts directly here.'),
  ], { sub: 'out-of-band onboarding' });
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(7)));
    const me = { id: state.user?.id ?? -1, username: state.user?.username || '' };
    const draw = async () => {
      const params = new URLSearchParams({ page: String(uiState.page), pageSize: String(uiState.pageSize) });
      if (uiState.q) params.set('q', uiState.q);
      if (uiState.role) params.set('role', uiState.role);
      try {
        const [usersRes, invitesRes] = await Promise.all([
          adminGet(`/api/admin/users?${params.toString()}`, { signal: ctx.signal }),
          adminGet('/api/admin/invites', { signal: ctx.signal }),
        ]);
        const users = usersRes?.items || [];
        const total = usersRes?.total ?? users.length;
        const byRole = usersRes?.byRole || {};
        const invites = invitesRes?.items || [];
        const search = textInput({
          value: uiState.q, placeholder: 'Search username or display name…',
          onInput: debounce((value) => { uiState.q = value; uiState.page = 1; draw(); }, 300),
        });
        search.classList.add('grow');
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Users', `${fmtNum(total)} accounts · ${fmtNum(byRole.admin)} admin · ${fmtNum(byRole.manager)} manager · ${fmtNum(byRole.user)} user`, [
            btn('Create user', () => createUser(draw), { kind: 'primary', iconText: '＋' }),
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          toolbar([
            search,
            (() => {
              const roleFilter = selectInput({ value: uiState.role, options: [{ value: '', label: 'All roles' }, ...ROLE_OPTIONS], onInput: (value) => { uiState.role = value; uiState.page = 1; draw(); } });
              roleFilter.setAttribute('aria-label', 'Filter by role');
              return roleFilter;
            })(),
            (() => {
              const size = selectInput({ value: String(uiState.pageSize), options: [10, 25, 50, 100].map((n) => ({ value: String(n), label: `${n} per page` })), onInput: (value) => { uiState.pageSize = Number(value); uiState.page = 1; draw(); } });
              size.setAttribute('aria-label', 'Users per page');
              return size;
            })(),
          ]),
          usersTable(users, me, draw),
          pagination({ page: usersRes?.page ?? uiState.page, pageSize: usersRes?.pageSize ?? uiState.pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          invitesCard(invites, draw),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Users', 'Accounts, roles and invites'),
          errorState(error, draw, { title: 'Users did not load' }),
        ));
      }
    };
    await draw();
  },
};
