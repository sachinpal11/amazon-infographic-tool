import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// node:sqlite ships with Node >= 22.13, so no native database package is needed.
const nodeRequire = createRequire(path.join(process.cwd(), 'noop.js'));
const { DatabaseSync } = nodeRequire('node:sqlite');

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  colors TEXT DEFAULT '',
  fonts TEXT DEFAULT '',
  tone TEXT DEFAULT '',
  dos TEXT DEFAULT '',
  donts TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  logo TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  details TEXT DEFAULT '',
  photos TEXT DEFAULT '[]',
  max_retries INTEGER DEFAULT 2,
  auto_mode TEXT DEFAULT 'off',
  auto_status TEXT DEFAULT 'idle',
  auto_message TEXT DEFAULT '',
  anchor_slot_id INTEGER,
  style_spec TEXT DEFAULT '',
  cancel INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  type TEXT DEFAULT 'features',
  brief TEXT DEFAULT '',
  status TEXT DEFAULT 'empty',
  message TEXT DEFAULT '',
  selected_prompt_id INTEGER,
  approved_image_id INTEGER
);
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  label TEXT DEFAULT '',
  source TEXT DEFAULT 'variation',
  recommended INTEGER DEFAULT 0,
  batch TEXT,
  template_version TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  prompt_id INTEGER,
  path TEXT NOT NULL,
  qc TEXT,
  approved INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT
);
`;

function init() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const d = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);
  // Jobs run in memory, so anything still "busy" after a restart was interrupted.
  d.prepare(
    "UPDATE slots SET status='error', message='Interrupted by a server restart. Please try again.' WHERE status IN ('prompting','generating')"
  ).run();
  d.prepare(
    "UPDATE products SET auto_status='stopped', auto_message='Interrupted by a server restart.' WHERE auto_status='running'"
  ).run();
  return d;
}

const g = globalThis;
export const db = g.__infographicDb || (g.__infographicDb = init());

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const now = () => new Date().toISOString();
export const insertId = (r) => Number(r.lastInsertRowid);

// ---------- file storage ----------
export function saveFile(buf, ext, sub) {
  const rel = `${sub}/${crypto.randomUUID()}.${ext}`;
  fs.mkdirSync(path.join(FILES_DIR, sub), { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, rel), buf);
  return rel;
}

export function absPath(rel) {
  const root = path.resolve(FILES_DIR);
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error('Bad file path');
  return p;
}

export const readFile = (rel) => fs.readFileSync(absPath(rel));

export function deleteFile(rel) {
  try {
    fs.unlinkSync(absPath(rel));
  } catch {
    /* ignore */
  }
}
