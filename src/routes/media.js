const express = require('express');
const multer = require('multer');
const db = require('../db');
const storage = require('../services/storage');
const faceRecognition = require('../services/faceRecognition');
const { requirePhotographer } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new Error('Tipo de arquivo não suportado. Use JPEG, PNG, WEBP, MP4 ou MOV.'));
    }
    cb(null, true);
  },
});

// Upload de foto/vídeo pelo fotógrafo autenticado.
router.post('/', requirePhotographer, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Envie o arquivo no campo "file" (multipart/form-data).' });
      }

      const eventName = typeof req.body.event_name === 'string' ? req.body.event_name.slice(0, 200) : null;
      const type = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';

      // Preço não vem mais do cliente: é fixo por tipo, configurado uma vez
      // pelo fotógrafo em PUT /api/auth/pricing (0 se ele ainda não configurou).
      const photographer = await db.get(
        'SELECT price_photo_cents, price_video_cents FROM photographers WHERE id = $1',
        [req.photographerId]
      );
      const priceCents = type === 'video' ? photographer.price_video_cents : photographer.price_photo_cents;

      const storagePath = await storage.save(
        type === 'video' ? 'videos' : 'photos',
        req.file.buffer,
        req.file.originalname
      );

      const inserted = await db.get(
        `INSERT INTO media (photographer_id, type, event_name, price_cents, original_name, storage_path, face_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
        [req.photographerId, type, eventName, priceCents, req.file.originalname, storagePath]
      );
      const mediaId = inserted.id;

      let faceStatus = 'pending';
      if (type === 'photo') {
        try {
          faceStatus = await faceRecognition.indexPhotoFace(mediaId, req.file.buffer);
        } catch (e) {
          await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['failed', mediaId]);
          faceStatus = 'failed';
          // Erro de integração externa (ex.: Rekognition fora do ar) não deve
          // derrubar o upload — a mídia já foi salva, só o índice de rosto falhou.
          console.error(`[media] falha ao indexar rosto da mídia ${mediaId}:`, e.message);
        }
      } else {
        // TODO: reconhecimento facial em vídeo requer extrair frames (ex.: ffmpeg)
        // e indexar cada frame. Fora do escopo desta base; vídeos ficam guardados
        // e listados, mas não aparecem em busca por selfie ainda.
        await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['skipped_video', mediaId]);
        faceStatus = 'skipped_video';
      }

      res.status(201).json({
        id: mediaId,
        type,
        event_name: eventName,
        price_cents: priceCents,
        url: storage.publicUrl(storagePath),
        face_status: faceStatus,
      });
    } catch (e) {
      next(e);
    }
  });
});

// Catálogo do próprio fotógrafo (conferência rápida do que foi enviado).
router.get('/', requirePhotographer, async (req, res, next) => {
  try {
    const rows = await db.all(
      'SELECT id, type, event_name, price_cents, original_name, storage_path, face_status, created_at FROM media WHERE photographer_id = $1 ORDER BY id DESC',
      [req.photographerId]
    );
    res.json(rows.map((r) => ({ ...r, url: storage.publicUrl(r.storage_path) })));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
