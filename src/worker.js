import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import MANUAL_DATA from '../private/manual.json';

const MANUAL = MANUAL_DATA;
const STATUSES = ['todo', 'doing', 'done'];
const SESSION_DAYS = 30;
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const COLS = 'id, title, status, created_at, scope, period, slot, t_start, t_end, tpl_id, manual, detail, sort, due, items, ticks';
const TPL = new Map(MANUAL.templates.map((t) => [t.id, t]));
const shape = (r) => r && {
  ...r,
  items: r.items ? JSON.parse(r.items) : null,
  ticks: r.ticks ? JSON.parse(r.ticks) : [],
  chip: TPL.get(r.tpl_id)?.chip ?? null,
  tag: (() => {
    const o = TPL.get(r.tpl_id)?.tag;
    if (o) return { t: o, c: o === '新人' ? '#ff9a3c' : '#ff5d8a' };
    const c = (MANUAL.cats || []).find((x) => x.ids.includes(r.manual));
    return c ? { t: c.title, c: c.color } : null;
  })(),
  anchor: TPL.get(r.tpl_id)?.anchor ?? r.tpl_id ?? null,
};

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s) => crypto.subtle.digest('SHA-256', enc.encode(s));
const hash = async (s) => [...new Uint8Array(await sha256(s))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const app = new Hono();
const baseUrl = (c) => (c.env.BASE_URL || new URL(c.req.url).origin).replace(/\/$/, '');
const cookieOpts = (c) => ({ httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', path: '/' });
const devAuth = (c) => c.env.DEV_AUTH === '1';

async function sessionUser(c) {
  const token = getCookie(c, 'sid');
  if (!token) return null;
  return (await c.env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?')
    .bind(await hash(token), Date.now()).first()) ?? null;
}

app.use('/api/*', async (c, next) => {
  c.set('user', await sessionUser(c));
  if (c.req.method !== 'GET' && c.req.path !== '/api/ai/transcribe' && !(c.req.header('content-type') || '').includes('application/json')) {
    return c.json({ error: 'bad_request' }, 400);
  }
  await next();
});
const authed = async (c, next) => (c.get('user') ? next() : c.json({ error: 'unauthorized' }, 401));

app.get('/api/me', (c) => {
  const u = c.get('user');
  return c.json({ user: u && { name: u.name, email: u.email, picture: u.picture }, devAuth: devAuth(c) });
});

async function upsertAndLogin(c, sub, email, name, picture) {
  const db = c.env.DB;
  let u = await db.prepare('SELECT * FROM users WHERE sub = ?').bind(sub).first();
  if (u) await db.prepare('UPDATE users SET email=?, name=?, picture=? WHERE id=?').bind(email, name, picture ?? null, u.id).run();
  else {
    await db.prepare('INSERT INTO users (sub, email, name, picture) VALUES (?,?,?,?)').bind(sub, email, name, picture ?? null).run();
    u = await db.prepare('SELECT * FROM users WHERE sub = ?').bind(sub).first();
  }
  const token = rand();
  await db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').bind(await hash(token), u.id, Date.now() + SESSION_DAYS * 864e5).run();
  setCookie(c, 'sid', token, { ...cookieOpts(c), maxAge: SESSION_DAYS * 86400 });
}

// ---- Google OAuth (authorization code + PKCE + state) ----
app.get('/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.text('Google OAuth is not configured', 503);
  const state = rand(16);
  const verifier = rand(32);
  setCookie(c, 'oauth', `${state}.${verifier}`, { ...cookieOpts(c), maxAge: 600 });
  const p = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${baseUrl(c)}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: b64url(await sha256(verifier)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});

app.get('/auth/google/callback', async (c) => {
  const [state, verifier] = (getCookie(c, 'oauth') || '').split('.');
  deleteCookie(c, 'oauth', { path: '/' });
  const code = c.req.query('code');
  if (!state || !verifier || !code || c.req.query('state') !== state) return c.redirect('/?e=auth');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${baseUrl(c)}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  if (!res.ok) return c.redirect('/?e=auth');
  // id_token comes straight from Google's token endpoint over TLS, so its claims are trusted (OIDC Core 3.1.3.7).
  const { id_token } = await res.json();
  const part = id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (ch) => ch.charCodeAt(0))));
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) {
    return c.redirect('/?e=auth');
  }
  await upsertAndLogin(c, claims.sub, claims.email, claims.name, claims.picture);
  return c.redirect('/');
});

