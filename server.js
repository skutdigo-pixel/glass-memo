import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const env = process.env;
const PROD = env.NODE_ENV === 'production';
const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DEV_AUTH = !PROD && env.DEV_AUTH === '1';
const AI_MOCK = !PROD && env.AI_MOCK === '1';
const STATUSES = ['todo', 'doing', 'done'];
const SESSION_DAYS = 30;

const dataDir = env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(`${dataDir}/app.db`);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT, picture TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, status);
`);
for (const col of ["scope TEXT NOT NULL DEFAULT 'day'", "period TEXT NOT NULL DEFAULT ''", "slot TEXT", "t_start INTEGER", "t_end INTEGER",
  "tpl_id TEXT", "manual TEXT", "detail TEXT", "sort INTEGER NOT NULL DEFAULT 9000", "due INTEGER", "items TEXT", "ticks TEXT"]) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch {}
}
db.exec(`UPDATE tasks SET period = strftime('%Y-%m-%d', created_at/1000 + 32400, 'unixepoch') WHERE period = '' AND tpl_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_tpl ON tasks(user_id, tpl_id, period) WHERE tpl_id IS NOT NULL;`);

// manual content lives outside git (private/manual.json); the app works without it
const MANUAL_PATH = env.MANUAL_PATH || './private/manual.json';
const MANUAL = existsSync(MANUAL_PATH) ? JSON.parse(readFileSync(MANUAL_PATH, 'utf8')) : { manuals: [], templates: [] };
const MEDIA_DIR = new URL('./private/media/', import.meta.url).pathname;

function MANUAL_TEMPLATES() { return MANUAL.templates; }
const COLS = 'id, title, status, created_at, scope, period, slot, t_start, t_end, tpl_id, manual, detail, sort, due, items, ticks';
const TPL = new Map(MANUAL_TEMPLATES().map((t) => [t.id, t]));
const shape = (r) => r && { ...r, items: r.items ? JSON.parse(r.items) : null, ticks: r.ticks ? JSON.parse(r.ticks) : [],
  chip: TPL.get(r.tpl_id)?.chip ?? null,
  tag: (() => { const o = TPL.get(r.tpl_id)?.tag; if (o) return { t: o, c: o === '新人' ? '#ff9a3c' : '#ff5d8a' }; const c = (MANUAL.cats || []).find((x) => x.ids.includes(r.manual)); return c ? { t: c.title, c: c.color } : null; })(), anchor: TPL.get(r.tpl_id)?.anchor ?? r.tpl_id ?? null };
const q = {
  userBySub: db.prepare('SELECT * FROM users WHERE sub = ?'),
  insertUser: db.prepare('INSERT INTO users (sub, email, name, picture) VALUES (?,?,?,?)'),
  updateUser: db.prepare('UPDATE users SET email=?, name=?, picture=? WHERE id=?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)'),
  session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  tasks: db.prepare(`SELECT ${COLS} FROM tasks WHERE user_id = ? AND scope = ? AND period = ? ORDER BY sort, id`),
  insertTask: db.prepare('INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, sort) VALUES (?,?,?,?,?,?,?,?,?)'),
  insertTpl: db.prepare(`INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, t_start, t_end, tpl_id, manual, detail, sort, due, items)
    VALUES (?,?,'todo',?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, tpl_id, period) WHERE tpl_id IS NOT NULL DO UPDATE SET
      title=excluded.title, slot=excluded.slot, t_start=excluded.t_start, t_end=excluded.t_end, manual=excluded.manual,
      detail=excluded.detail, sort=excluded.sort, due=excluded.due, items=excluded.items`),
  dupTask: db.prepare('SELECT id FROM tasks WHERE user_id=? AND scope=? AND period=? AND manual=? AND tpl_id IS NULL'),
  insertManualTask: db.prepare('INSERT INTO tasks (user_id, title, status, created_at, updated_at, scope, period, slot, manual, sort, items) VALUES (?,?,\'todo\',?,?,?,?,?,?,?,?)'),
  setTicks: db.prepare('UPDATE tasks SET ticks=?, updated_at=? WHERE id=? AND user_id=?'),
  task: db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ? AND user_id = ?`),
  updateTask: db.prepare('UPDATE tasks SET title=?, status=?, updated_at=? WHERE id=? AND user_id=?'),
  delTask: db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?'),
};

