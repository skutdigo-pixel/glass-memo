import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';

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

const q = {
  userBySub: db.prepare('SELECT * FROM users WHERE sub = ?'),
  insertUser: db.prepare('INSERT INTO users (sub, email, name, picture) VALUES (?,?,?,?)'),
  updateUser: db.prepare('UPDATE users SET email=?, name=?, picture=? WHERE id=?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)'),
  session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  tasks: db.prepare('SELECT id, title, status, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
  insertTask: db.prepare('INSERT INTO tasks (user_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)'),
  task: db.prepare('SELECT id, title, status, created_at FROM tasks WHERE id = ? AND user_id = ?'),
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
  if (c.req.method !== 'GET' && !(c.req.header('content-type') || '').includes('application/json')) {
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

app.get('/api/tasks', authed, (c) => c.json(q.tasks.all(c.get('user').id)));

app.post('/api/tasks', authed, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const titles = (Array.isArray(body.titles) ? body.titles : [body.title]).map(cleanTitle).filter(Boolean).slice(0, 20);
  if (!titles.length) return c.json({ error: 'empty' }, 400);
  const uid = c.get('user').id;
  const now = Date.now();
  const out = titles.map((t, i) => {
    const r = q.insertTask.run(uid, t, 'todo', now + i, now);
    return q.task.get(Number(r.lastInsertRowid), uid);
  });
  return c.json(out, 201);
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
  return c.json(q.task.get(t.id, uid));
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

app.get('/healthz', (c) => c.text('ok'));
app.use('/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (i) => console.log(`listening on ${i.port}`));
