const express = require('express');
const multer = require('multer');
const db = require('../db');
const storage = require('../services/storage');
const faceRecognition = require('../services/faceRecognition');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, é só uma selfie
  fileFilter(req, file, cb) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      return cb(new Error('Selfie precisa ser JPEG, PNG ou WEBP.'));
    }
    cb(null, true);
  },
});

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

// Cliente final envia a selfie -> busca por similaridade no catálogo inteiro.
router.post('/', (req, res, next) => {
  upload.single('selfie')(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Envie a selfie no campo "selfie" (multipart/form-data).' });
      }

      let matches;
      try {
        matches = await faceRecognition.searchBySelfie(req.file.buffer);
      } catch (e) {
        console.error('[match] falha na busca por similaridade facial:', e.message);
        return res.status(502).json({ error: 'Não foi possível processar a selfie agora. Tente novamente.' });
      }

      const selfiePath = await storage.save('selfies', req.file.buffer, req.file.originalname);
      const inserted = await db.get('INSERT INTO searches (selfie_storage_path) VALUES ($1) RETURNING id', [
        selfiePath,
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
