const express = require('express');
const db = require('../db');
const storage = require('../services/storage');
const faceRecognition = require('../services/faceRecognition');
const watermark = require('../services/watermark');
const { requirePhotographer } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/;
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

function pathnameOf(url) {
  return new URL(url).pathname.slice(1); // sem a barra inicial
}

// Emite o token de upload direto pro Blob (o navegador do fotógrafo fala
// direto com o Blob storage a partir daqui, sem passar o arquivo pelo corpo
// desta function — ver aviso de limite de request body no README).
router.post('/upload-url', requirePhotographer, async (req, res) => {
  await storage.handleClientUpload(req, res, async (pathname) => {
    if (!pathname.startsWith('photos/') && !pathname.startsWith('videos/')) {
      throw new Error('Caminho de upload inválido.');
    }
    return {
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'],
      maximumSizeInBytes: MAX_SIZE_BYTES,
    };
  });
});

// Registra no catálogo a mídia que o fotógrafo acabou de subir direto pro
// Blob (fluxo: front chama upload-url -> sobe pro Blob -> chama aqui com a
// URL resultante).
router.post('/', requirePhotographer, async (req, res, next) => {
  try {
    const blobUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type : '';
    const originalName = typeof req.body?.original_name === 'string' ? req.body.original_name.trim().slice(0, 200) : '';
    const eventName = typeof req.body?.event_name === 'string' ? req.body.event_name.slice(0, 200) : null;

    if (!blobUrl || !storage.isOwnBlobUrl(blobUrl) || !ALLOWED_MIME.test(contentType) || !originalName) {
      return res.status(400).json({
        error: 'url (do upload direto ao Blob), content_type (JPEG, PNG, WEBP, MP4 ou MOV) e original_name são obrigatórios e válidos.',
      });
    }

    const type = contentType.startsWith('video/') ? 'video' : 'photo';
    const expectedPrefix = type === 'video' ? 'videos/' : 'photos/';
    if (!pathnameOf(blobUrl).startsWith(expectedPrefix)) {
      return res.status(400).json({ error: 'URL de mídia não corresponde ao tipo de upload esperado.' });
    }

    // Preço não vem do cliente: é fixo por tipo, configurado uma vez pelo
    // fotógrafo em PUT /api/auth/pricing (0 se ele ainda não configurou).
    const photographer = await db.get(
      'SELECT price_photo_cents, price_video_cents FROM photographers WHERE id = $1',
      [req.photographerId]
    );
    const priceCents = type === 'video' ? photographer.price_video_cents : photographer.price_photo_cents;

    const inserted = await db.get(
      `INSERT INTO media (photographer_id, type, event_name, price_cents, original_name, storage_path, face_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
      [req.photographerId, type, eventName, priceCents, originalName, blobUrl]
    );
    const mediaId = inserted.id;

    let faceStatus = 'pending';
    if (type === 'photo') {
      try {
        // Requisição de SAÍDA pro Blob (baixar os bytes pra indexar o
        // rosto) — não tem o limite de ~4.5MB, que é só pra corpo de
        // requisição de ENTRADA das serverless functions.
        const resp = await fetch(blobUrl);
        if (!resp.ok) throw new Error(`download do Blob falhou (status ${resp.status})`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        faceStatus = await faceRecognition.indexPhotoFace(mediaId, buffer);

        try {
          // Preview com marca d'água pro cliente ver antes de comprar (blob
          // separado, original intacto). Texto = nome do evento, ou
          // "PREVIEW" se o fotógrafo não informou um.
          const watermarked = await watermark.addWatermark(buffer, eventName);
          const preview = await storage.putPreview(mediaId, watermarked);
          await db.query('UPDATE media SET preview_storage_path = $1 WHERE id = $2', [preview.url, mediaId]);
        } catch (e) {
          // Sem marca d'água não deve travar o upload: a busca cai pro
          // original nesse caso raro (ver COALESCE em match.js).
          console.error(`[media] falha ao gerar marca d'água da mídia ${mediaId}:`, e.message);
        }
      } catch (e) {
        await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['failed', mediaId]);
        faceStatus = 'failed';
        // Erro de integração externa (ex.: Rekognition fora do ar, ou o
        // próprio Blob) não deve derrubar o registro — a mídia já foi
        // salva, só o índice de rosto falhou.
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
      url: storage.publicUrl(blobUrl),
      face_status: faceStatus,
    });
  } catch (e) {
    next(e);
  }
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
