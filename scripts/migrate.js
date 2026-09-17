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
  // Tipo da chave Pix (cpf/cnpj/email/phone/evp), gravado junto com a chave já
  // normalizada (ver src/services/pixKey.js). Nullable: chaves cadastradas
  // antes desta coluna existir ficam sem tipo até o fotógrafo salvar de novo —
  // a normalização passa a valer no próximo salvamento.
  await db.query(`
    ALTER TABLE photographers ADD COLUMN IF NOT EXISTS pix_key_type TEXT;
  `);
  // Versão com marca d'água da foto (gerada no upload, ver src/routes/media.js),
  // mostrada nos resultados de busca por selfie antes da compra. Nullable:
  // vídeo não tem (fora de escopo) e foto cuja marca d'água falhou ao gerar
  // também fica sem — busca cai pro original nesse caso raro (ver match.js).
  await db.query(`
    ALTER TABLE media ADD COLUMN IF NOT EXISTS preview_storage_path TEXT;
  `);

  // Pedido deixa de ser 1 pedido = 1 mídia: agora um pedido pode cobrir N
  // mídias (cliente seleciona várias no resultado da busca e paga um Pix só
  // com o valor total). Escolha de schema: tabela `order_items` (order_id +
  // media_id + price_cents congelado no momento da compra, mesmo padrão já
  // usado em `media.price_cents`) em vez de espremer uma lista dentro de
  // `orders` — cada item continua uma linha simples, sem JSON solto pra
  // parsear. `orders.media_id` fica nullable e não é mais preenchido em
  // pedidos novos (a lista de mídias mora em `order_items`), mas pedidos
  // antigos continuam com o valor original — o backend cai pro fallback via
  // `orders.media_id` quando não há `order_items` pra aquele pedido (ver
  // `loadOrderItems` em src/routes/orders.js). Nenhum dado existente é
  // migrado/apagado.
  await db.query(`
    ALTER TABLE orders ALTER COLUMN media_id DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      media_id INTEGER NOT NULL REFERENCES media(id),
      price_cents INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
  `);

  console.log('Schema Postgres criado/confirmado.');
  await db.pool.end();
}

migrate().catch((e) => {
  console.error('Falha ao migrar schema:', e);
  process.exit(1);
});
