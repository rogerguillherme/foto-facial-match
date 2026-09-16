// Persistência em Postgres hospedado (Neon, via integração da Vercel).
// Trocado de node:sqlite porque o filesystem das funções serverless da
// Vercel é efêmero: um arquivo .sqlite não sobrevive entre invocações/deploys.
// Sem ORM — só `pg` (client leve) e o mesmo SQL explícito de antes, ajustando
// sintaxe (placeholders $1, RETURNING id em vez de lastInsertRowid).
const { Pool } = require('pg');
const config = require('./config');

if (!config.databaseUrl) {
  throw new Error(
    'DATABASE_URL não configurada. Defina a connection string do Postgres (Neon/Vercel Postgres) no .env ou nas env vars do projeto.'
  );
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Neon/Supabase exigem TLS; certificado da cadeia gerenciada não é
  // verificável localmente, então relaxamos a verificação (comum pra esses
  // provedores serverless — não é um Postgres com cert próprio pra validar).
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function get(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0];
}

async function all(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

module.exports = { pool, query, get, all };
