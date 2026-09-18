const express = require('express');
const db = require('../db');
const { isValidCpf } = require('../services/pixKey');

const router = express.Router();

// Captura o lead (nome+CPF) que acessou a página pública de um fotógrafo,
// antes de liberar a busca por selfie — pro fotógrafo fazer follow-up
// comercial mesmo de quem não chega a comprar. Sem autenticação por design.
router.post('/', async (req, res, next) => {
  try {
    const photographerId = Number.parseInt(req.body?.photographer_id, 10);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const cpfDigits = typeof req.body?.cpf === 'string' ? req.body.cpf.replace(/\D/g, '') : '';

    if (!Number.isInteger(photographerId)) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Informe o nome (máx. 120 caracteres).' });
    }
    if (!isValidCpf(cpfDigits)) {
      return res.status(400).json({ error: 'CPF inválido: confira os 11 dígitos.' });
    }

    const photographer = await db.get('SELECT id FROM photographers WHERE id = $1', [photographerId]);
    if (!photographer) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }

    await db.query(
      'INSERT INTO leads (photographer_id, name, cpf) VALUES ($1, $2, $3)',
      [photographerId, name, cpfDigits]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
