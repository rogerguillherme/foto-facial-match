const express = require('express');
const db = require('../db');

const router = express.Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// STUB de compra: registra a intenção de compra e marca como "paga" na hora.
// TODO: trocar por integração real de pagamento (ex.: Stripe/Mercado Pago)
// antes de ir para produção — hoje não cobra ninguém de verdade.
router.post('/', (req, res) => {
  const mediaId = Number.parseInt(req.body?.media_id, 10);
  const buyerEmail = req.body?.buyer_email;

  if (!Number.isInteger(mediaId) || !isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: 'media_id (inteiro) e buyer_email (formato válido) são obrigatórios.' });
  }

  const media = db.prepare('SELECT id, price_cents FROM media WHERE id = ?').get(mediaId);
  if (!media) {
    return res.status(404).json({ error: 'Mídia não encontrada.' });
  }

  const result = db
    .prepare('INSERT INTO orders (media_id, buyer_email, amount_cents, status) VALUES (?, ?, ?, ?)')
    .run(mediaId, buyerEmail, media.price_cents, 'stub_paid');

  res.status(201).json({
    order_id: Number(result.lastInsertRowid),
    media_id: mediaId,
    amount_cents: media.price_cents,
    status: 'stub_paid',
  });
});

module.exports = router;
