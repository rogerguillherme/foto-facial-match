const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const storage = require('../services/storage');
const { normalizePixKey } = require('../services/pixKey');
const { requirePhotographer } = require('../middleware/auth');

const router = express.Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Cadastro do fotógrafo (dono do catálogo).
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !isValidEmail(email) || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: 'Dados inválidos: name (texto), email (formato válido) e password (mín. 8 caracteres) são obrigatórios.',
      });
    }

    const existing = await db.get('SELECT id FROM photographers WHERE email = $1', [email]);
    if (existing) {
      return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const inserted = await db.get(
      'INSERT INTO photographers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, email, passwordHash]
    );

    const token = jwt.sign({ photographerId: inserted.id }, config.jwtSecret, { expiresIn: '30d' });
    res.status(201).json({ token, photographer: { id: inserted.id, name, email } });
  } catch (e) {
    next(e);
  }
});

// Login do fotógrafo.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'Informe email e password.' });
    }

    const photographer = await db.get('SELECT * FROM photographers WHERE email = $1', [email]);
    const valid = photographer && bcrypt.compareSync(password, photographer.password_hash);
    if (!valid) {
      // Mensagem genérica de propósito: não revela se o e-mail existe ou não.
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const token = jwt.sign({ photographerId: photographer.id }, config.jwtSecret, { expiresIn: '30d' });
    res.json({ token, photographer: { id: photographer.id, name: photographer.name, email: photographer.email } });
  } catch (e) {
    next(e);
  }
});

// Dados do próprio fotógrafo logado (usado pela tela de configurações pra
// mostrar a chave Pix já cadastrada).
router.get('/me', requirePhotographer, async (req, res, next) => {
  try {
    const photographer = await db.get(
      'SELECT id, name, email, pix_key, pix_key_type, price_photo_cents, price_video_cents, profile_photo_path FROM photographers WHERE id = $1',
      [req.photographerId]
    );
    if (!photographer) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }
    const { profile_photo_path, ...rest } = photographer;
    res.json({ ...rest, profile_photo_url: storage.publicUrl(profile_photo_path) });
  } catch (e) {
    next(e);
  }
});

// Cadastra/edita a chave Pix fixa do fotógrafo. É essa chave que entra no
// Pix copia-e-cola gerado pra cada pedido. A chave é NORMALIZADA/VALIDADA aqui
// (ver src/services/pixKey.js) antes de gravar, pra não gerar mais um
// copia-e-cola com chave que o banco do pagador não consegue resolver.
// `pix_key_type` (opcional) desfaz a ambiguidade entre CPF e celular de 11
// dígitos; sem ele, o tipo é detectado automaticamente quando dá.
router.put('/pix-key', requirePhotographer, async (req, res, next) => {
  try {
    const rawKey = typeof req.body?.pix_key === 'string' ? req.body.pix_key : '';
    const declaredType = typeof req.body?.pix_key_type === 'string' ? req.body.pix_key_type : undefined;

    const normalized = normalizePixKey(rawKey, declaredType);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }

    await db.query(
      'UPDATE photographers SET pix_key = $1, pix_key_type = $2 WHERE id = $3',
      [normalized.key, normalized.type, req.photographerId]
    );
    res.json({ pix_key: normalized.key, pix_key_type: normalized.type });
  } catch (e) {
    next(e);
  }
});

// Cadastra/edita o preço fixo por tipo de mídia (um valor pra qualquer foto,
// outro pra qualquer vídeo). Passa a valer pra todo upload seguinte — não é
// mais escolhido item a item.
router.put('/pricing', requirePhotographer, async (req, res, next) => {
  try {
    const pricePhotoCents = Number.parseInt(req.body?.price_photo_cents, 10);
    const priceVideoCents = Number.parseInt(req.body?.price_video_cents, 10);
    if (
      !Number.isInteger(pricePhotoCents) || pricePhotoCents < 0 ||
      !Number.isInteger(priceVideoCents) || priceVideoCents < 0
    ) {
      return res.status(400).json({
        error: 'price_photo_cents e price_video_cents são obrigatórios e devem ser inteiros >= 0 (em centavos).',
      });
    }

    await db.query(
      'UPDATE photographers SET price_photo_cents = $1, price_video_cents = $2 WHERE id = $3',
      [pricePhotoCents, priceVideoCents, req.photographerId]
    );
    res.json({ price_photo_cents: pricePhotoCents, price_video_cents: priceVideoCents });
  } catch (e) {
    next(e);
  }
});

const ALLOWED_PROFILE_PHOTO_MIME = /^image\/(jpeg|png|webp)$/;
const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

// Emite o token de upload direto pro Blob pra foto de perfil do fotógrafo,
// mesmo padrão de POST /api/media/upload-url (ver src/routes/media.js).
router.post('/profile-photo/upload-url', requirePhotographer, async (req, res) => {
  await storage.handleClientUpload(req, res, async (pathname) => {
    if (!pathname.startsWith('profile-photos/')) {
      throw new Error('Caminho de upload inválido.');
    }
    return {
      allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maximumSizeInBytes: MAX_PROFILE_PHOTO_BYTES,
    };
  });
});

// Registra a foto de perfil que o fotógrafo acabou de subir direto pro Blob
// (mostrada no painel dele e na página pública de captura de lead).
router.post('/profile-photo', requirePhotographer, async (req, res, next) => {
  try {
    const blobUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type : '';

    if (!blobUrl || !storage.isOwnBlobUrl(blobUrl) || !ALLOWED_PROFILE_PHOTO_MIME.test(contentType)) {
      return res.status(400).json({
        error: 'url (do upload direto ao Blob) e content_type (JPEG, PNG ou WEBP) são obrigatórios e válidos.',
      });
    }
    if (!new URL(blobUrl).pathname.slice(1).startsWith('profile-photos/')) {
      return res.status(400).json({ error: 'URL de foto de perfil inválida.' });
    }

    await db.query('UPDATE photographers SET profile_photo_path = $1 WHERE id = $2', [blobUrl, req.photographerId]);
    res.json({ profile_photo_url: storage.publicUrl(blobUrl) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
