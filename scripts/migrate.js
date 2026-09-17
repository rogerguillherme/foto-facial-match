// Cria o schema no Postgres (Neon). Roda uma vez, manualmente, contra o banco
// de cada ambiente (`node scripts/migrate.js`, com DATABASE_URL no .env
// apontando pro banco certo) — não a cada cold start da função serverless.
// Todo CREATE TABLE é IF NOT EXISTS, então rodar de novo não quebra nada.
const db = require('../src/db');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS photographers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      pix_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      photographer_id INTEGER NOT NULL REFERENCES photographers(id),
      type TEXT NOT NULL CHECK (type IN ('photo','video')),
      event_name TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      original_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      face_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS media_faces (
      id SERIAL PRIMARY KEY,
      media_id INTEGER NOT NULL REFERENCES media(id),
      external_face_id TEXT NOT NULL,
      embedding_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_media_faces_media_id ON media_faces(media_id);

    CREATE TABLE IF NOT EXISTS searches (
      id SERIAL PRIMARY KEY,
      selfie_storage_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS search_results (
      id SERIAL PRIMARY KEY,
      search_id INTEGER NOT NULL REFERENCES searches(id),
      media_id INTEGER NOT NULL REFERENCES media(id),
      similarity REAL NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_search_results_search_id ON search_results(search_id);

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      media_id INTEGER NOT NULL REFERENCES media(id),
      buyer_name TEXT NOT NULL,
      buyer_phone TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      pix_code TEXT NOT NULL,
      proof_path TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Preço passou de "por item" (price_cents em cada mídia) pra "fixo por tipo",
  // configurado uma vez pelo fotógrafo. ADD COLUMN IF NOT EXISTS pra rodar sem
  // quebrar em bancos que já têm a tabela (mesmo padrão idempotente do resto
  // do arquivo). Sem default vazio: 0 até o fotógrafo configurar.
  await db.query(`
    ALTER TABLE photographers ADD COLUMN IF NOT EXISTS price_photo_cents INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE photographers ADD COLUMN IF NOT EXISTS price_video_cents INTEGER NOT NULL DEFAULT 0;
  `);
  // Versão com marca d'água da foto (gerada no upload, ver src/routes/media.js),
  // mostrada nos resultados de busca por selfie antes da compra. Nullable:
  // vídeo não tem (fora de escopo) e foto cuja marca d'água falhou ao gerar
  // também fica sem — busca cai pro original nesse caso raro (ver match.js).
  await db.query(`
    ALTER TABLE media ADD COLUMN IF NOT EXISTS preview_storage_path TEXT;
  `);

  console.log('Schema Postgres criado/confirmado.');
  await db.pool.end();
}

migrate().catch((e) => {
  console.error('Falha ao migrar schema:', e);
  process.exit(1);
});
