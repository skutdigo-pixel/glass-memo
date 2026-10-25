const STATUSES = ['todo', 'doing', 'done'];
const COLOR = { todo: '#4f7cff', doing: '#ffb02e', done: '#2fc77a' };
const DELETE_COLOR = '#ff5d6c';
const THRESHOLD = 90;
const MIN_SKELETON_MS = 800;
const SOON = 30; // minutes: "starts within 30 minutes"
const TABS = [['day', '今日'], ['week', '今週'], ['month', '今月'], ['manual', 'マニュアル']];

const $app = document.getElementById('app');
const $sk = document.getElementById('skeleton');
const state = { user: null, tasks: [], scope: 'day', devAuth: false, manuals: [], cats: [], mode: 'memo', open: new Map(), showTicked: new Set(), collapsed: new Map() };
const rows = new Map(); // task id -> row element (kept across re-renders so animations/gestures survive)

// ?t=HH:MM and ?d=YYYY-MM-DD override the clock (used for testing time-based views)
const qs = new URLSearchParams(location.search);
function clock() {
  const n = new Date();
  const d = qs.get('d') || `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  const t = qs.get('t');
  const min = t ? +t.split(':')[0] * 60 + +t.split(':')[1] : n.getHours() * 60 + n.getMinutes();
  return { date: d, min };
}
const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

const I = (p, w = 2.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  next: I('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.8),
  reset: I('<path d="M4 12a8 8 0 108-8H7M7 1v6H1"/>', 2.4),
  back: I('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/>', 2.4),
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-2.2-6.3L3.5 10l6.3-1.7zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  send: I('<path d="M12 19V5M5 12l7-7 7 7"/>', 2.8),
  mic: I('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>', 2.3),
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="3"/></svg>',
  clip: I('<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.3 3.3 0 014.7 4.7L9.2 17.2a1.7 1.7 0 01-2.4-2.4L14 7.6"/>', 2.2),
  chev: I('<path d="M9 6l6 6-6 6"/>', 2.4),
  cat: {
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>', 2.2),
    drop: I('<path d="M12 3c3.5 4.5 6 7.5 6 11a6 6 0 01-12 0c0-3.5 2.5-6.5 6-11z"/>', 2.2),
    user: I('<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0114 0M18 8v6M15 11h6"/>', 2.2),
    monitor: I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 2.2),
    yen: I('<circle cx="12" cy="12" r="9"/><path d="M8.5 7l3.5 5 3.5-5M8.5 12h7M8.5 15h7M12 12v6"/>', 2),
    star: I('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.1 9.5l6.1-.9z"/>', 2),
  },
  ask: I('<path d="M9.5 9a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.2M12 17h.01"/><circle cx="12" cy="12" r="9"/>', 2.2),
  x: I('<path d="M6 6l12 12M18 6L6 18"/>', 2.4),
  g: '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 010-9.4l-7.9-6.1a24 24 0 000 21.6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>',
};

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET', body, raw) {
  const res = await fetch(path, {
    method,
    headers: raw ? { 'content-type': raw.type } : method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: raw ? raw.data : body ? JSON.stringify(body) : undefined,
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

/* ---------------- boot / login ---------------- */
async function boot() {
  const started = performance.now();
  let me = { user: null };
  try { me = await (await fetch('/api/me')).json(); } catch {}
  state.devAuth = !!me.devAuth;
  state.user = me.user;
  if (state.user) { try { state.tasks = await api(`/api/tasks?scope=day&date=${clock().date}`); } catch {} }
  await sleep(Math.max(0, MIN_SKELETON_MS - (performance.now() - started)));
  state.user ? showMain() : showLogin();
  $sk.classList.add('out');
  setTimeout(() => $sk.remove(), 600);
}

function showLogin() {
  $app.hidden = true;
  document.querySelector('.login')?.remove();
  document.querySelector('.menu')?.remove();
  document.body.append(h(`<div class="login"><div class="login-wrap">
    <a class="g-btn glass" href="/auth/google" data-testid="google-login" aria-label="Google">${ICON.g}<span>Google</span></a>
    ${state.devAuth ? '<a class="dev-btn glass" href="/auth/dev" data-testid="dev-login">dev</a>' : ''}
  </div></div>`));
}

/* ---------------- shell ---------------- */
let $view, $input, $send, $ai, $pill, $composer, $attach, $file;

function showMain() {
  document.querySelector('.login')?.remove();
  $app.hidden = false;
  $app.replaceChildren(h(`
    <div class="top">
      <div class="tabs glass" role="tablist">
        <div class="pill"></div>
        ${TABS.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" data-testid="tab-${k}">${l}</button>`).join('')}
      </div>
      <button class="avatar glass" data-testid="avatar" aria-label="account"></button>
    </div>`), h('<div class="view" data-testid="view"></div>'), h(`
    <div class="modes glass" data-testid="modes"><i></i><button type="button" data-mode="memo" data-testid="mode-memo">メモ</button><button type="button" data-mode="ask" data-testid="mode-ask">質問</button></div>`), h(`
    <form class="composer glass" autocomplete="off">
      <button type="button" class="ib clip" data-testid="attach" aria-label="audio file">${ICON.clip}</button>
      <input type="file" accept="audio/*,video/mp4" hidden data-testid="file">
      <textarea rows="1" data-testid="input" enterkeyhint="send" aria-label="memo" autocapitalize="off" autofocus></textarea>
      <button type="button" class="ib ai" data-testid="ai" aria-label="AI" hidden>${ICON.spark}</button>
      <button type="submit" class="ib go" data-testid="add" aria-label="add" hidden>${ICON.send}</button>
      <button type="button" class="ib mic" data-testid="mic" aria-label="voice">${ICON.mic}</button>
    </form>`));

  $view = $app.querySelector('.view');
  $composer = $app.querySelector('.composer');
  $input = $composer.querySelector('textarea');
  $send = $composer.querySelector('.go');
  $ai = $composer.querySelector('.ai');
  $pill = $app.querySelector('.pill');
  $attach = $composer.querySelector('.clip');
  $file = $composer.querySelector('input[type=file]');

  const av = $app.querySelector('.avatar');
  av.innerHTML = state.user.picture
    ? `<img src="${esc(state.user.picture)}" alt="" referrerpolicy="no-referrer">`
    : esc((state.user.name || '?').slice(0, 1).toUpperCase());
  av.onclick = toggleMenu;

  $app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setScope(b.dataset.tab)));
  $app.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $composer.onsubmit = (e) => { e.preventDefault(); submit(); };
  $input.addEventListener('input', () => { autosize(); syncButtons(); });
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
  $ai.onclick = runAI;
  $composer.querySelector('.mic').onclick = toggleRecord;
  $attach.onclick = () => $file.click();
  $file.onchange = () => { const f = $file.files[0]; $file.value = ''; if (f) transcribeAndAdd(f, f.type || 'audio/mp4'); };

  setScope(state.scope, true);
  $input.focus();
  setInterval(tick, 20000);
}

function autosize() { $input.style.height = 'auto'; $input.style.height = Math.min($input.scrollHeight, innerHeight * 0.3) + 'px'; }
function setMode(mode) {
  state.mode = mode;
  const m = $app.querySelector('.modes');
  m.dataset.mode = mode;
  m.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  $composer.classList.toggle('ask', mode === 'ask');
  syncButtons();
}
function syncButtons() {
  const has = !!$input.value.trim();
  $send.hidden = !has; $ai.hidden = !has || state.mode === 'ask';
  $composer.querySelector('.mic').hidden = has;
}

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

async function setScope(scope, initial = false) {
  state.scope = scope;
  $pill.style.transform = `translateX(${TABS.findIndex(([k]) => k === scope) * 100}%)`;
  $app.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === scope));
  setMode(scope === 'manual' ? 'ask' : 'memo');
  rows.clear();
  document.querySelector('.manual-doc')?.remove();
  if (scope === 'manual') return renderManualList();
  $view.replaceChildren(skeletonList());
  try { state.tasks = await api(`/api/tasks?scope=${scope}&date=${clock().date}`); } catch { return; }
  if (state.scope !== scope) return;
  render(true);
}
const skeletonList = () => h('<div class="list">' + '<div class="sk sk-card"></div><div class="sk sk-card w2"></div><div class="sk sk-card"></div>'.repeat(2) + '</div>');

function tick() {
  if (state.scope === 'day' && !document.querySelector('.card.drag') && !document.hidden) render(false);
}

/* ---------------- task views ---------------- */
function progress(tasks) {
  const done = tasks.filter((t) => t.status === 'done').length;
  return { done, total: tasks.length };
}

function groupBySlot(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const key = `${t.slot ?? ''}|${t.t_start ?? ''}`;
    if (!map.has(key)) map.set(key, { slot: t.slot || '', s: t.t_start, e: t.t_end, tasks: [] });
    map.get(key).tasks.push(t);
  }
  return [...map.values()];
}

function render(animate) {
  if (state.scope === 'manual') return;
  const { min } = clock();
  const tasks = state.tasks;
  const p = progress(tasks);
  const frag = document.createDocumentFragment();

  const hero = h(`<div class="hero glass" data-testid="hero">
    <div class="ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" pathLength="100" stroke-dasharray="0 100"/></svg><b>${p.total ? Math.round((p.done / p.total) * 100) : 0}<i>%</i></b></div>
    <div class="hero-t"><div class="clock" data-testid="clock">${state.scope === 'day' ? hm(min) : p.done + '/' + p.total}</div><div class="now-slot" data-testid="now-slot"></div></div>
    <div class="count"><b>${p.done}</b>/${p.total}</div>
  </div>`);
  frag.append(hero);
  requestAnimationFrame(() => hero.querySelector('.fg').setAttribute('stroke-dasharray', `${p.total ? (p.done / p.total) * 100 : 0} 100`));

  const list = h('<div class="list"></div>');
  const sections = state.scope === 'day' ? daySections(tasks, min) : otherSections(tasks);
  let nowText = '';
  let i = 0;
  for (const sec of sections) {
    if (!sec.groups.length) continue;
    const el = h(`<section class="sec sec-${sec.key}" data-sec="${sec.key}">${sec.label ? `<h3>${sec.label}<span>${sec.groups.reduce((n, g) => n + g.tasks.filter((t) => sec.key === 'done' || t.status !== 'done').length, 0)}</span></h3>` : ''}</section>`);
    if (state.scope === 'day' || state.scope === 'week') {
      for (const g of sec.groups) {
        const head = groupHead(g, sec, min);
        if (sec.key === 'now' && !nowText) nowText = `${g.slot} ${head.sub}`;
        for (const t of g.tasks) { const r = rowFor(t, animate ? i++ : -1, sec.key === 'now'); setSub(r, t, head.sub); el.append(r); }
      }
      list.append(el); continue;
    }
    for (const g of sec.groups) {
      const gk = `${state.scope}|${g.slot}|${g.s}`;
      const open = state.collapsed.has(gk) ? !state.collapsed.get(gk) : g.due && g.due < +clock().date.slice(8) && g.tasks.every((t) => t.status === 'done') ? false : sec.open;
      const gp = progress(g.tasks);
      const head = groupHead(g, sec, min);
      const grp = h(`<div class="grp${open ? ' open' : ''}" data-slot="${esc(g.slot)}">
        <button class="grp-h"><span class="g-name">${esc(g.slot || '—')}</span><span class="g-sub">${esc(head.sub)}</span><span class="g-n">${gp.done}/${gp.total}</span><span class="chev">${ICON.chev}</span></button>
        <div class="grp-b"><div class="grp-i"></div></div></div>`);
      const inner = grp.querySelector('.grp-i');
      for (const t of g.tasks) { const r = rowFor(t, animate ? i++ : -1, false); setSub(r, t, ''); inner.append(r); }
      grp.querySelector('.grp-h').onclick = () => { grp.classList.toggle('open'); state.collapsed.set(gk, !grp.classList.contains('open')); };
      el.append(grp);
    }
    list.append(el);
  }
  if (!tasks.length) list.append(h('<div class="empty"></div>'));
  if (!tasks.length && state.scope === 'day' && new Date(clock().date + 'T00:00:00').getDay() === 0) nowText = '日曜休み';
  hero.querySelector('.now-slot').textContent = nowText;
  frag.append(list);
  const scrollTop = $view.querySelector('.list')?.scrollTop ?? 0;
  $view.replaceChildren(frag);
  if (!animate) $view.querySelector('.list').scrollTop = scrollTop;
}

function groupHead(g, sec, min) {
  if (g.s == null) return { sub: '' };
  const range = `${hm(g.s)}–${hm(g.e)}`;
  if (sec.key === 'now') return { sub: `${range} · あと${g.e - min}分` };
  if (sec.key === 'soon') return { sub: `${range} · ${g.s - min}分後` };
  if (sec.key === 'late') return { sub: `${range} · ${min - g.e}分超過` };
  return { sub: range };
}

function daySections(tasks, min) {
  const secs = { late: [], now: [], soon: [], any: [], later: [], done: [] };
  for (const g of groupBySlot(tasks)) {
    const allDone = g.tasks.every((t) => t.status === 'done');
    if (g.s == null) secs.any.push(g);
    else if (allDone) secs.done.push(g);
    else if (g.s <= min && min < g.e) secs.now.push(g);
    else if (g.s > min) (g.s - min <= SOON ? secs.soon : secs.later).push(g);
    else secs.late.push(g);
  }
  for (const k of ['late', 'now', 'soon', 'later', 'done']) secs[k].sort((a, b) => a.s - b.s);
  return [
    { key: 'now', label: 'いま', open: true, groups: secs.now },
    { key: 'soon', label: '30分以内', open: true, groups: secs.soon },
    { key: 'late', label: '遅れ', open: false, groups: secs.late },
    { key: 'any', label: '今日中', open: true, groups: secs.any },
    { key: 'later', label: 'このあと', open: false, groups: secs.later },
    { key: 'done', label: '完了', open: false, groups: secs.done },
  ];
}

function otherSections(tasks) {
  if (state.scope === 'week') return [{ key: 'period', label: '', open: true, groups: [{ slot: '', s: null, e: null, tasks }] }];
  const byDue = new Map();
  for (const t of tasks) { const k = t.due ?? 99; if (!byDue.has(k)) byDue.set(k, []); byDue.get(k).push(t); }
  const label = (d) => (d === 1 ? '月初 1日' : d >= 31 ? '月末' : d === 25 ? '25日 最終週' : `${d}日`);
  const groups = [...byDue.entries()].sort((x, y) => x[0] - y[0]).map(([d, ts]) => ({ slot: label(d), s: null, e: null, tasks: ts, due: d }));
  return [{ key: 'period', label: '', open: true, groups }];
}

function rowFor(task, i, defaultOpen) {
  let row = rows.get(task.id);
  if (!row) { row = makeRow(task); rows.set(task.id, row); if (i >= 0) { row.classList.add('enter'); row.style.setProperty('--i', Math.min(i, 12)); row.addEventListener('animationend', () => row.classList.remove('enter'), { once: true }); } }
  row._defaultOpen = defaultOpen;
  paintRow(row, task);
  return row;
}

const isOpen = (row, task) => (state.open.has(task.id) ? state.open.get(task.id) : !!row._defaultOpen && !!task.items);

function setSub(row, task, text) {
  if (state.scope !== 'day' && !text) text = task.chip && !['月初', '月末', `${task.due}日`].includes(task.chip) ? task.chip : '';
  const n = task.items ? ` · ${(task.ticks || []).length}/${task.items.length}` : '';
  row.querySelector('.sub').textContent = (text || '') + (text && n ? n : n.replace(' · ', ''));
}

function paintRow(row, task) {
  const card = row.querySelector('.card');
  card.className = card.className.replace(/\bs-(todo|doing|done)\b/g, '').trim() + ` s-${task.status}`;
  card.querySelector('.st').style.background = COLOR[task.status];
  const late = state.scope === 'month' && task.due && task.due < +clock().date.slice(8) && task.status !== 'done';
  card.classList.toggle('late', !!late);
  row.classList.toggle('open', isOpen(row, task));
  if (task.items) renderPad(row, task);
}

function renderPad(row, task) {
  const pad = row.querySelector('.pad');
  const ticks = new Set(task.ticks || []);
  const showDone = state.showTicked.has(task.id);
  pad.replaceChildren();
  let lastSec = null;
  task.items.forEach((it, idx) => {
    const on = ticks.has(idx);
    if (on && !showDone) return;
    if (it.s && it.s !== lastSec) { lastSec = it.s; pad.append(h(`<div class="pad-s">${esc(it.s)}</div>`)); }
    const li = h(`<div class="pi${on ? ' on' : ''}" data-i="${idx}"><button class="pc" aria-label="check">${ICON.check}</button><div class="pt"><span>${esc(it.t)}</span>${it.d ? `<div class="pd">${esc(it.d)}</div>` : ''}</div></div>`);
    li.querySelector('.pc').onclick = (e) => { e.stopPropagation(); tickItem(row, task, idx, li); };
    if (it.d) li.querySelector('.pt').onclick = () => li.classList.toggle('more');
    pad.append(li);
  });
  const n = ticks.size;
  if (n) {
    const b = h(`<button class="pad-more">${showDone ? '済を隠す' : `済 ${n}`}</button>`);
    b.onclick = () => { showDone ? state.showTicked.delete(task.id) : state.showTicked.add(task.id); renderPad(row, task); };
    pad.append(b);
  }
}

async function tickItem(row, task, idx, li) {
  const ticks = new Set(task.ticks || []);
  const on = !ticks.has(idx);
  on ? ticks.add(idx) : ticks.delete(idx);
  li.classList.toggle('on', on);
  if (on && !state.showTicked.has(task.id)) {
    const h0 = li.offsetHeight;
    li.animate([{ height: h0 + 'px', opacity: 1 }, { height: '0px', opacity: 0, marginTop: '-6px' }], { duration: 320, delay: 140, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    li.style.overflow = 'hidden';
    await sleep(440);
  }
  task.ticks = [...ticks].sort((a, b) => a - b);
  const total = task.items.length;
  const next = task.ticks.length === total ? 'done' : task.ticks.length ? 'doing' : 'todo';
  const body = { ticks: task.ticks };
  if (next !== task.status) { task.status = next; body.status = next; }
  render(false);
  try { await task.pending; await api(`/api/tasks/${task.id}`, 'PATCH', body); } catch { reload(); }
}

function makeRow(task) {
  const cur = () => state.tasks.find((t) => String(t.id) === row.dataset.id) || task;
  const row = h(`<div class="row" data-id="${task.id}" data-testid="task">
    <div class="reveal r"></div><div class="reveal l"></div>
    <div class="card glass"><span class="st"></span><div class="th"><span class="chip" hidden></span><div class="t"></div></div><div class="sub"></div>
      <div class="det"><div class="det-i"><div class="pad"></div><div class="det-t"></div><button class="man" hidden></button></div></div></div>
  </div>`);
  row.querySelector('.t').textContent = task.title;
  if (task.tag) { const c = row.querySelector('.chip'); c.hidden = false; c.textContent = task.tag.t; c.style.setProperty('--tc', task.tag.c); }
  const hasDetail = !!(task.detail || task.manual || task.items);
  if (hasDetail) {
    row.querySelector('.det-t').textContent = task.detail || '';
    row.classList.add('has-detail');
    if (task.manual) {
      const b = row.querySelector('.man');
      b.hidden = false; b.dataset.manual = task.manual; b.textContent = 'マニュアル';
      b.onclick = (e) => { e.stopPropagation(); loadManuals().then(() => openManual(task.manual, cur().anchor)); };
    }
  }
  attachSwipe(row, task);
  return row;
}

/* ---------------- add (memo / AI / voice) ---------------- */
async function addTitles(titles) {
  const { date } = clock();
  const scope = state.scope === 'manual' ? 'day' : state.scope;
  const temps = titles.map((title, i) => ({ id: -Math.random(), title, status: 'todo', scope, slot: 'メモ', sort: 9000 + i, t_start: null, t_end: null, pending: null }));
  state.tasks.push(...temps);
  render(false);
  const first = temps.map((t) => rows.get(t.id)).filter(Boolean);
  first.forEach((r) => r.animate([{ opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.34,1.56,.64,1)' }));
  const p = api('/api/tasks', 'POST', { titles, scope, date });
  temps.forEach((t) => (t.pending = p));
  try {
    const saved = await p;
    temps.forEach((t, i) => {
      const row = rows.get(t.id); rows.delete(t.id);
      Object.assign(t, saved[i]); t.pending = null;
      if (row) { row.dataset.id = t.id; rows.set(t.id, row); }
    });
  } catch {
    state.tasks = state.tasks.filter((t) => !temps.includes(t));
    render(false); toast('Error');
  }
}

function submit() {
  const v = $input.value.trim();
  if (!v) return;
  $input.value = ''; autosize(); syncButtons();
  $input.focus();
  if (state.mode === 'ask') return askQ(v);
  addTitles([v]);
}

async function organize(text) {
  const { tasks } = await api('/api/ai/organize', 'POST', { text });
  return tasks;
}

async function runAI() {
  const text = $input.value.trim();
  if (!text || $ai.classList.contains('busy')) return;
  $ai.classList.add('busy');
  try {
    const tasks = await organize(text);
    $input.value = ''; autosize(); syncButtons();
    await addTitles(tasks);
  } catch (e) { if (e.message !== 'unauthorized') toast('AI Error'); }
  finally { $ai.classList.remove('busy'); $input.focus(); }
}

/* voice: record -> Workers AI Whisper -> Workers AI splits into tasks */
let rec = null;
async function toggleRecord() {
  const btn = $composer.querySelector('.mic');
  if (rec) { rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Mic Error'); }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(timer); rec = null;
    btn.classList.remove('rec'); btn.innerHTML = ICON.mic; $composer.classList.remove('recording');
    transcribeAndAdd(new Blob(chunks, { type: mr.mimeType || 'audio/mp4' }), mr.mimeType || 'audio/mp4');
  };
  mr.start();
  rec = mr;
  btn.classList.add('rec'); btn.innerHTML = ICON.stop; $composer.classList.add('recording');
  const t0 = Date.now();
  const timer = setInterval(() => { if (Date.now() - t0 > 120000) mr.stop(); }, 1000);
}

async function transcribeAndAdd(blob, type) {
  const btn = $composer.querySelector('.mic');
  btn.classList.add('busy'); $composer.classList.add('working');
  try {
    const { text } = await api('/api/ai/transcribe', 'POST', null, { data: blob, type: type.split(';')[0] });
    if (state.mode === 'ask') { await askQ(text); return; }
    let tasks;
    try { tasks = await organize(text); } catch { tasks = [text]; }
    await addTitles(tasks);
  } catch (e) { if (e.message !== 'unauthorized') toast('Voice Error'); }
  finally { btn.classList.remove('busy'); $composer.classList.remove('working'); $input.focus(); }
}

/* ---------------- swipe ---------------- */
const nextOf = (s) => STATUSES[STATUSES.indexOf(s) + 1];
const prevOf = (s) => STATUSES[STATUSES.indexOf(s) - 1];

function targets(task) {
  const n = STATUSES[(STATUSES.indexOf(task.status) + 1) % 3];
  const p = STATUSES[(STATUSES.indexOf(task.status) + 2) % 3];
  const memo = !task.tpl_id && !task.manual && !task.items;
  const icon = (to, back) => (to === 'done' ? ICON.check : to === 'todo' ? (back ? ICON.back : ICON.reset) : back ? ICON.back : ICON.next);
  return {
    right: { kind: 'move', to: n, color: COLOR[n], icon: icon(n, false) },
    left: task.status === 'todo' && memo ? { kind: 'delete', color: DELETE_COLOR, icon: ICON.trash } : { kind: 'move', to: p, color: COLOR[p], icon: icon(p, true) },
  };
}

function attachSwipe(row, task) {
  const card = row.querySelector('.card');
  const rv = { right: row.querySelector('.reveal.r'), left: row.querySelector('.reveal.l') };
  let sx = 0, sy = 0, dx = 0, id = null, locked = false, busy = false, moved = false, downEl = null, hot = false;
  let samples = [];
  const cur = () => state.tasks.find((t) => String(t.id) === row.dataset.id) || task;
  const limit = () => Math.min(72, row.offsetWidth * 0.2);

  const paint = () => {
    const T = targets(cur());
    const side = dx > 0 ? 'right' : 'left';
    rv[side === 'right' ? 'left' : 'right'].style.opacity = 0;
    const cfg = T[side], el = rv[side];
    if (el.dataset.k !== cfg.color) { el.dataset.k = cfg.color; el.style.background = cfg.color; el.innerHTML = cfg.icon; }
    el.style.opacity = Math.min(1, Math.abs(dx) / (limit() * 0.8));
    const nowHot = Math.abs(dx) >= limit();
    if (nowHot !== hot) { hot = nowHot; if (hot) navigator.vibrate?.(8); }
    el.classList.toggle('hot', nowHot);
  };
  const velocity = () => {
    if (samples.length < 2) return 0;
    const a = samples[0], b = samples[samples.length - 1];
    return (b.x - a.x) / Math.max(1, b.t - a.t);
  };

  card.addEventListener('contextmenu', (e) => e.preventDefault());
  card.addEventListener('dragstart', (e) => e.preventDefault());
  card.addEventListener('pointerdown', (e) => {
    if (busy || id !== null || e.target.closest('.man, .pc, .pad-more') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    downEl = e.target; id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; locked = false; moved = false; hot = false;
    samples = [{ x: e.clientX, t: performance.now() }];
  });
  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (Math.abs(mx) > 6 || Math.abs(my) > 6) moved = true;
    if (!locked) {
      if (Math.abs(mx) > 7 && Math.abs(mx) > Math.abs(my) * 0.8) { locked = true; try { card.setPointerCapture(id); } catch {} card.classList.add('drag'); } else return;
    }
    const now = performance.now();
    samples.push({ x: e.clientX, t: now });
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
    dx = mx;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 90}deg)`;
    paint();
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    const wasLocked = locked, wasMoved = moved;
    id = null;
    if (!wasLocked) {
      if (e.type === 'pointerup' && !wasMoved && row.classList.contains('has-detail') && !downEl?.closest('.pad, .man')) toggleDetail(row, cur());
      return;
    }
    card.classList.remove('drag');
    const side = dx > 0 ? 'right' : 'left';
    const cfg = targets(cur())[side];
    const v = velocity();
    const flick = Math.abs(v) > 0.3 && Math.abs(dx) > 24 && Math.sign(v) === Math.sign(dx);
    // a cancelled gesture (browser took over) is still judged by how far it travelled, so it never just snaps back
    if (Math.abs(dx) >= limit() || flick) commit(side, cfg);
    else { dx = 0; card.style.transform = ''; rv.left.style.opacity = rv.right.style.opacity = 0; }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('lostpointercapture', end);

  async function commit(side, cfg) {
    busy = true;
    const t = cur();
    const dir = side === 'right' ? 1 : -1;
    rv[side].style.opacity = 1; rv[side].classList.add('hot');
    card.style.transition = 'transform .24s cubic-bezier(.5,0,.75,0), opacity .24s';
    card.style.transform = `translateX(${dir * (row.offsetWidth + 40)}px) rotate(${dir * 8}deg)`;
    card.style.opacity = 0;
    await sleep(220);
    if (cfg.kind === 'delete') {
      const h0 = row.offsetHeight;
      row.animate([{ height: h0 + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      row.style.overflow = 'hidden';
      await sleep(280);
      state.tasks = state.tasks.filter((x) => x !== t); rows.delete(t.id);
      render(false);
      try { await t.pending; await api(`/api/tasks/${t.id}`, 'DELETE'); } catch { reload(); }
      return;
    }
    // status change happens in place: the card re-enters from the opposite side with its new look
    t.status = cfg.to;
    const body = { status: cfg.to };
    if (t.items) { t.ticks = cfg.to === 'done' ? t.items.map((_, k) => k) : cfg.to === 'todo' ? [] : t.ticks; body.ticks = t.ticks; }
    card.style.transition = 'none'; card.style.transform = ''; card.style.opacity = '';
    rv.left.style.opacity = rv.right.style.opacity = 0; rv[side].classList.remove('hot');
    paintRow(row, t);
    card.animate([{ transform: `translateX(${-dir * 60}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 480, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    requestAnimationFrame(() => { card.style.transition = ''; });
    busy = false;
    render(false);
    try { await t.pending; await api(`/api/tasks/${t.id}`, 'PATCH', body); } catch { reload(); }
  }
}

function toggleDetail(row, task) {
  const open = !isOpen(row, task);
  state.open.set(task.id, open);
  row.classList.toggle('open', open);
}

async function reload() {
  try { state.tasks = await api(`/api/tasks?scope=${state.scope}&date=${clock().date}`); rows.clear(); render(false); } catch {}
}

/* ---------------- manuals ---------------- */
async function loadManuals() {
  if (state.manuals.length) return true;
  try { const r = await api('/api/manuals'); state.manuals = r.manuals; state.cats = r.cats; return true; } catch { return false; }
}

async function renderManualList() {
  $view.replaceChildren(skeletonList());
  if (!(await loadManuals()) || state.scope !== 'manual') return;
  const list = h('<div class="list" data-testid="manual-list"><div class="cat-grid"></div></div>');
  const grid = list.firstElementChild;
  state.cats.forEach((c, i) => {
    const n = c.ids.length;
    const b = h(`<button class="cat glass enter" data-testid="cat" data-id="${c.id}" style="--i:${i};--c:${c.color}">
      <span class="cat-i">${ICON.cat[c.icon]}</span><span class="cat-t">${esc(c.title)}</span><span class="cat-n">${n}</span></button>`);
    b.onclick = () => openCat(c.id);
    grid.append(b);
  });
  $view.replaceChildren(list);
}

function openCat(id) {
  const c = state.cats.find((x) => x.id === id);
  document.querySelector('.manual-doc')?.remove();
  const doc = h(`<div class="manual-doc glass" data-testid="cat-doc" style="--c:${c.color}">
    <div class="md-top"><button class="md-back" aria-label="back">${ICON.back}</button><h2>${esc(c.title)}</h2></div>
    <div class="md-body"><div class="mlist"></div></div></div>`);
  c.ids.forEach((mid, i) => {
    const m = state.manuals.find((x) => x.id === mid);
    const b = h(`<button class="mcard glass enter" data-testid="manual" data-id="${m.id}" style="--i:${i}"><span class="mk">${esc(m.kind)}</span><span class="mt">${esc(m.title)}</span><span class="chev">${ICON.chev}</span></button>`);
    b.onclick = () => openManual(m.id);
    doc.querySelector('.mlist').append(b);
  });
  closeable(doc);
  $app.append(doc);
}

function closeable(doc) {
  doc.querySelector('.md-back').onclick = () => { doc.classList.add('out'); setTimeout(() => doc.remove(), 350); };
}

/* original text -> structured blocks (every line is kept; markers become visual bullets/boxes) */
function renderBody(text, mid, onTick) {
  const out = h('<div class="md-text"></div>');
  const lines = text.split('\n');
  let list = null, table = null, ci = 0;
  const closeAll = () => { list = null; table = null; };
  const sk = `chk-${mid}-${clock().date}`;
  const stored = (() => { try { return JSON.parse(localStorage.getItem(sk) || '{}'); } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(sk, JSON.stringify(stored)); } catch {} onTick?.(Object.values(stored).filter(Boolean).length); };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeAll(); continue; }
    if (l.includes(' | ')) {
      if (!table) { table = h('<div class="tbl"></div>'); out.append(table); list = null; }
      const row = h('<div class="tr"></div>');
      l.split(' | ').forEach((cell) => row.append(h(`<div class="td">${esc(cell)}</div>`)));
      row.style.setProperty('--n', row.children.length);
      table.append(row); continue;
    }
    table = null;
    let m;
    if ((m = l.match(/^##\s+(.+)/))) { closeAll(); out.append(h(`<h3>${esc(m[1])}</h3>`)); continue; }
    if (/^(【.+】|[■●⏰▼]\s?|第\d+章|[ⅠⅡⅢⅣ]、|\d+[.．]\s*[■•]?\s*\S)/.test(l) && l.length < 48 && !/^[①-⑩]/.test(l)) { closeAll(); const hd = h(`<h4>${esc(l.replace(/^[■●▼]\s?/, ''))}</h4>`); const am = l.match(/^【(.+?)】/); hd.dataset.anchor = am ? am[1] : l; out.append(hd); continue; }
    if (!list) { list = h('<ul class="ls"></ul>'); out.append(list); }
    if ((m = l.match(/^[□☐◻]︎?\s*(.*)/))) {
      const key = 'c' + ci++;
      const li = h(`<li class="chk${stored[key] ? ' on' : ''}"><i>${ICON.check}</i><span>${esc(m[1])}</span></li>`);
      li.onclick = () => { li.classList.toggle('on'); stored[key] = li.classList.contains('on'); li.classList.toggle('gone', stored[key]); save(); };
      if (stored[key]) li.classList.add('gone');
      list.append(li); continue;
    }
    if ((m = l.match(/^[・\-•]\s*(.*)/))) { list.append(h(`<li class="bl"><span>${esc(m[1])}</span></li>`)); continue; }
    if ((m = l.match(/^([①-⑩]|\d+[)）.])\s*(.*)/))) { list.append(h(`<li class="nl"><b>${esc(m[1])}</b><span>${esc(m[2])}</span></li>`)); continue; }
    list.append(h(`<li class="pl"><span>${esc(l)}</span></li>`));
  }
  return out;
}

/* structured sheets (e.g. 管理者業務指導項目): checkboxes, dated rows, groups */
function chkItem(text, on, onToggle) {
  const li = h(`<li class="chk${on ? ' on gone' : ''}"><i>${ICON.check}</i><span>${esc(text)}</span></li>`);
  li.onclick = () => { const now = !li.classList.contains('on'); li.classList.toggle('on', now); li.classList.toggle('gone', now); onToggle(now); };
  return li;
}
function renderBlocks(m, mid) {
  const root = h('<div class="md-text blocks"></div>');
  const today = clock().date;
  const local = (k) => { try { return JSON.parse(localStorage.getItem(`chk-${mid}-${k}-${today}`) || '{}'); } catch { return {}; } };
  const saveLocal = (k, o) => { try { localStorage.setItem(`chk-${mid}-${k}-${today}`, JSON.stringify(o)); } catch {} };
  for (const b of m.blocks) {
    const sec = h(`<section class="blk" ${b.anchor ? `data-anchor="${esc(b.anchor)}"` : ''}><h3>${esc(b.title)}</h3></section>`);
    if (b.type === 'daily') {
      const ul = h('<ul class="ls"></ul>');
      let task = null; let ticks = new Set();
      const o = local('daily');
      const paintList = () => {
        ul.replaceChildren();
        b.items.forEach((t, i) => {
          const on = task ? ticks.has(i) : !!o[i];
          ul.append(chkItem(t, on, async (now) => {
            if (task) {
              now ? ticks.add(i) : ticks.delete(i);
              task.ticks = [...ticks].sort((x, y) => x - y);
              const next = task.ticks.length === task.items.length ? 'done' : task.ticks.length ? 'doing' : 'todo';
              const body = { ticks: task.ticks }; if (next !== task.status) { task.status = next; body.status = next; }
              const mine = state.tasks.find((x) => x.id === task.id); if (mine) Object.assign(mine, { ticks: task.ticks, status: task.status });
              try { await api(`/api/tasks/${task.id}`, 'PATCH', body); } catch {}
            } else { o[i] = now; saveLocal('daily', o); }
            sec.querySelector('.chk-chip').textContent = `済 ${ul.querySelectorAll('.chk.on').length}`;
          }));
        });
        const n = ul.querySelectorAll('.chk.on').length;
        const chip = sec.querySelector('.chk-chip'); chip.hidden = !n; chip.textContent = ul.classList.contains('show-done') ? '済を隠す' : `済 ${n}`;
      };
      const chip = h('<button class="chk-chip" hidden></button>');
      chip.onclick = () => { ul.classList.toggle('show-done'); chip.textContent = ul.classList.contains('show-done') ? '済を隠す' : `済 ${ul.querySelectorAll('.chk.on').length}`; };
      sec.append(chip, ul); paintList();
      api(`/api/tasks?scope=day&date=${today}`).then((list) => { task = list.find((x) => x.manual === 'admin' && x.items); if (task) { ticks = new Set(task.ticks); paintList(); } }).catch(() => {});
    } else if (b.type === 'rows') {
      for (const r of b.rows) {
        const row = h(`<div class="arow" data-anchor="${esc(r.anchor)}"><span class="chip">${esc(r.chip)}</span><div><div class="at">${esc(r.title)}</div>${r.text && r.text !== r.title ? `<div class="ad">${esc(r.text)}</div>` : ''}</div></div>`);
        sec.append(row);
      }
    } else if (b.type === 'groups') {
      for (const g of b.groups) {
        sec.append(h(`<h4>${esc(g.name)}</h4>`));
        const o = local('g-' + g.name); const ul = h('<ul class="ls"></ul>');
        g.items.forEach((t, i) => ul.append(chkItem(t, !!o[i], (now) => { o[i] = now; saveLocal('g-' + g.name, o); })));
        sec.append(ul);
      }
    } else if (b.type === 'levels') {
      const t = h('<div class="tbl"></div>');
      b.rows.forEach((r) => { const row = h('<div class="tr"></div>'); r.forEach((c) => row.append(h(`<div class="td">${esc(c)}</div>`))); row.style.setProperty('--n', r.length); t.append(row); });
      sec.append(t);
    }
    root.append(sec);
  }
  return root;
}

function renderVisual(v) {
  if (v.type === 'flow') {
    const el = h(`<div class="vis flow"><h4>${esc(v.title)}</h4></div>`);
    v.steps.forEach((st, i) => {
      el.append(h(`<div class="node" style="--i:${i}"><b>${i + 1}</b><div><div class="n-t">${esc(st.t)}</div>${st.d ? `<div class="n-d">${esc(st.d)}</div>` : ''}</div></div>`));
      if (i < v.steps.length - 1) el.append(h(`<div class="arrow" style="--i:${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v14M6 13l6 6 6-6"/></svg></div>`));
    });
    if (v.note) el.append(h(`<div class="flow-note">${esc(v.note)}</div>`));
    return el;
  }
  const el = h(`<div class="vis tl"><h4>${esc(v.title)}</h4></div>`);
  v.rows.forEach((r, i) => el.append(h(`<div class="tl-r" style="--i:${i}"><div class="tl-time">${esc(r.time)}</div><div class="tl-dot"></div><div class="tl-b">${r.label ? `<div class="n-t">${esc(r.label)}</div>` : ''}${r.sub ? `<div class="n-d">${esc(r.sub)}</div>` : ''}${(r.lines || []).map((x) => `<div class="tl-l">${esc(x)}</div>`).join('')}</div></div>`)));
  return el;
}

async function openManual(id, anchor) {
  let m;
  try { m = await api(`/api/manuals/${id}`); } catch { return; }
  document.querySelector('.manual-doc.md')?.remove();
  const cat = state.cats.find((c) => c.ids.includes(id));
  const doc = h(`<div class="manual-doc md glass" data-testid="manual-doc" style="--c:${cat?.color || '#4f7cff'}">
    <div class="md-top"><button class="md-back" aria-label="back">${ICON.back}</button><h2>${esc(m.title)}</h2></div>
    <div class="md-body"></div></div>`);
  const body = doc.querySelector('.md-body');
  if (m.items.length) {
    const add = h(`<button class="md-add go-btn" data-testid="manual-add">${ICON.check}<span>今日に追加</span></button>`);
    add.onclick = async () => { try { const r = await api(`/api/manuals/${id}/add`, 'POST', { date: clock().date }); toast(`+${r.added}`); } catch { toast('Error'); } };
    body.append(add);
  }
  (m.visuals || []).forEach((v) => body.append(renderVisual(v)));
  m.media.forEach((f) => body.append(h(`<img class="md-img" src="/media/${esc(f)}" alt="" loading="lazy">`)));
  if (m.body) {
    const seg = h('<div class="seg" data-testid="seg"><i></i><button data-v="rich" aria-pressed="true">整形</button><button data-v="raw" aria-pressed="false">原文</button></div>');
    const chip = h('<button class="chk-chip" hidden></button>');
    const rich = m.blocks ? renderBlocks(m, id) : renderBody(m.body, id, (n) => { chip.hidden = !n; chip.textContent = rich.classList.contains('show-done') ? '済を隠す' : `済 ${n}`; });
    const raw = h(`<pre class="md-raw" hidden>${esc(m.body)}</pre>`);
    seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      seg.dataset.v = b.dataset.v;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      rich.hidden = b.dataset.v === 'raw'; raw.hidden = b.dataset.v !== 'raw';
    }));
    chip.onclick = () => { rich.classList.toggle('show-done'); chip.textContent = rich.classList.contains('show-done') ? '済を隠す' : `済 ${rich.querySelectorAll('.chk.on').length}`; };
    body.append(seg, chip, rich, raw);
    { const n = rich.querySelectorAll('.chk.on').length; if (n) { chip.hidden = false; chip.textContent = `済 ${n}`; } }
  }
  closeable(doc);
  $app.append(doc);
  if (anchor) setTimeout(() => {
    const t = [...doc.querySelectorAll('[data-anchor]')].find((e) => e.dataset.anchor === anchor) || [...doc.querySelectorAll('h4, h3')].find((e) => e.textContent.includes(anchor));
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.add('hl');
  }, 650);
}

/* ---------------- ask the manuals ---------------- */
async function askQ(q) {
  document.querySelector('.answer')?.remove();
  const el = h(`<div class="answer glass" data-testid="answer"><button class="a-x" aria-label="close">${ICON.x}</button>
    <div class="a-q">${esc(q)}</div><div class="a-b"><div class="sk sk-line"></div><div class="sk sk-line w2"></div><div class="sk sk-line w3"></div></div></div>`);
  el.querySelector('.a-x').onclick = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  $app.append(el);
  try {
    const r = await api('/api/ask', 'POST', { q });
    const b = el.querySelector('.a-b');
    b.innerHTML = `<div class="a-t" data-testid="answer-text">${esc(r.answer)}</div><div class="a-s">${r.sources.map((s) => `<button data-id="${esc(s.id)}">${esc(s.title)}</button>`).join('')}</div>`;
    b.querySelectorAll('.a-s button').forEach((x) => (x.onclick = async () => { await loadManuals(); openManual(x.dataset.id); }));
  } catch (e) { if (e.message !== 'unauthorized') { el.querySelector('.a-b').textContent = 'Error'; } }
}

boot();
