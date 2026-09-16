// Persistência simples em SQLite via módulo nativo do Node (node:sqlite, estável
// a partir do Node 22.5). Sem dependência externa, sem build nativo (evita a dor
// de compilar better-sqlite3 no Windows sem Visual Studio instalado).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS photographers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pix_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photographer_id INTEGER NOT NULL REFERENCES photographers(id),
    type TEXT NOT NULL CHECK (type IN ('photo','video')),
    event_name TEXT,
    price_cents INTEGER NOT NULL DEFAULT 0,
    original_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    face_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media_faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id),
    external_face_id TEXT NOT NULL,
    embedding_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_media_faces_media_id ON media_faces(media_id);

  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    selfie_storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS search_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER NOT NULL REFERENCES searches(id),
    media_id INTEGER NOT NULL REFERENCES media(id),
    similarity REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_search_results_search_id ON search_results(search_id);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id),
    buyer_name TEXT NOT NULL,
    buyer_phone TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    pix_code TEXT NOT NULL,
    proof_path TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_payment',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migração leve pra bancos criados antes da chave Pix/fluxo de comprovante
// existirem: sem framework de migration, só ALTER TABLE idempotente (ignora
// "duplicate column" se a coluna já existe).
function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
addColumnIfMissing('photographers', 'pix_key TEXT');
addColumnIfMissing('orders', 'buyer_name TEXT');
addColumnIfMissing('orders', 'buyer_phone TEXT');
addColumnIfMissing('orders', 'pix_code TEXT');
addColumnIfMissing('orders', 'proof_path TEXT');

module.exports = db;
