CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT, picture TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'day', period TEXT NOT NULL DEFAULT '', slot TEXT, t_start INTEGER, t_end INTEGER,
  tpl_id TEXT, manual TEXT, detail TEXT, sort INTEGER NOT NULL DEFAULT 9000, due INTEGER, items TEXT, ticks TEXT
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, scope, period);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_tpl ON tasks(user_id, tpl_id, period) WHERE tpl_id IS NOT NULL;
