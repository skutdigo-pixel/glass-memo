const STATUSES = ['todo', 'doing', 'done'];
const LABEL = { todo: 'ToDo', doing: 'Doing', done: 'Done' };
const COLOR = { todo: '#4f7cff', doing: '#ffb02e', done: '#2fc77a' };
const DELETE_COLOR = '#ff5d6c';
const THRESHOLD = 90;
const MIN_SKELETON_MS = 800;

const $app = document.getElementById('app');
const $sk = document.getElementById('skeleton');
const state = { user: null, tasks: [], tab: 'todo', devAuth: false };

const ICON = {
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-2.2-6.3L3.5 10l6.3-1.7zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  g: '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 010-9.4l-7.9-6.1a24 24 0 000 21.6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>',
};

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { state.user = null; showLogin(); throw new Error('unauthorized'); }
  if (!res.ok) throw Object.assign(new Error('api'), { status: res.status });
  return res.json();
}

function toast(msg) {
  const el = h(`<div class="toast glass" role="status">${esc(msg)}</div>`);
  document.body.append(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ---------------- boot ---------------- */
async function boot() {
  const started = performance.now();
  let me = { user: null };
  try { me = await (await fetch('/api/me')).json(); } catch {}
  state.devAuth = !!me.devAuth;
  state.user = me.user;
  if (state.user) {
    try { state.tasks = await api('/api/tasks'); } catch {}
  }
  await sleep(Math.max(0, MIN_SKELETON_MS - (performance.now() - started)));
  state.user ? showMain() : showLogin();
  $sk.classList.add('out');
  setTimeout(() => $sk.remove(), 600);
}

/* ---------------- login ---------------- */
function showLogin() {
  $app.hidden = true;
  document.querySelector('.login')?.remove();
  document.querySelector('.menu')?.remove();
  const el = h(`<div class="login"><div class="login-wrap">
    <a class="g-btn glass" href="/auth/google" data-testid="google-login" aria-label="Google">${ICON.g}<span>Google</span></a>
    ${state.devAuth ? '<a class="dev-btn glass" href="/auth/dev" data-testid="dev-login">dev</a>' : ''}
  </div></div>`);
  document.body.append(el);
}

/* ---------------- main ---------------- */
let $list, $input, $go, $ai, $pill;

function showMain() {
  document.querySelector('.login')?.remove();
  $app.hidden = false;
  $app.replaceChildren(h(`
    <div class="top">
      <div class="tabs glass" role="tablist">
        <div class="pill"></div>
        ${STATUSES.map((s) => `<button class="tab" role="tab" data-tab="${s}" data-testid="tab-${s}"><span class="dot" style="background:${COLOR[s]}"></span>${LABEL[s]}<span class="n" data-count="${s}">0</span></button>`).join('')}
      </div>
      <button class="avatar glass" data-testid="avatar" aria-label="account"></button>
    </div>`), h('<div class="list" data-testid="list"></div>'), h(`
    <form class="composer glass" autocomplete="off">
      <textarea rows="1" data-testid="input" enterkeyhint="send" aria-label="memo" autocapitalize="off" autofocus></textarea>
      <button type="button" class="ib ai" data-testid="ai" aria-label="AI" disabled>${ICON.spark}</button>
      <button type="submit" class="ib go" data-testid="add" aria-label="add" disabled>${ICON.send}</button>
    </form>`));

  $list = $app.querySelector('.list');
  $input = $app.querySelector('textarea');
  $go = $app.querySelector('.go');
  $ai = $app.querySelector('.ai');
  $pill = $app.querySelector('.pill');

  const av = $app.querySelector('.avatar');
  av.innerHTML = state.user.picture
    ? `<img src="${esc(state.user.picture)}" alt="" referrerpolicy="no-referrer">`
    : esc((state.user.name || '?').slice(0, 1).toUpperCase());
  av.onclick = toggleMenu;

  $app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  const form = $app.querySelector('form');
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
  $input.addEventListener('input', () => { autosize(); syncButtons(); });
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
  $ai.onclick = runAI;
  // tapping empty space keeps the memo field ready
  $list.addEventListener('click', (e) => { if (e.target === $list) $input.focus(); });

  setTab(state.tab, true);
  $input.focus();
}

function autosize() { $input.style.height = 'auto'; $input.style.height = Math.min($input.scrollHeight, innerHeight * 0.38) + 'px'; }
function syncButtons() { const e = !$input.value.trim(); $go.disabled = e; $ai.disabled = e; }

function toggleMenu() {
  const old = document.querySelector('.menu');
  if (old) return old.remove();
  const m = h('<div class="menu glass"><button data-testid="logout">Logout</button></div>');
  m.querySelector('button').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    state.user = null; state.tasks = []; showLogin();
  };
  document.body.append(m);
  setTimeout(() => document.addEventListener('pointerdown', function close(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close); }
  }), 0);
}

