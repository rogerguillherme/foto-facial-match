const express = require('express');
const db = require('../db');
const storage = require('../services/storage');

const router = express.Router();

// Perfil público do fotógrafo (nome + foto), usado pela página pública de
// captura de lead antes do cliente entrar na busca por selfie. Sem
// autenticação por design — expõe só o que é seguro mostrar (nunca email,
// pix_key etc).
router.get('/:id/public', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }

    const photographer = await db.get(
      'SELECT id, name, profile_photo_path FROM photographers WHERE id = $1',
      [id]
    );
    if (!photographer) {
      return res.status(404).json({ error: 'Fotógrafo não encontrado.' });
    }

    res.json({
      id: photographer.id,
      name: photographer.name,
      profile_photo_url: storage.publicUrl(photographer.profile_photo_path),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
