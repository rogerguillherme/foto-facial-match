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

function loadResultsWithMedia(searchId) {
  return db
    .prepare(
      `SELECT sr.similarity, m.id as media_id, m.type, m.event_name, m.price_cents, m.storage_path
       FROM search_results sr
       JOIN media m ON m.id = sr.media_id
       WHERE sr.search_id = ?
       ORDER BY sr.similarity DESC`
    )
    .all(searchId)
    .map((r) => ({
      media_id: r.media_id,
      type: r.type,
      event_name: r.event_name,
      price_cents: r.price_cents,
      url: storage.publicUrl(r.storage_path),
      similarity: Math.round(r.similarity * 100) / 100,
    }));
}

// Cliente final envia a selfie -> busca por similaridade no catálogo inteiro.
router.post('/', (req, res) => {
  upload.single('selfie')(req, res, async (err) => {
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

    const selfiePath = storage.save('selfies', req.file.buffer, req.file.originalname);
    const searchResult = db.prepare('INSERT INTO searches (selfie_storage_path) VALUES (?)').run(selfiePath);
    const searchId = Number(searchResult.lastInsertRowid);

    const insertResult = db.prepare('INSERT INTO search_results (search_id, media_id, similarity) VALUES (?, ?, ?)');
    for (const match of matches) {
      insertResult.run(searchId, match.mediaId, match.similarity);
    }

    res.status(201).json({
      search_id: searchId,
      provider: faceRecognition.providerName,
      results: loadResultsWithMedia(searchId),
    });
  });
});

// Listagem dos resultados de uma busca já feita (ex.: cliente volta depois).
router.get('/:searchId', (req, res) => {
  const searchId = Number.parseInt(req.params.searchId, 10);
  if (!Number.isInteger(searchId)) {
    return res.status(400).json({ error: 'searchId inválido.' });
  }
  const search = db.prepare('SELECT id FROM searches WHERE id = ?').get(searchId);
  if (!search) {
    return res.status(404).json({ error: 'Busca não encontrada.' });
  }
  res.json({ search_id: searchId, results: loadResultsWithMedia(searchId) });
});

module.exports = router;