// development-only stand-in for Google (enabled only with DEV_AUTH=1 in .dev.vars)
app.get('/auth/dev', async (c) => {
  if (!devAuth(c)) return c.notFound();
  await upsertAndLogin(c, 'dev-user', 'dev@localhost', 'Dev User', null);
  return c.redirect('/');
});

app.post('/auth/logout', async (c) => {
  const token = getCookie(c, 'sid');
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await hash(token)).run();
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

// ---- periods: day = YYYY-MM-DD, week = Monday's date, month = YYYY-MM ----
const cleanTitle = (t) => (typeof t === 'string' ? t.trim().slice(0, 500) : '');
function periodOf(scope, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (scope === 'day') return date;
  if (scope === 'month') return date.slice(0, 7);
  if (scope === 'week') { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  return null;
}

async function ensurePeriod(db, uid, scope, date, period) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const now = Date.now();
  const tpls = MANUAL.templates.filter((t) => t.scope === scope);
  const marks = tpls.map(() => '?').join(',') || "''";
  const stmts = [db.prepare(`DELETE FROM tasks WHERE user_id=? AND scope=? AND period=? AND tpl_id IS NOT NULL AND tpl_id NOT IN (${marks})`).bind(uid, scope, period, ...tpls.map((t) => t.id))];
  const up = db.prepare(`INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, t_start, t_end, tpl_id, manual, detail, sort, due, items)
    VALUES (?,?,'todo',?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, tpl_id, period) WHERE tpl_id IS NOT NULL DO UPDATE SET
      title=excluded.title, slot=excluded.slot, t_start=excluded.t_start, t_end=excluded.t_end, manual=excluded.manual,
      detail=excluded.detail, sort=excluded.sort, due=excluded.due, items=excluded.items`);
  for (const t of tpls) {
    if (scope === 'day' && (t.dow ? !t.dow.includes(dow) : dow === 0)) continue; // closed on Sundays unless the item names the weekday
    stmts.push(up.bind(uid, t.title, now, now, scope, period, t.slot, t.time?.[0] ?? null, t.time?.[1] ?? null, t.id, t.manual, t.detail || null, t.sort ?? 5000, t.due ?? null, t.items ? JSON.stringify(t.items) : null));
  }
  await db.batch(stmts);
}

const getTask = (db, id, uid) => db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ? AND user_id = ?`).bind(id, uid).first();

app.get('/api/tasks', authed, async (c) => {
  const scope = c.req.query('scope') || 'day';
  const date = c.req.query('date') || '';
  const period = periodOf(scope, date);
  if (!period) return c.json({ error: 'invalid' }, 400);
  const uid = c.get('user').id;
  await ensurePeriod(c.env.DB, uid, scope, date, period);
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM tasks WHERE user_id = ? AND scope = ? AND period = ? ORDER BY sort, id`).bind(uid, scope, period).all();
  return c.json(results.map(shape));
});

app.post('/api/tasks', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const titles = (Array.isArray(body.titles) ? body.titles : [body.title]).map(cleanTitle).filter(Boolean).slice(0, 20);
  if (!titles.length) return c.json({ error: 'empty' }, 400);
  const scope = ['day', 'week', 'month'].includes(body.scope) ? body.scope : 'day';
  const period = periodOf(scope, body.date || '');
  if (!period) return c.json({ error: 'invalid' }, 400);
  const uid = c.get('user').id;
  const now = Date.now();
  const out = [];
  for (let i = 0; i < titles.length; i++) {
    const r = await c.env.DB.prepare('INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, sort) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid, titles[i], 'todo', now + i, now, scope, period, 'メモ', 9000 + i).run();
    out.push(shape(await getTask(c.env.DB, r.meta.last_row_id, uid)));
  }
  return c.json(out, 201);
});

