// Party: landing/join/create, member roster, now-playing card, host transport,
// invite link, leave/end, and live party.sync tracking over SSE.
import { get, post, del, fmtClock, fmtDuration, fmtRelative, initials, artFor, connectEvents, copyText } from '../api.js';
import { h, toast, confirmDialog } from '../ui.js';

const MAX_MEMBERS = 20;

function partyArt(party) {
  const media = party?.media;
  if (!media) return '';
  return media.art?.backdrop || media.art?.poster || artFor(media, 'poster');
}

function mediaMeta(media) {
  if (!media) return 'no media attached';
  const bits = [];
  if (media.kind === 'episode' && media.seasonNumber != null) bits.push(`S${String(media.seasonNumber).padStart(2, '0')}E${String(media.episodeNumber || 0).padStart(2, '0')}`);
  if (media.year) bits.push(String(media.year));
  if (media.durationSeconds || media.runtimeSeconds) bits.push(fmtDuration(media.durationSeconds || media.runtimeSeconds));
  if (media.contentRating) bits.push(media.contentRating);
  return bits.join(' · ') || media.kind || 'playable thing';
}

function memberName(member) {
  return member.displayName || member.username || 'anon slopper';
}

function avatarStyle(hue) {
  return `--avatar-hue:${Number.isFinite(Number(hue)) ? Number(hue) : 280}`;
}

export default async function render(container, ctx) {
  const routeId = String(ctx.params.id || '');
  const pathname = String(window.location.pathname || '').replace(/\/+$/, '');
  const id = routeId || (pathname === '/party/new' ? 'new' : '');
  const isNewRoute = id === 'new' || id === 'create';
  if (!id || isNewRoute) return renderCreate(container, ctx, { landing: !isNewRoute });
  return renderPartyPage(container, ctx, id);
}