const hash = (s) => createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const cookieOpts = { httpOnly: true, sameSite: 'Lax', secure: PROD, path: '/' };

function startSession(c, userId) {
  const token = rand();
  q.insertSession.run(hash(token), userId, Date.now() + SESSION_DAYS * 864e5);
  setCookie(c, 'sid', token, { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
}

const app = new Hono();

// session lookup for /api
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, 'sid');
  c.set('user', token ? q.session.get(hash(token), Date.now()) ?? null : null);
  if (c.req.method !== 'GET' && c.req.path !== '/api/ai/transcribe' && !(c.req.header('content-type') || '').includes('application/json')) {
    return c.json({ error: 'bad_request' }, 400);
  }
  await next();
});
const authed = async (c, next) => (c.get('user') ? next() : c.json({ error: 'unauthorized' }, 401));

app.get('/api/me', (c) => {
  const u = c.get('user');
  return c.json({
    user: u && { name: u.name, email: u.email, picture: u.picture },
    devAuth: DEV_AUTH,
  });
});

// ---- Google OAuth (authorization code + PKCE + state) ----
app.get('/auth/google', (c) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return c.text('Google OAuth is not configured', 503);
  const state = rand(16);
  const verifier = rand(32);
  setCookie(c, 'oauth', `${state}.${verifier}`, { ...cookieOpts, maxAge: 600 });
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
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
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  if (!res.ok) return c.redirect('/?e=auth');
  // id_token comes straight from Google's token endpoint over TLS, so its claims are trusted (OIDC Core 3.1.3.7).
  const { id_token } = await res.json();
  const claims = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString());
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) {
    return c.redirect('/?e=auth');
  }
  upsertAndLogin(c, claims.sub, claims.email, claims.name, claims.picture);
  return c.redirect('/');
});

function upsertAndLogin(c, sub, email, name, picture) {
  let u = q.userBySub.get(sub);
  if (u) q.updateUser.run(email, name, picture ?? null, u.id);
  else { q.insertUser.run(sub, email, name, picture ?? null); u = q.userBySub.get(sub); }
  startSession(c, u.id);
}

// development-only stand-in for Google (never enabled in production)
if (DEV_AUTH) {
  app.get('/auth/dev', (c) => {
    upsertAndLogin(c, 'dev-user', 'dev@localhost', 'Dev User', null);
    return c.redirect('/');
  });
}

