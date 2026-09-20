// Migra os arquivos do Vercel Blob (suspenso) pro Cloudflare R2, mantendo a
// MESMA key/pathname, e reescreve a URL nas colunas do banco.
//   node scripts/migrate-blob-to-r2.js            # --dry-run (padrão): só lista
//   node scripts/migrate-blob-to-r2.js --apply    # baixa, sobe pro R2, atualiza o banco
// Precisa de DATABASE_URL e R2_* no ambiente. Idempotente: linhas cuja URL já
// é do R2_PUBLIC_URL são puladas, então dá pra rodar de novo após falhas
// (o store suspenso pode recusar downloads; cada arquivo falha isolado).
require('dotenv').config();
const db = require('../src/db');
const config = require('../src/config');
const storage = require('../src/services/storage');

const OLD_HOST = 'wef4si2tcenjwlf1.public.blob.vercel-storage.com';
const apply = process.argv.includes('--apply');

// Colunas com URL de Blob (ver scripts/migrate.js). media_faces/search_results
// não guardam URL.
const COLUMNS = [
  ['media', 'storage_path'],
  ['media', 'preview_storage_path'],
  ['photographers', 'profile_photo_path'],
  ['orders', 'proof_path'],
  ['searches', 'selfie_storage_path'],
];

async function main() {
  if (apply && !config.r2.publicUrl) throw new Error('Defina as variáveis R2_* antes de usar --apply.');
  const base = (config.r2.publicUrl || '').replace(/\/+$/, '');
  const stats = { migrated: 0, skipped: 0, failed: 0 };
  const failures = [];

  for (const [table, column] of COLUMNS) {
    const { rows } = await db.query(`SELECT id, ${column} AS url FROM ${table} WHERE ${column} IS NOT NULL`);
    for (const row of rows) {
      const label = `${table}.${column}#${row.id}`;
      let parsed;
      try {
        parsed = new URL(row.url);
      } catch {
        stats.skipped++; // caminho relativo antigo ou vazio: nada a migrar
        continue;
      }
      if (parsed.host !== OLD_HOST) {
        stats.skipped++; // já é R2 (ou outro host): idempotência
        continue;
      }
      const key = decodeURIComponent(parsed.pathname.slice(1));
      const newUrl = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
      if (!apply) {
        console.log(`[dry-run] ${label}: ${row.url} -> ${newUrl}`);
        stats.migrated++;
        continue;
      }
      try {
        const resp = await fetch(row.url);
        if (!resp.ok) throw new Error(`download falhou (status ${resp.status})`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get('content-type') || 'application/octet-stream';
        // Uma transação por linha: o UPDATE só é confirmado se o upload deu certo.
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          await storage.putObject(key, buffer, contentType);
          await client.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2 AND ${column} = $3`, [newUrl, row.id, row.url]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
        stats.migrated++;
        console.log(`ok ${label}`);
      } catch (e) {
        stats.failed++;
        failures.push(`${label} (${row.url}): ${e.message}`);
      }
    }
  }

  console.log(`\nResumo (${apply ? 'apply' : 'dry-run'}): ${stats.migrated} migrados, ${stats.skipped} pulados, ${stats.failed} falhas`);
  failures.forEach((f) => console.log(`  FALHA ${f}`));
  await db.pool.end();
  if (stats.failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Falha na migração:', e);
  process.exit(1);
});