function setTab(tab, initial = false) {
  state.tab = tab;
  const i = STATUSES.indexOf(tab);
  $pill.style.transform = `translateX(${i * 100}%)`;
  $app.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  renderList(true);
  updateCounts(initial ? null : undefined);
}

function updateCounts(bumpStatus) {
  for (const s of STATUSES) {
    const el = $app.querySelector(`[data-count="${s}"]`);
    const n = String(state.tasks.filter((t) => t.status === s).length);
    if (el.textContent !== n) {
      el.textContent = n;
      if (bumpStatus === undefined || bumpStatus === s) {
        el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
      }
    }
  }
}

function renderList(animate) {
  $list.replaceChildren();
  const items = state.tasks.filter((t) => t.status === state.tab);
  items.forEach((t, i) => $list.append(makeRow(t, animate ? Math.min(i, 10) : -1)));
}

/* ---------------- add ---------------- */
async function addTitles(titles) {
  if (state.tab !== 'todo') setTab('todo');
  const temps = titles.map((title) => ({ id: -Math.random(), title, status: 'todo', created_at: Date.now() }));
  temps.slice().reverse().forEach((t) => state.tasks.unshift(t));
  temps.slice().reverse().forEach((t, i) => {
    const row = makeRow(t, 0);
    row.style.setProperty('--i', i);
    $list.prepend(row);
  });
  $list.scrollTo({ top: 0, behavior: 'smooth' });
  updateCounts('todo');
  const p = api('/api/tasks', 'POST', { titles });
  temps.forEach((t) => (t.pending = p));
  try {
    const saved = await p;
    temps.forEach((t, i) => { Object.assign(t, saved[i]); t.pending = null; });
  } catch {
    temps.forEach((t) => { state.tasks = state.tasks.filter((x) => x !== t); });
    renderList(false); updateCounts(); toast('Error');
  }
}

function submit() {
  const v = $input.value.trim();
  if (!v) return;
  $input.value = ''; autosize(); syncButtons();
  $input.focus();
  addTitles([v]);
}

async function runAI() {
  const text = $input.value.trim();
  if (!text || $ai.classList.contains('busy')) return;
  $ai.classList.add('busy');
  $ai.disabled = true;
  try {
    const { tasks } = await api('/api/ai/organize', 'POST', { text });
    $input.value = ''; autosize(); syncButtons();
    await addTitles(tasks);
  } catch (e) {
    if (e.message !== 'unauthorized') toast('AI Error');
  } finally {
    $ai.classList.remove('busy');
    syncButtons();
    $input.focus();
  }
}

/* ---------------- rows + swipe ---------------- */
const nextOf = (s) => STATUSES[STATUSES.indexOf(s) + 1];
const prevOf = (s) => STATUSES[STATUSES.indexOf(s) - 1];

function makeRow(task, enterIndex) {
  const row = h(`<div class="row" data-id="${task.id}" data-testid="task">
    <div class="reveal r"></div><div class="reveal l"></div>
    <div class="card glass s-${task.status}"><span class="st" style="background:${COLOR[task.status]}"></span><div class="t"></div></div>
  </div>`);
  row.querySelector('.t').textContent = task.title;
  if (enterIndex >= 0) { row.classList.add('enter'); row.style.setProperty('--i', enterIndex); row.addEventListener('animationend', () => row.classList.remove('enter'), { once: true }); }
  attachSwipe(row, task);
  return row;
}

