const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
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
      'SELECT id, name, email, pix_key, price_photo_cents, price_video_cents FROM photographers WHERE id = $1',
      [req.photographerId]
    );
    if (!photographer) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }
    res.json(photographer);
  } catch (e) {
    next(e);
  }
});

// Cadastra/edita a chave Pix fixa do fotógrafo. É essa chave que entra no
// Pix copia-e-cola gerado pra cada pedido.
router.put('/pix-key', requirePhotographer, async (req, res, next) => {
  try {
    const pixKey = typeof req.body?.pix_key === 'string' ? req.body.pix_key.trim() : '';
    if (!pixKey || pixKey.length > 77) {
      return res.status(400).json({ error: 'pix_key é obrigatória (texto de até 77 caracteres).' });
    }

    await db.query('UPDATE photographers SET pix_key = $1 WHERE id = $2', [pixKey, req.photographerId]);
    res.json({ pix_key: pixKey });
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

module.exports = router;