app.patch('/api/tasks/:id', authed, async (c) => {
  const uid = c.get('user').id;
  const t = await getTask(c.env.DB, Number(c.req.param('id')), uid);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const status = body.status === undefined ? t.status : body.status;
  const title = body.title === undefined ? t.title : cleanTitle(body.title);
  if (!STATUSES.includes(status) || !title) return c.json({ error: 'invalid' }, 400);
  const stmts = [c.env.DB.prepare('UPDATE tasks SET title=?, status=?, updated_at=? WHERE id=? AND user_id=?').bind(title, status, Date.now(), t.id, uid)];
  if (Array.isArray(body.ticks)) stmts.push(c.env.DB.prepare('UPDATE tasks SET ticks=?, updated_at=? WHERE id=? AND user_id=?').bind(JSON.stringify(body.ticks.filter(Number.isInteger).slice(0, 300)), Date.now(), t.id, uid));
  await c.env.DB.batch(stmts);
  return c.json(shape(await getTask(c.env.DB, t.id, uid)));
});

app.delete('/api/tasks/:id', authed, async (c) => {
  await c.env.DB.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').bind(Number(c.req.param('id')), c.get('user').id).run();
  return c.json({ ok: true });
});

// ---- manuals ----
app.get('/api/manuals', authed, (c) => c.json({
  cats: MANUAL.cats || [],
  manuals: MANUAL.manuals.map((m) => ({ id: m.id, title: m.title, kind: m.kind, items: m.items.length })),
}));

app.get('/api/manuals/:id', authed, (c) => {
  const m = MANUAL.manuals.find((x) => x.id === c.req.param('id'));
  return m ? c.json(m) : c.json({ error: 'not_found' }, 404);
});

app.post('/api/manuals/:id/add', authed, async (c) => {
  const m = MANUAL.manuals.find((x) => x.id === c.req.param('id'));
  if (!m) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const period = periodOf('day', body.date || '');
  if (!period) return c.json({ error: 'invalid' }, 400);
  const uid = c.get('user').id;
  const now = Date.now();
  let added = 0;
  const dup = await c.env.DB.prepare('SELECT id FROM tasks WHERE user_id=? AND scope=? AND period=? AND manual=? AND tpl_id IS NULL').bind(uid, 'day', period, m.id).first();
  if (m.items.length && !dup) {
    await c.env.DB.prepare("INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, manual, sort, items) VALUES (?,?,'todo',?,?,?,?,?,?,?,?)")
      .bind(uid, m.title, now, now, 'day', period, 'マニュアル', m.id, 7000, JSON.stringify(m.items.map((i) => ({ t: i.title, s: i.section, d: '' })))).run();
    added = m.items.length;
  }
  return c.json({ added });
});

// private images live in KV (uploaded by scripts/deploy.sh), served only to signed-in users
app.get('/media/:file', async (c) => {
  if (!(await sessionUser(c))) return c.text('unauthorized', 401);
  const f = c.req.param('file');
  if (!/^[\w-]+\.jpg$/.test(f)) return c.text('not found', 404);
  const data = await c.env.MEDIA.get(f, 'arrayBuffer');
  if (!data) return c.text('not found', 404);
  return new Response(data, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
});

// ---- AI (Workers AI binding) ----
const SYSTEM = 'あなたはタスク整理アシスタントです。ユーザーのメモを、実行可能な短いタスクに分解してください。' +
  '各タスクは30文字以内の簡潔な日本語(元の言語を維持)。JSONのみを返す: {"tasks":["...","..."]}。説明文は一切出力しない。';
const aiErr = (m, status = 502) => Object.assign(new Error(m), { status });

async function organize(c, text) {
  if (c.env.AI_MOCK === '1') return text.split(/[\n、,。;；]|と(?=[^\s])|そして/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  let res;
  try {
    res = await c.env.AI.run(AI_MODEL, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], response_format: { type: 'json_object' }, max_tokens: 512 });
  } catch { throw aiErr('ai_failed'); }
  let r = res?.response ?? res?.choices?.[0]?.message?.content;
  if (typeof r === 'string') { const m = r.match(/\{[\s\S]*\}/); try { r = m ? JSON.parse(m[0]) : null; } catch { r = null; } }
  const tasks = (r?.tasks ?? []).map(cleanTitle).filter(Boolean).slice(0, 10);
  if (!tasks.length) throw aiErr('ai_empty');
  return tasks;
}

