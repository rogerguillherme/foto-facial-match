const express = require('express');
const multer = require('multer');
const db = require('../db');
const storage = require('../services/storage');
const pix = require('../services/pix');

const router = express.Router();

const PROOF_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, é só um comprovante
  fileFilter(req, file, cb) {
    if (!PROOF_MIME.test(file.mimetype)) {
      return cb(new Error('Tipo de arquivo não suportado. Envie JPEG, PNG, WEBP ou PDF.'));
    }
    cb(null, true);
  },
});

function getMediaWithPhotographer(mediaId) {
  return db.get(
    `SELECT m.id, m.price_cents, m.storage_path, m.type,
            p.id AS photographer_id, p.name AS photographer_name, p.pix_key
     FROM media m JOIN photographers p ON p.id = m.photographer_id
     WHERE m.id = $1`,
    [mediaId]
  );
}

function serializeOrder(order, media) {
  const out = {
    order_id: order.id,
    media_id: order.media_id,
    amount_cents: order.amount_cents,
    status: order.status,
    buyer_name: order.buyer_name,
  };
  if (order.status === 'awaiting_payment') {
    out.pix_code = order.pix_code;
  }
  if (order.status === 'paid' && media) {
    out.download_url = storage.publicUrl(media.storage_path);
  }
  return out;
}

// Cria o pedido: valida comprador + mídia, gera o Pix copia-e-cola estático
// com a chave do fotógrafo e o valor exato da mídia. Ninguém paga nada ainda
// aqui — só gera o código pro cliente pagar por fora (app do banco).
router.post('/', async (req, res, next) => {
  try {
    const mediaId = Number.parseInt(req.body?.media_id, 10);
    const buyerName = typeof req.body?.buyer_name === 'string' ? req.body.buyer_name.trim() : '';
    const buyerPhone = typeof req.body?.buyer_phone === 'string' ? req.body.buyer_phone.trim() : '';

    if (!Number.isInteger(mediaId) || !buyerName || buyerName.length > 120) {
      return res.status(400).json({ error: 'media_id (inteiro) e buyer_name (texto) são obrigatórios.' });
    }
    if (!buyerPhone || buyerPhone.replace(/\D/g, '').length < 8 || buyerPhone.length > 30) {
      return res.status(400).json({ error: 'buyer_phone é obrigatório e precisa ser um telefone válido.' });
    }

    const media = await getMediaWithPhotographer(mediaId);
    if (!media) {
      return res.status(404).json({ error: 'Mídia não encontrada.' });
    }
    if (!media.pix_key) {
      return res.status(400).json({ error: 'O fotógrafo ainda não cadastrou a chave Pix. Peça pra ele configurar antes de comprar.' });
    }

    const generated = pix.buildStaticPix({
      pixKey: media.pix_key,
      merchantName: media.photographer_name,
      amountCents: media.price_cents,
      infoAdicional: `Midia ${media.id}`,
    });
    if (generated.error) {
      // Erro de configuração da chave Pix do fotógrafo (formato inválido etc.),
      // não do cliente — mas quem vai agir é o cliente, então avisamos os dois.
      return res.status(400).json({ error: `Não foi possível gerar o Pix: ${generated.error}` });
    }

    const inserted = await db.get(
      `INSERT INTO orders (media_id, buyer_name, buyer_phone, amount_cents, pix_code, status)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_payment') RETURNING id`,
      [mediaId, buyerName, buyerPhone, media.price_cents, generated.brCode]
    );

    const qrCodeDataUrl = await generated.toQrDataUrl().catch(() => null);

    res.status(201).json({
      order_id: inserted.id,
      media_id: mediaId,
      amount_cents: media.price_cents,
      status: 'awaiting_payment',
      pix_code: generated.brCode,
      qr_code_data_url: qrCodeDataUrl,
    });
  } catch (e) {
    next(e);
  }
});

// Consulta o status do pedido (usado pra reabrir a tela depois de recarregar
// a página, sem precisar refazer a busca por selfie).
router.get('/:id', async (req, res, next) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ error: 'id inválido.' });
    }
    const order = await db.get('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const media = await getMediaWithPhotographer(order.media_id);
    res.json(serializeOrder(order, media));
  } catch (e) {
    next(e);
  }
});

// Cliente sobe o comprovante do Pix. A partir daqui o pedido já é liberado.
//
// ponytail: NÃO existe verificação real de pagamento (sem gateway, sem
// webhook do banco, sem OCR do comprovante). O pedido vira "paid" só por
// receber um arquivo aqui — decisão consciente do dono do produto, que
// vende pra gente conhecida e prefere confiar a bloquear compra por
// fricção de aprovação manual/IA. Se algum dia isso mudar (público maior,
// desconhecidos), o upgrade natural é: gateway Pix real com webhook de
// confirmação, ou pelo menos revisão manual antes de liberar.
router.post('/:id/proof', async (req, res, next) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ error: 'id inválido.' });
    }
    const order = await db.get('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    if (order.status !== 'awaiting_payment') {
      return res.status(409).json({ error: `Pedido já está com status "${order.status}".` });
    }

    uploadProof.single('proof')(req, res, async (err) => {
      try {
        if (err) {
          return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'Envie o comprovante no campo "proof" (multipart/form-data).' });
        }

        const proofPath = await storage.save('proofs', req.file.buffer, req.file.originalname);

        // Libera o pedido na hora, sem checar nada do comprovante em si — ver
        // aviso ponytail acima do handler.
        await db.query('UPDATE orders SET proof_path = $1, status = $2 WHERE id = $3', [proofPath, 'paid', orderId]);

        const media = await getMediaWithPhotographer(order.media_id);
        const updatedOrder = { ...order, proof_path: proofPath, status: 'paid' };
        res.json(serializeOrder(updatedOrder, media));
      } catch (e2) {
        next(e2);
      }
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