async function renderCreate(container, ctx, { landing = false } = {}) {
  const abort = new AbortController();
  const [meResult, partiesResult] = await Promise.allSettled([
    get('/api/auth/me', { signal: ctx.signal }),
    get('/api/parties?pageSize=12', { signal: ctx.signal }),
  ]);
  if (ctx.signal?.aborted) return undefined;
  const me = meResult.status === 'fulfilled' ? meResult.value : null;
  const parties = partiesResult.status === 'fulfilled'
    ? partiesResult.value?.items || partiesResult.value?.parties || []
    : [];

  document.title = landing ? 'Watch parties — AISlopMediaBox' : 'New party — AISlopMediaBox';
  let selected = null;
  let searchTimer = null;
  const results = h('div', { class: 'party-search-results' });
  const selectedBox = h('div', { class: 'party-selected', hidden: true });
  const nameInput = h('input', {
    class: 'input', type: 'text', maxlength: '80', required: true,
    value: `${me?.user?.displayName || 'A slopper'}'s certified watch party`,
    placeholder: 'Party name',
  });
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search movies…', autocomplete: 'off' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create party');
  const error = h('div', { class: 'form-error', role: 'alert', hidden: true });

  function setSelected(item) {
    selected = item;
    selectedBox.hidden = !item;
    selectedBox.replaceChildren(item
      ? h('div', { class: 'row' },
        h('img', { class: 'party-selected-art', src: artFor(item, 'poster'), alt: '', loading: 'lazy' }),
        h('div', { class: 'stack', style: { gap: '2px' } },
          h('strong', {}, item.title),
          h('span', { class: 'muted small' }, mediaMeta(item))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Clear selection', onclick: () => setSelected(null) }, '✕'))
      : []);
  }

  function showResults(items) {
    results.replaceChildren(...items.map((item) => h('button', {
      class: `party-search-hit${selected?.id === item.id ? ' active' : ''}`,
      type: 'button',
      onclick: () => { setSelected(item); results.replaceChildren(); searchInput.value = item.title; },
    },
      h('img', { src: artFor(item, 'thumb'), alt: '', loading: 'lazy' }),
      h('span', { class: 'stack', style: { gap: '0' } }, h('strong', {}, item.title), h('span', { class: 'faint small' }, mediaMeta(item))))));
  }

  async function search(query) {
    try {
      const data = query
        ? await get(`/api/browse?q=${encodeURIComponent(query)}&kind=movie&pageSize=8`, { signal: abort.signal })
        : await get('/api/browse?kind=movie&pageSize=8&sort=added', { signal: abort.signal });
      const items = data?.items || data?.rows?.find?.((row) => row.kind === 'movie')?.items || [];
      showResults(items);
    } catch (errorCaught) {
      if (errorCaught.name !== 'AbortError') results.replaceChildren(h('p', { class: 'muted small' }, 'Search said no. Try a different title.'));
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(searchInput.value.trim()), 260);
  }, { signal: abort.signal });
  const form = h('form', {
    class: 'party-create card pad-lg',
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!selected) {
        error.hidden = false;
        error.textContent = 'Pick something to watch first. A party with no media is just a group chat.';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Creating…';
      try {
        const created = await post('/api/parties', {
          name: nameInput.value.trim() || 'Certified watch party',
          mediaId: selected.id,
        });
        const party = created?.party || created;
        if (!party?.id) throw new Error('The server forgot to return a party id.');
        toast('Party created. Invite the sloppers.', 'success', { emoji: '🎉' });
        ctx.navigate(`/party/${party.id}`);
      } catch (errorCaught) {
        submit.disabled = false;
        submit.textContent = 'Create party';
        error.hidden = false;
        error.textContent = errorCaught.message || 'Could not create party.';
      }
    },
  },
    h('span', { class: 'eyebrow' }, 'new party'),
    h('h1', { class: 'party-create-title' }, 'Start a watch party'),
    h('p', { class: 'muted' }, 'Everyone follows the host. One person has the remote, everyone else seethes quietly.'),
    h('div', { class: 'field' }, h('label', { for: 'party-name' }, 'Party name'), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'party-search' }, 'What are we watching?'), searchInput, results, selectedBox),
    error,
    h('div', { class: 'row wrap' },
      submit,
      h('a', { class: 'btn ghost', href: '/', 'data-link': true }, 'Never mind')),
  );
  nameInput.id = 'party-name';
  searchInput.id = 'party-search';

  const activeSection = h('section', { class: 'party-active' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Active parties'),
      parties.length ? h('span', { class: 'count' }, `${parties.length} live`) : null,
      h('span', { class: 'party-active-hint faint small' }, 'jump in, the host has the remote')),
    parties.length
      ? h('div', { class: 'party-active-grid' }, ...parties.map(activePartyCard))
      : h('div', { class: 'party-active-empty' },
        h('span', { class: 'party-active-emoji', 'aria-hidden': 'true' }, '🪑'),
        h('strong', {}, 'No parties running. The couch is cold.'),
        h('span', { class: 'muted small' }, 'Start one below. Bring snacks and a questionable movie.')));

  container.replaceChildren(h('div', { class: 'party-view party-create-view' },
    h('a', { class: 'mini-link party-back', href: '/', 'data-link': true }, '‹ Back to home'),
    activeSection,
    form,
    h('aside', { class: 'party-create-side card' },
      h('div', { class: 'eyebrow' }, 'house rules'),
      h('ul', { class: 'party-rules' },
        h('li', {}, `Max ${MAX_MEMBERS} attendees. More than that is a convention.`),
        h('li', {}, 'Host controls play, pause, and seek. Everyone else follows.'),
        h('li', {}, 'No spoilers in chat that does not exist yet.'),
        h('li', {}, 'The invite link opens the player in party mode.')))));

  search('');
  return () => { abort.abort(); clearTimeout(searchTimer); };
}

function activePartyCard(party) {
  const media = party.media;
  const hostName = party.host ? memberName(party.host) : 'someone';
  const watching = Number(party.memberCount ?? party.members?.length ?? 0);
  const art = partyArt(party);
  return h('a', {
    class: 'party-active-card', href: `/party/${party.id}`, 'data-link': true, 'data-focus': true,
    'aria-label': `Join ${party.name || 'party'}${media ? `, watching ${media.title}` : ''}`,
  },
    h('div', { class: 'party-active-art', style: art ? { backgroundImage: `url("${art}")` } : undefined }),
    h('div', { class: 'party-active-copy' },
      h('strong', { class: 'truncate' }, party.name || 'Untitled party'),
      h('span', { class: 'truncate muted small' }, media?.title || 'no media attached'),
      h('span', { class: 'faint small truncate' }, `${hostName} hosting · ${watching}/${MAX_MEMBERS} watching`)),
    h('span', { class: 'pill accent' }, 'Join'));
}

