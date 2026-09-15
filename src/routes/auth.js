const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

const router = express.Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Cadastro do fotógrafo (dono do catálogo).
router.post('/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !isValidEmail(email) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({
      error: 'Dados inválidos: name (texto), email (formato válido) e password (mín. 8 caracteres) são obrigatórios.',
    });
  }

  const existing = db.prepare('SELECT id FROM photographers WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO photographers (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, passwordHash);

  const token = jwt.sign({ photographerId: Number(result.lastInsertRowid) }, config.jwtSecret, {
    expiresIn: '30d',
  });
  res.status(201).json({ token, photographer: { id: Number(result.lastInsertRowid), name, email } });
});

// Login do fotógrafo.
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Informe email e password.' });
  }

  const photographer = db.prepare('SELECT * FROM photographers WHERE email = ?').get(email);
  const valid = photographer && bcrypt.compareSync(password, photographer.password_hash);
  if (!valid) {
    // Mensagem genérica de propósito: não revela se o e-mail existe ou não.
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  const token = jwt.sign({ photographerId: photographer.id }, config.jwtSecret, { expiresIn: '30d' });
  res.json({ token, photographer: { id: photographer.id, name: photographer.name, email: photographer.email } });
});

module.exports = router;