app.post('/auth/logout', (c) => {
  const token = getCookie(c, 'sid');
  if (token) q.delSession.run(hash(token));
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

// ---- tasks ----
const cleanTitle = (t) => (typeof t === 'string' ? t.trim().slice(0, 500) : '');

// ---- periods: day = YYYY-MM-DD, week = Monday's date, month = YYYY-MM ----
const pad = (n) => String(n).padStart(2, '0');
function periodOf(scope, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (scope === 'day') return date;
  if (scope === 'month') return date.slice(0, 7);
  if (scope === 'week') { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  return null;
}
function ensurePeriod(uid, scope, date, period) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const now = Date.now();
  const ids = MANUAL.templates.filter((t) => t.scope === scope).map((t) => `'${String(t.id).replace(/'/g, '')}'`);
  db.exec(`DELETE FROM tasks WHERE user_id=${uid} AND scope='${scope}' AND period='${period}' AND tpl_id IS NOT NULL AND tpl_id NOT IN (${ids.join(',') || "''"})`);
  for (const t of MANUAL.templates) {
    if (t.scope !== scope) continue;
    if (scope === 'day') {
      if (t.dow ? !t.dow.includes(dow) : dow === 0) continue; // closed on Sundays unless the item names the weekday
    }
    q.insertTpl.run(uid, t.title, now, now, scope, period, t.slot, t.time?.[0] ?? null, t.time?.[1] ?? null, t.id, t.manual, t.detail || null, t.sort ?? 5000, t.due ?? null, t.items ? JSON.stringify(t.items) : null);
  }
}

app.get('/api/tasks', authed, (c) => {
  const scope = c.req.query('scope') || 'day';
  const date = c.req.query('date') || '';
  const period = periodOf(scope, date);
  if (!period) return c.json({ error: 'invalid' }, 400);
  const uid = c.get('user').id;
  ensurePeriod(uid, scope, date, period);
  return c.json(q.tasks.all(uid, scope, period).map(shape));
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
  const out = titles.map((t, i) => {
    const r = q.insertTask.run(uid, t, 'todo', now + i, now, scope, period, 'メモ', 9000 + i);
    return shape(q.task.get(Number(r.lastInsertRowid), uid));
  });
  return c.json(out, 201);
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
  if (m.items.length && !q.dupTask.get(uid, 'day', period, m.id)) {
    q.insertManualTask.run(uid, m.title, now, now, 'day', period, 'マニュアル', m.id, 7000, JSON.stringify(m.items.map((i) => ({ t: i.title, s: i.section, d: '' }))));
    added = m.items.length;
  }
  return c.json({ added });
});

app.get('/media/:file', async (c) => {
  const token = getCookie(c, 'sid');
  if (!token || !q.session.get(hash(token), Date.now())) return c.text('unauthorized', 401);
  const f = basename(c.req.param('file'));
  if (!/\.jpg$/.test(f) || !existsSync(MEDIA_DIR + f)) return c.text('not found', 404);
  return c.body(readFileSync(MEDIA_DIR + f), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
});

app.patch('/api/tasks/:id', authed, async (c) => {
  const uid = c.get('user').id;
  const t = q.task.get(Number(c.req.param('id')), uid);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const status = body.status === undefined ? t.status : body.status;
  const title = body.title === undefined ? t.title : cleanTitle(body.title);
  if (!STATUSES.includes(status) || !title) return c.json({ error: 'invalid' }, 400);
  q.updateTask.run(title, status, Date.now(), t.id, uid);
  if (Array.isArray(body.ticks)) q.setTicks.run(JSON.stringify(body.ticks.filter(Number.isInteger).slice(0, 300)), Date.now(), t.id, uid);
  return c.json(shape(q.task.get(t.id, uid)));
});

app.delete('/api/tasks/:id', authed, (c) => {
  q.delTask.run(Number(c.req.param('id')), c.get('user').id);
  return c.json({ ok: true });
});

// ---- AI (Cloudflare Workers AI, called over REST from the backend) ----
const AI_MODEL = env.CF_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const SYSTEM = 'あなたはタスク整理アシスタントです。ユーザーのメモを、実行可能な短いタスクに分解してください。' +
  '各タスクは30文字以内の簡潔な日本語(元の言語を維持)。JSONのみを返す: {"tasks":["...","..."]}。説明文は一切出力しない。';

async function organize(text) {
  if (AI_MOCK) {
    return text.split(/[\n、,。;；]|と(?=[^\s])|そして/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw Object.assign(new Error('ai_not_configured'), { status: 503 });
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${AI_MODEL}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      response_format: { type: 'json_object' },
      max_tokens: 512,
    }),
  });
  if (!res.ok) throw Object.assign(new Error('ai_failed'), { status: 502 });
  const data = await res.json();
  let r = data?.result?.response ?? data?.result?.choices?.[0]?.message?.content;
  if (typeof r === 'string') {
    const m = r.match(/\{[\s\S]*\}/);
    r = m ? JSON.parse(m[0]) : null;
  }
  const tasks = (r?.tasks ?? []).map(cleanTitle).filter(Boolean).slice(0, 10);
  if (!tasks.length) throw Object.assign(new Error('ai_empty'), { status: 502 });
  return tasks;
}

app.post('/api/ai/organize', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) return c.json({ error: 'empty' }, 400);
  try {
    return c.json({ tasks: await organize(text) });
  } catch (e) {
    return c.json({ error: e.message }, e.status || 500);
  }
});

