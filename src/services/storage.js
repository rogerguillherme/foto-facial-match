// Storage em Vercel Blob (era disco local em uploads/<categoria>/<arquivo>).
// Filesystem da Vercel é efêmero, então mídia/comprovante precisam viver
// fora do processo da função. `put()` já devolve a URL pública final do
// arquivo, então guardamos essa URL direto como storage_path — publicUrl()
// vira identidade, sem reconstrução de caminho.
const path = require('node:path');
const crypto = require('node:crypto');
const { put } = require('@vercel/blob');

async function save(category, buffer, originalName) {
  const ext = path.extname(originalName || '') || '';
  const filename = `${category}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const blob = await put(filename, buffer, { access: 'public', addRandomSuffix: false });
  return blob.url; // storage_path salvo no banco já é a URL pública do Blob
}

function publicUrl(storagePath) {
  return storagePath;
}

module.exports = { save, publicUrl };
