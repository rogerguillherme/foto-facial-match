const jwt = require('jsonwebtoken');
const config = require('../config');

// Login simples de fotógrafo: Bearer JWT. Sem OAuth/social, só o essencial.
function requirePhotographer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Token ausente. Faça login em /api/auth/login.' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.photographerId = payload.photographerId;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = { requirePhotographer };