function targets(task) {
  const n = nextOf(task.status), p = prevOf(task.status);
  return {
    right: n ? { kind: 'move', to: n, color: COLOR[n], icon: n === 'done' ? ICON.check : ICON.next } : null,
    left: p ? { kind: 'move', to: p, color: COLOR[p], icon: ICON.back } : { kind: 'delete', color: DELETE_COLOR, icon: ICON.trash },
  };
}

function attachSwipe(row, task) {
  const card = row.querySelector('.card');
  const rv = { right: row.querySelector('.reveal.r'), left: row.querySelector('.reveal.l') };
  let sx = 0, sy = 0, dx = 0, id = null, locked = false, t0 = 0, lastX = 0, lastT = 0, v = 0, busy = false;
  const tg = () => targets(task);

  const paint = () => {
    const T = tg();
    const side = dx > 0 ? 'right' : 'left';
    const other = side === 'right' ? 'left' : 'right';
    rv[other].style.opacity = 0;
    const cfg = T[side];
    const el = rv[side];
    if (!cfg) { el.style.opacity = 0; return; }
    if (el.dataset.k !== cfg.color) { el.dataset.k = cfg.color; el.style.background = cfg.color; el.innerHTML = cfg.icon; }
    el.style.opacity = Math.min(1, Math.abs(dx) / (THRESHOLD * 0.8));
    el.classList.toggle('hot', Math.abs(dx) >= THRESHOLD);
  };

  card.addEventListener('pointerdown', (e) => {
    if (busy || id !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    id = e.pointerId; sx = lastX = e.clientX; sy = e.clientY; dx = 0; locked = false; t0 = lastT = performance.now(); v = 0;
  });
  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!locked) {
      if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { locked = true; card.setPointerCapture(id); card.classList.add('drag'); }
      else return;
    }
    const now = performance.now();
    v = (e.clientX - lastX) / Math.max(1, now - lastT);
    lastX = e.clientX; lastT = now;
    const T = tg();
    const side = mx > 0 ? 'right' : 'left';
    dx = T[side] ? mx : mx * 0.25; // rubber band when there is nowhere to go
    card.style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)`;
    paint();
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    const wasLocked = locked;
    id = null;
    if (!wasLocked) return;
    card.classList.remove('drag');
    const side = dx > 0 ? 'right' : 'left';
    const cfg = tg()[side];
    const fast = Math.abs(v) > 0.6 && Math.abs(dx) > 40 && Math.sign(v) === Math.sign(dx);
    if (e.type === 'pointerup' && cfg && (Math.abs(dx) >= THRESHOLD || fast)) commit(side, cfg);
    else { dx = 0; card.style.transform = ''; rv.left.style.opacity = rv.right.style.opacity = 0; }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('lostpointercapture', end);

  async function commit(side, cfg) {
    busy = true;
    const el = rv[side];
    el.style.opacity = 1; el.classList.add('hot');
    const dir = side === 'right' ? 1 : -1;
    card.style.transition = 'transform .28s cubic-bezier(.5,0,.75,0), opacity .28s';
    card.style.transform = `translateX(${dir * (row.offsetWidth + 40)}px) rotate(${dir * 8}deg)`;
    card.style.opacity = 0;
    await sleep(240);
    const h0 = row.offsetHeight;
    row.animate([{ height: h0 + 'px', opacity: 1, marginBottom: '0px' }, { height: '0px', opacity: 0, marginBottom: '-10px' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    row.style.overflow = 'hidden';
    await sleep(300);
    row.remove();
    if (cfg.kind === 'delete') {
      state.tasks = state.tasks.filter((t) => t !== task);
      updateCounts();
      try { await task.pending; await api(`/api/tasks/${task.id}`, 'DELETE'); } catch { reload(); }
    } else {
      task.status = cfg.to;
      updateCounts(cfg.to);
      try { await task.pending; await api(`/api/tasks/${task.id}`, 'PATCH', { status: cfg.to }); } catch { reload(); }
    }
  }
}

async function reload() {
  try { state.tasks = await api('/api/tasks'); renderList(false); updateCounts(); } catch {}
}

boot();
