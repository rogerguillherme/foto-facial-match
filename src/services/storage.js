// Storage local em disco. Guarda tudo em uploads/<categoria>/<arquivo>.
// ponytail: sem S3 agora — troque este arquivo por um client do S3/R2 quando
// precisar servir de fora de uma única máquina; o resto do app só chama
// save()/absolutePath()/publicUrl(), então a troca fica isolada aqui.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

function save(category, buffer, originalName) {
  const dir = path.join(config.uploadsDir, category);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(originalName || '') || '';
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return `${category}/${filename}`; // storage_path relativo, salvo no banco
}

function absolutePath(storagePath) {
  return path.join(config.uploadsDir, storagePath);
}

function readBuffer(storagePath) {
  return fs.readFileSync(absolutePath(storagePath));
}

function publicUrl(storagePath) {
  // Servido estaticamente pelo Express em /files (ver app.js).
  return `/files/${storagePath.replace(/\\/g, '/')}`;
}

module.exports = { save, absolutePath, readBuffer, publicUrl };
