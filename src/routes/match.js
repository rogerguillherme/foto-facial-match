const express = require('express');
const db = require('../db');
const storage = require('../services/storage');
const faceRecognition = require('../services/faceRecognition');

const router = express.Router();

const ALLOWED_MIME = /^image\/(jpeg|png|webp)$/;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB, é só uma selfie

function pathnameOf(url) {
  return new URL(url).pathname.slice(1);
}

async function loadResultsWithMedia(searchId) {
  const rows = await db.all(
    `SELECT sr.similarity, m.id as media_id, m.type, m.event_name, m.price_cents, m.storage_path
     FROM search_results sr
     JOIN media m ON m.id = sr.media_id
     WHERE sr.search_id = $1
     ORDER BY sr.similarity DESC`,
    [searchId]
  );
  return rows.map((r) => ({
    media_id: r.media_id,
    type: r.type,
    event_name: r.event_name,
    price_cents: r.price_cents,
    url: storage.publicUrl(r.storage_path),
    similarity: Math.round(r.similarity * 100) / 100,
  }));
}

// Emite o token de upload direto pro Blob pra selfie do cliente (público —
// mesma rota é usada por qualquer visitante, sem login).
router.post('/upload-url', async (req, res) => {
  await storage.handleClientUpload(req, res, async (pathname) => {
    if (!pathname.startsWith('selfies/')) {
      throw new Error('Caminho de upload inválido.');
    }
    return {
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maximumSizeInBytes: MAX_SIZE_BYTES,
    };
  });
});

// Cliente final já subiu a selfie direto pro Blob -> busca por similaridade
// no catálogo inteiro.
router.post('/', async (req, res, next) => {
  try {
    const selfieUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type : '';

    if (!selfieUrl || !storage.isOwnBlobUrl(selfieUrl) || !ALLOWED_MIME.test(contentType) ||
        !pathnameOf(selfieUrl).startsWith('selfies/')) {
      return res.status(400).json({
        error: 'url (do upload direto ao Blob) e content_type (JPEG, PNG ou WEBP) são obrigatórios e válidos.',
      });
    }

    let selfieBuffer;
    try {
      // Requisição de SAÍDA pro Blob — sem o limite de ~4.5MB de corpo de
      // requisição de ENTRADA das serverless functions.
      const resp = await fetch(selfieUrl);
      if (!resp.ok) throw new Error(`download do Blob falhou (status ${resp.status})`);
      selfieBuffer = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      console.error('[match] falha ao baixar a selfie do Blob:', e.message);
      return res.status(502).json({ error: 'Não foi possível processar a selfie agora. Tente novamente.' });
    }

    let matches;
    try {
      matches = await faceRecognition.searchBySelfie(selfieBuffer);
    } catch (e) {
      console.error('[match] falha na busca por similaridade facial:', e.message);
      return res.status(502).json({ error: 'Não foi possível processar a selfie agora. Tente novamente.' });
    }

    const inserted = await db.get('INSERT INTO searches (selfie_storage_path) VALUES ($1) RETURNING id', [
      selfieUrl,
    ]);
    const searchId = inserted.id;

    for (const match of matches) {
      await db.query('INSERT INTO search_results (search_id, media_id, similarity) VALUES ($1, $2, $3)', [
        searchId,
        match.mediaId,
        match.similarity,
      ]);
    }

    res.status(201).json({
      search_id: searchId,
      provider: faceRecognition.providerName,
      results: await loadResultsWithMedia(searchId),
    });
  } catch (e) {
    next(e);
  }
});

// Listagem dos resultados de uma busca já feita (ex.: cliente volta depois).
router.get('/:searchId', async (req, res, next) => {
  try {
    const searchId = Number.parseInt(req.params.searchId, 10);
    if (!Number.isInteger(searchId)) {
      return res.status(400).json({ error: 'searchId inválido.' });
    }
    const search = await db.get('SELECT id FROM searches WHERE id = $1', [searchId]);
    if (!search) {
      return res.status(404).json({ error: 'Busca não encontrada.' });
    }
    res.json({ search_id: searchId, results: await loadResultsWithMedia(searchId) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