async function renderPartyPage(container, ctx, id) {
  const abort = new AbortController();
  const timers = new Set();
  const every = (fn, ms) => {
    const timer = setInterval(() => { if (!abort.signal.aborted) fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  container.replaceChildren(h('div', { class: 'party-loading' }, h('span', { class: 'spinner' }), 'finding the party…'));

  const [partyResult, meResult] = await Promise.allSettled([
    get(`/api/parties/${encodeURIComponent(id)}`, { signal: ctx.signal }),
    get('/api/auth/me', { signal: ctx.signal }),
  ]);
  if (ctx.signal?.aborted) return undefined;
  const partyRaw = partyResult.status === 'fulfilled' ? partyResult.value : null;
  const party = partyRaw?.party || partyRaw;
  const me = meResult.status === 'fulfilled' ? meResult.value?.user || meResult.value : null;

  if (!party?.id) {
    const status = partyRaw?.status || (partyResult.status === 'rejected' ? partyResult.reason?.status : null);
    const body = h('div', { class: 'party-landing' },
      h('div', { class: 'party-landing-emoji', 'aria-hidden': 'true' }, status === 404 ? '🫥' : '🎉'),
      h('span', { class: 'eyebrow' }, status === 404 ? '404 · party not found' : 'party unavailable'),
      h('h1', {}, status === 404 ? 'This party left the group chat.' : 'The party could not load.'),
      h('p', { class: 'muted' }, status === 404
        ? 'The invite may be stale, or the host rage-quit. Start a new one — hosting is easy and mostly harmless.'
        : partyResult.reason?.message || 'The party API threw a tantrum.'),
      h('div', { class: 'row wrap', style: { justifyContent: 'center' } },
        h('a', { class: 'btn primary', href: '/party/new', 'data-link': true }, 'Start a party'),
        h('a', { class: 'btn', href: '/', 'data-link': true }, 'Back home')),
    );
    container.replaceChildren(body);
    return () => abort.abort();
  }

  document.title = `${party.name || 'Watch party'} — party`;
  let media = party.media || null;
  if (!media && party.mediaId) {
    try {
      const detail = await get(`/api/media/${party.mediaId}`, { signal: ctx.signal });
      media = detail?.item || null;
    } catch { media = null; }
  }

  const isHost = party.isHost === true;
  let members = Array.isArray(party.members) ? party.members.slice() : [];
  let ended = party.isActive === false;
  const sync = {
    position: Number(party.position) || 0,
    paused: Boolean(party.paused),
    updatedAt: Date.now(),
    lastSync: Date.now(),
  };
  const duration = Number(media?.durationSeconds || media?.runtimeSeconds) || 0;
  const meId = me?.id;
  let isMember = isHost || members.some((member) => String(member.userId) === String(meId));
  let lastPublish = 0;
  let publishTimer = null;
  let events = null;

  const currentPosition = () => {
    if (ended) return duration ? duration : sync.position;
    if (sync.paused) return sync.position;
    const elapsed = Math.max(0, (Date.now() - sync.updatedAt) / 1000);
    return Math.min(duration || Infinity, sync.position + elapsed);
  };

  // build page
  const memberList = h('div', { class: 'party-member-list' });
  const statusPill = h('span', { class: 'pill' }, ended ? 'ended' : sync.paused ? 'paused' : 'playing');
  const hostPositionText = h('span', { class: 'party-sync-position mono' }, '0:00');
  const syncPositionText = h('span', { class: 'party-sync-position mono' }, '0:00');
  const progressFill = h('i', {});
  const progressBar = h('div', { class: 'party-progress-bar', role: 'progressbar', 'aria-label': 'Party playback position' }, progressFill);
  const lastSyncText = h('span', {}, 'just now');
  const playToggle = h('button', {
    class: 'icon-round party-play', type: 'button', 'aria-label': sync.paused ? 'Play party' : 'Pause party',
    onclick: () => togglePartyPause(),
  }, sync.paused ? '▶' : '❚❚');
  const seek = h('input', {
    type: 'range', class: 'party-seek', min: '0', max: String(Math.max(0, duration)), step: '0.5',
    value: String(sync.position), 'aria-label': 'Party seek position',
    oninput: () => {
      hostPositionText.textContent = `${fmtClock(Number(seek.value))}${duration ? ` / ${fmtClock(duration)}` : ''}`;
      progressFill.style.width = duration ? `${Math.min(100, (Number(seek.value) / duration) * 100)}%` : '0%';
    },
    onchange: () => hostSeek(Number(seek.value)),
  });
  const hostControls = h('div', { class: 'party-host-controls' },
    playToggle,
    h('div', { class: 'party-seek-wrap' },
      h('div', { class: 'row between' }, h('span', { class: 'eyebrow' }, 'host transport'), hostPositionText),
      seek,
      h('p', { class: 'faint small' }, 'Publishes to every follower, throttled so we do not DDOS the party bus.')),
  );
  const joinBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => joinParty() }, 'Join the slop');
  const inviteBtn = h('button', { class: 'btn', type: 'button', onclick: () => copyInvite() }, 'Copy invite link');
  const actions = h('div', { class: 'row wrap party-actions' },
    ended ? h('a', { class: 'btn primary', href: '/party/new', 'data-link': true }, 'Start a new party') : null,
    media ? h('a', { class: `btn${ended ? '' : ' primary'}`, href: ended ? `/watch/${media.id}` : `/watch/${media.id}?party=${encodeURIComponent(party.id)}`, 'data-link': true }, ended ? 'Watch solo' : '▶ Watch together') : null,
    !ended && !isMember ? joinBtn : null,
    inviteBtn,
    !ended && !isHost && isMember ? h('button', { class: 'btn ghost', type: 'button', onclick: () => leaveParty() }, 'Leave') : null,
    !ended && isHost ? h('button', { class: 'btn danger', type: 'button', onclick: () => endParty() }, 'End party') : null,
  );

  const nowPlaying = h('section', { class: 'party-nowplaying' },
    h('div', { class: 'party-art', style: { backgroundImage: partyArt(party) ? `url("${partyArt(party)}")` : undefined } }),
    h('div', { class: 'party-np-shade' }),
    h('div', { class: 'party-np-copy' },
      h('span', { class: 'eyebrow' }, 'now playing'),
      h('h2', {}, media?.title || 'No media attached'),
      h('p', { class: 'party-np-meta' }, media ? mediaMeta(media) : 'The host has not picked anything yet. Awkward.'),
      media?.description ? h('p', { class: 'party-np-desc clamp-3' }, media.description) : null,
      h('div', { class: 'party-progress' }, progressBar, h('div', { class: 'row between small faint' }, h('span', {}, `${isHost ? 'you control' : 'host controls'} the timeline`), h('span', {}, duration ? fmtClock(duration) : 'live'))),
      isHost ? hostControls : h('p', { class: 'party-follower-note muted small' }, 'This is a spectator sport. The host has the remote. Watch together opens the synced player.'),
      h('div', { class: 'party-np-actions' }, actions),
    ),
  );

  const membersCard = h('section', { class: 'card party-members' },
    h('div', { class: 'card-title' }, h('h3', {}, 'Sloppers in the room'), h('span', { class: 'pill' }, `${members.length}/${MAX_MEMBERS}`)),
    memberList,
  );
  const syncCard = h('section', { class: 'card party-sync-card' },
    h('div', { class: 'card-title' }, h('h3', {}, 'Party sync'), statusPill),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Position'), h('dd', {}, syncPositionText),
      h('dt', {}, 'Duration'), h('dd', {}, duration ? fmtClock(duration) : 'unknown'),
      h('dt', {}, 'Last sync'), h('dd', {}, lastSyncText),
      h('dt', {}, 'Party ID'), h('dd', { class: 'mono small' }, party.id)),
    h('p', { class: 'faint small' }, isHost ? 'You are the host. Your play/pause/seek publishes party.sync to every follower.' : 'Following the host over party.sync. Drift gets corrected automatically.'));

  const endedBanner = h('div', { class: 'party-ended-banner', hidden: !ended },
    h('span', { 'aria-hidden': 'true' }, '🫡'), h('strong', {}, 'This party ended.'), h('span', { class: 'muted' }, 'The stream is over. The memories remain.'));

  const shell = h('div', { class: 'party-view' },
    h('header', { class: 'party-head' },
      h('a', { class: 'mini-link party-back', href: '/', 'data-link': true }, '‹ home'),
      h('div', { class: 'party-head-copy' },
        h('span', { class: 'eyebrow' }, 'watch party'),
        h('h1', { class: 'party-title' }, party.name || 'Untitled party'),
        h('p', { class: 'sub' }, [
          party.host ? `hosted by ${memberName(party.host)}` : 'hosted by someone',
          `${members.length} watching`,
          isHost ? 'you are the host' : isMember ? 'you are in' : 'you are not in yet',
        ].filter(Boolean).join(' · '))),
      h('div', { class: 'party-head-right' }, h('span', { class: 'pill accent' }, '🎉 live-ish'))),
    endedBanner,
    h('div', { class: 'party-grid' },
      nowPlaying,
      h('aside', { class: 'party-side' }, membersCard, syncCard)),
  );
  container.replaceChildren(shell);

  renderMembers();
  updateSyncUi();
  if (isHost) hostControls.classList.add('is-host');
  events = connectEvents({ 'party.sync': onPartyPayload });
  every(updateSyncUi, 1000);
  every(refreshRoster, 15000);

  function renderMembers() {
    memberList.replaceChildren(...members.map((member) => {
      const isPartyHost = member.isHost === true || (party.hostId != null && member.userId === party.hostId);
      return h('div', { class: 'party-member' },
        h('span', { class: 'avatar', style: avatarStyle(member.avatarHue) }, initials(memberName(member))),
        h('div', { class: 'party-member-copy' },
          h('strong', {}, memberName(member), String(member.userId) === String(meId) ? h('span', { class: 'you-pill' }, 'you') : null),
          h('span', { class: 'faint small' }, [isPartyHost ? 'host' : 'attendee', member.joinedAt ? `joined ${fmtRelative(member.joinedAt)}` : ''].filter(Boolean).join(' · '))),
        isPartyHost ? h('span', { class: 'pill hot' }, 'host') : null);
    }));
    if (!members.length) memberList.append(h('p', { class: 'muted small' }, 'Nobody has joined yet. Send the invite.'));
    membersCard.querySelector('.card-title .pill').textContent = `${members.length}/${MAX_MEMBERS}`;
  }

  function updateSyncUi() {
    const position = currentPosition();
    progressFill.style.width = duration ? `${Math.min(100, Math.max(0, (position / duration) * 100))}%` : '0%';
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', String(Math.round(duration)));
    progressBar.setAttribute('aria-valuenow', String(Math.round(position)));
    progressBar.setAttribute('aria-valuetext', `${fmtClock(position)} of ${duration ? fmtClock(duration) : 'live'}`);
    hostPositionText.textContent = `${fmtClock(position)}${duration ? ` / ${fmtClock(duration)}` : ''}`;
    syncPositionText.textContent = `${fmtClock(position)}${duration ? ` / ${fmtClock(duration)}` : ''}`;
    lastSyncText.textContent = fmtRelative(new Date(sync.lastSync || Date.now()).toISOString()) || 'just now';
    statusPill.textContent = ended ? 'ended' : sync.paused ? 'paused' : 'playing';
    statusPill.className = `pill ${ended ? 'bad' : sync.paused ? 'warn' : 'good'}`;
    playToggle.textContent = sync.paused ? '▶' : '❚❚';
    playToggle.setAttribute('aria-label', sync.paused ? 'Play party' : 'Pause party');
    hostControls.hidden = ended;
    if (document.activeElement !== seek) {
      seek.value = String(Math.min(position, duration || position));
      if (duration) seek.max = String(duration);
    }
  }

  function publishState({ position = currentPosition(), paused = sync.paused } = {}) {
    if (!isHost || ended) return;
    const send = () => {
      lastPublish = Date.now();
      post(`/api/parties/${party.id}/state`, {
        position: Math.round(position * 10) / 10,
        paused,
      }).catch((errorCaught) => {
        if (errorCaught.status !== 401) toast(errorCaught.message || 'Party state refused.', 'error');
      });
    };
    const wait = 800 - (Date.now() - lastPublish);
    if (wait <= 0) send();
    else if (!publishTimer) {
      publishTimer = setTimeout(() => { publishTimer = null; send(); }, wait);
      timers.add(publishTimer);
    }
  }

  function togglePartyPause() {
    if (!isHost || ended) { toast('Only the host can drive. Spectate, seethe.', 'info', { emoji: '🍿' }); return; }
    sync.position = currentPosition();
    sync.paused = !sync.paused;
    sync.updatedAt = Date.now();
    sync.lastSync = Date.now();
    updateSyncUi();
    publishState({ position: sync.position, paused: sync.paused });
  }

  function hostSeek(position) {
    if (!isHost || ended) return;
    sync.position = Math.max(0, Math.min(position, duration || position));
    sync.updatedAt = Date.now();
    sync.lastSync = Date.now();
    updateSyncUi();
    publishState({ position: sync.position, paused: sync.paused });
  }

  async function joinParty() {
    try {
      await post(`/api/parties/${party.id}/join`, {});
      toast('You are in. May the sync be ever in your favor.', 'success', { emoji: '🎉' });
      ctx.navigate(`/party/${party.id}`);
    } catch (errorCaught) {
      toast(errorCaught.message || 'The join door is locked.', 'error');
    }
  }

  async function leaveParty() {
    const confirmed = await confirmDialog('Leave the party?', 'The host keeps playing. You just lose the group chat energy.', { confirmLabel: 'Leave', danger: false });
    if (!confirmed) return;
    try {
      const result = await post(`/api/parties/${party.id}/leave`, {});
      toast(result?.ended ? 'You left and the party ended because you were the host.' : 'You left the party. Solo slop awaits.', 'fun', { emoji: '👋' });
      ctx.navigate('/');
    } catch (errorCaught) {
      toast(errorCaught.message || 'Could not leave. Trapped in the slop.', 'error');
    }
  }

  async function endParty() {
    const confirmed = await confirmDialog('End this party?', 'Everyone loses the sync and the invite turns into a 404. Host privileges, host consequences.', { confirmLabel: 'End it' });
    if (!confirmed) return;
    try {
      await del(`/api/parties/${party.id}`);
      toast('Party ended. The room goes dark.', 'fun', { emoji: '🌙' });
      ctx.navigate('/');
    } catch (errorCaught) {
      toast(errorCaught.message || 'Only the host or an admin can end this party.', 'error');
    }
  }

  async function copyInvite() {
    const link = media?.id
      ? `${location.origin}/watch/${media.id}?party=${encodeURIComponent(party.id)}`
      : `${location.origin}/party/${party.id}`;
    const copied = await copyText(link);
    if (copied) toast('Invite link copied. Threaten your friends with it.', 'success', { emoji: '🔗' });
    else toast(`Copy failed. The link is ${link}`, 'info', { emoji: '🔗' });
  }

  function refreshRoster() {
    get(`/api/parties/${encodeURIComponent(party.id)}`).then((freshRaw) => {
      if (abort.signal.aborted) return;
      const fresh = freshRaw?.party || freshRaw;
      if (!fresh?.id) return;
      if (Array.isArray(fresh.members)) { members = fresh.members.slice(); renderMembers(); }
      if (fresh.isActive === false && !ended) {
        ended = true;
        endedBanner.hidden = false;
        updateSyncUi();
      }
      if (fresh.host && !party.host) party.host = fresh.host;
    }).catch(() => { /* roster poll is best effort */ });
  }

  function onPartyPayload(data) {
    if (!data || String(data.partyId) !== String(party.id)) return;
    if (data.ended) {
      ended = true;
      endedBanner.hidden = false;
      sync.paused = true;
      updateSyncUi();
      toast('The party ended. Sad little room.', 'fun', { emoji: '🫡' });
      return;
    }
    sync.position = Number(data.position) || 0;
    sync.paused = Boolean(data.paused);
    sync.updatedAt = Date.now();
    sync.lastSync = Date.now();
    updateSyncUi();
  }

  return () => {
    abort.abort();
    if (events) { events.close(); events = null; }
    clearTimeout(publishTimer);
    for (const timer of timers) { clearInterval(timer); clearTimeout(timer); }
    timers.clear();
  };
}
// __APPEND__