app.post('/api/ai/transcribe', authed, async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length || buf.length > 8 * 1024 * 1024) return c.json({ error: 'invalid' }, 400);
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return c.json({ error: 'ai_not_configured' }, 503);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ audio: buf.toString('base64'), language: 'ja' }),
  });
  if (!res.ok) return c.json({ error: 'ai_failed' }, 502);
  const text = ((await res.json())?.result?.text || '').trim();
  return text ? c.json({ text }) : c.json({ error: 'ai_empty' }, 422);
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
let EMB = null; // Float32Array[] aligned with CHUNKS
const aiRun = async (model, payload) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw Object.assign(new Error('ai_failed'), { status: 502 });
  return (await res.json()).result;
};
async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 40) out.push(...(await aiRun('@cf/baai/bge-m3', { text: texts.slice(i, i + 40) })).data);
  return out;
}
async function ensureEmbeddings() {
  if (EMB) return EMB;
  EMB = embed(CHUNKS.map((c) => `${c.title}\n${c.text}`)).then((v) => (EMB = v), (e) => { EMB = null; throw e; });
  return EMB;
}
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y || 1); };
const bigrams = (s) => { const t = s.replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; };
async function retrieve(question, k = 8) {
  const keys = bigrams(question);
  const kw = CHUNKS.map((c) => { const g = bigrams(c.title + c.text); let n = 0; for (const b of keys) if (g.has(b)) n++; return n / (keys.size || 1); });
  let sem = null;
  try { const [qv] = await embed([question]); const ev = await ensureEmbeddings(); sem = ev.map((v) => cosine(qv, v)); } catch {}
  const tk = [...keys];
  return CHUNKS.map((c, i) => {
    const tg = bigrams(c.title); let tn = 0; for (const b of tk) if (tg.has(b)) tn++;
    return { c, score: (sem ? sem[i] : 0) + kw[i] * 0.6 + (tn / (tk.length || 1)) * 0.4 };
  }).sort((a, b) => b.score - a.score).slice(0, k);
}
const ASK_SYSTEM = 'あなたは介護デイサービスの新人スタッフを支える案内役です。次の【資料】だけを根拠に、質問に日本語で簡潔に答えてください。' +
  '資料の順序・手順・数値は変えずにそのまま使います。手順は番号つきの短い箇条書きにします。資料に書かれていないことは推測せず「マニュアルに記載がありません。先輩か管理者に確認してください」と答えます。';

app.post('/api/ask', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 500) : '';
  if (!q) return c.json({ error: 'empty' }, 400);
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return c.json({ error: 'ai_not_configured' }, 503);
  try {
    const top = await retrieve(q);
    const context = top.map((t, i) => `【資料${i + 1}:${t.c.title}】\n${t.c.text}`).join('\n\n');
    const r = await aiRun(AI_MODEL, { messages: [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: `${context}\n\n【質問】${q}` }], max_tokens: 700 });
    const answer = (r?.response ?? r?.choices?.[0]?.message?.content ?? '').trim();
    if (!answer) return c.json({ error: 'ai_empty' }, 502);
    const seen = new Set();
    const sources = top.slice(0, 4).filter((t) => !seen.has(t.c.id) && seen.add(t.c.id)).map((t) => ({ id: t.c.id, title: t.c.title }));
    return c.json({ answer, sources });
  } catch (e) { return c.json({ error: e.message }, e.status || 500); }
});

app.get('/healthz', (c) => c.text('ok'));
app.use('/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (i) => console.log(`listening on ${i.port}`));