app.post('/api/ai/organize', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) return c.json({ error: 'empty' }, 400);
  try { return c.json({ tasks: await organize(c, text) }); } catch (e) { return c.json({ error: e.message }, e.status || 500); }
});

app.post('/api/ai/transcribe', authed, async (c) => {
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.length || buf.length > 8 * 1024 * 1024) return c.json({ error: 'invalid' }, 400);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  try {
    const res = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(bin), language: 'ja' });
    const text = (res?.text || '').trim();
    return text ? c.json({ text }) : c.json({ error: 'ai_empty' }, 422);
  } catch { return c.json({ error: 'ai_failed' }, 502); }
});

// ---- ask the manuals (retrieval + Workers AI) ----
const CHUNKS = [];
for (const m of MANUAL.manuals) {
  let buf = '';
  const flush = () => { if (buf.trim()) CHUNKS.push({ id: m.id, title: m.title, text: buf.trim() }); buf = ''; };
  for (const line of m.body.split('\n')) {
    if (buf.length + line.length > 420) flush();
    buf += line + '\n';
  }
  flush();
}
let EMB = null;
async function embed(c, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 40) out.push(...(await c.env.AI.run('@cf/baai/bge-m3', { text: texts.slice(i, i + 40) })).data);
  return out;
}
async function ensureEmbeddings(c) {
  if (EMB) return EMB;
  const key = 'emb-' + (await hash(CHUNKS.map((x) => x.text).join('')));
  const cached = await c.env.MEDIA.get(key, 'json');
  if (cached) return (EMB = cached);
  const v = await embed(c, CHUNKS.map((x) => `${x.title}\n${x.text}`));
  await c.env.MEDIA.put(key, JSON.stringify(v));
  return (EMB = v);
}
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y || 1); };
const bigrams = (s) => { const t = s.replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; };
async function retrieve(c, question, k = 8) {
  const keys = bigrams(question);
  const kw = CHUNKS.map((x) => { const g = bigrams(x.title + x.text); let n = 0; for (const b of keys) if (g.has(b)) n++; return n / (keys.size || 1); });
  let sem = null;
  try { const [qv] = await embed(c, [question]); const ev = await ensureEmbeddings(c); sem = ev.map((v) => cosine(qv, v)); } catch {}
  const tk = [...keys];
  return CHUNKS.map((x, i) => {
    const tg = bigrams(x.title); let tn = 0; for (const b of tk) if (tg.has(b)) tn++;
    return { c: x, score: (sem ? sem[i] : 0) + kw[i] * 0.6 + (tn / (tk.length || 1)) * 0.4 };
  }).sort((a, b) => b.score - a.score).slice(0, k);
}
const ASK_SYSTEM = 'あなたは介護デイサービスの新人スタッフを支える案内役です。次の【資料】だけを根拠に、質問に日本語で簡潔に答えてください。' +
  '資料の順序・手順・数値は変えずにそのまま使います。手順は番号つきの短い箇条書きにします。資料に書かれていないことは推測せず「マニュアルに記載がありません。先輩か管理者に確認してください」と答えます。';

app.post('/api/ask', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 500) : '';
  if (!q) return c.json({ error: 'empty' }, 400);
  try {
    const top = await retrieve(c, q);
    const context = top.map((t, i) => `【資料${i + 1}:${t.c.title}】\n${t.c.text}`).join('\n\n');
    const r = await c.env.AI.run(AI_MODEL, { messages: [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: `${context}\n\n【質問】${q}` }], max_tokens: 700 });
    const answer = (r?.response ?? r?.choices?.[0]?.message?.content ?? '').trim();
    if (!answer) return c.json({ error: 'ai_empty' }, 502);
    const seen = new Set();
    const sources = top.slice(0, 4).filter((t) => !seen.has(t.c.id) && seen.add(t.c.id)).map((t) => ({ id: t.c.id, title: t.c.title }));
    return c.json({ answer, sources });
  } catch (e) { return c.json({ error: e.message }, e.status || 500); }
});

app.get('/healthz', (c) => c.text('ok'));

export default app;
