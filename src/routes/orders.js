const express = require('express');
const db = require('../db');
const storage = require('../services/storage');
const pix = require('../services/pix');
const { isValidCpf } = require('../services/pixKey');

const router = express.Router();

const PROOF_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
const MAX_PROOF_BYTES = 10 * 1024 * 1024; // 10MB, é só um comprovante
const MAX_ITEMS_PER_ORDER = 50; // sanidade, não é um limite de produto real
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathnameOf(url) {
  return new URL(url).pathname.slice(1);
}

// Aceita `media_ids` (array, fluxo novo de N mídias) ou `media_id` (compat
// com o formato antigo de 1 mídia) e normaliza pros dois casos pra uma lista
// de inteiros únicos. Retorna null se o input não é válido.
function normalizeMediaIds(body) {
  let raw = body?.media_ids;
  if (raw === undefined && body?.media_id !== undefined) raw = [body.media_id];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS_PER_ORDER) return null;
  const ids = raw.map((v) => Number.parseInt(v, 10));
  if (ids.some((n) => !Number.isInteger(n))) return null;
  return [...new Set(ids)];
}

// Carrega os itens de um pedido. Pedidos novos têm linhas em `order_items`;
// pedidos criados antes dessa tabela existir não têm (nunca migramos dados
// pra lá), então caímos pro `orders.media_id`/`amount_cents` originais nesse
// caso — ver comentário de schema em scripts/migrate.js.
async function loadOrderItems(order) {
  const rows = await db.all(
    `SELECT oi.media_id, oi.price_cents, m.type, m.storage_path
     FROM order_items oi JOIN media m ON m.id = oi.media_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [order.id]
  );
  if (rows.length > 0) return rows;
  if (!order.media_id) return [];
  const legacyMedia = await db.get('SELECT id AS media_id, type, storage_path FROM media WHERE id = $1', [order.media_id]);
  return legacyMedia ? [{ ...legacyMedia, price_cents: order.amount_cents }] : [];
}

function serializeOrder(order, items) {
  const out = {
    public_token: order.public_token,
    amount_cents: order.amount_cents,
    status: order.status,
    buyer_name: order.buyer_name,
    items: items.map((it) => {
      const item = { media_id: it.media_id, type: it.type, price_cents: it.price_cents };
      if (order.status === 'paid') item.download_url = storage.publicUrl(it.storage_path);
      return item;
    }),
  };
  if (order.status === 'awaiting_payment') {
    out.pix_code = order.pix_code;
  }
  return out;
}

// Cria o pedido: valida comprador + mídias (todas do mesmo fotógrafo, já que
// a chave Pix usada é a dele), gera UM Pix copia-e-cola estático com o valor
// somado de todas as mídias. Ninguém paga nada ainda aqui — só gera o código
// pro cliente pagar por fora (app do banco).
router.post('/', async (req, res, next) => {
  try {
    const mediaIds = normalizeMediaIds(req.body);
    const buyerName = typeof req.body?.buyer_name === 'string' ? req.body.buyer_name.trim() : '';
    const buyerPhone = typeof req.body?.buyer_phone === 'string' ? req.body.buyer_phone.trim() : '';
    const buyerCpf = typeof req.body?.buyer_cpf === 'string' ? req.body.buyer_cpf.replace(/\D/g, '') : '';

    if (!mediaIds) {
      return res.status(400).json({ error: `media_ids (lista de 1 a ${MAX_ITEMS_PER_ORDER} inteiros) é obrigatório.` });
    }
    if (!buyerName || buyerName.length > 120) {
      return res.status(400).json({ error: 'buyer_name (texto) é obrigatório.' });
    }
    if (!buyerPhone || buyerPhone.replace(/\D/g, '').length < 8 || buyerPhone.length > 30) {
      return res.status(400).json({ error: 'buyer_phone é obrigatório e precisa ser um telefone válido.' });
    }
    if (!isValidCpf(buyerCpf)) {
      return res.status(400).json({ error: 'buyer_cpf é obrigatório e precisa ser um CPF válido (11 dígitos).' });
    }

    const mediaRows = await db.all(
      `SELECT m.id, m.price_cents, m.storage_path, m.type,
              p.id AS photographer_id, p.name AS photographer_name, p.pix_key
       FROM media m JOIN photographers p ON p.id = m.photographer_id
       WHERE m.id = ANY($1::int[])`,
      [mediaIds]
    );
    if (mediaRows.length !== mediaIds.length) {
      return res.status(404).json({ error: 'Uma ou mais mídias não foram encontradas.' });
    }

    const photographerIds = new Set(mediaRows.map((m) => m.photographer_id));
    if (photographerIds.size > 1) {
      return res.status(400).json({ error: 'Todas as mídias do pedido precisam ser do mesmo fotógrafo (a chave Pix usada é a dele).' });
    }

    const photographer = mediaRows[0];
    if (!photographer.pix_key) {
      return res.status(400).json({ error: 'O fotógrafo ainda não cadastrou a chave Pix. Peça pra ele configurar antes de comprar.' });
    }

    const amountCents = mediaRows.reduce((sum, m) => sum + m.price_cents, 0);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      // Pix estático com valor 0 é rejeitado por parte das carteiras. Se o
      // total deu 0, é porque o fotógrafo não configurou o preço das mídias.
      return res.status(400).json({
        error: 'O valor do pedido é R$ 0,00. O fotógrafo precisa configurar o preço das mídias antes da venda.',
      });
    }

    const generated = pix.buildStaticPix({
      pixKey: photographer.pix_key,
      merchantName: photographer.photographer_name,
      amountCents,
      infoAdicional: `Midias ${mediaIds.join(',')}`,
    });
    if (generated.error) {
      // Erro de configuração da chave Pix do fotógrafo (formato inválido etc.),
      // não do cliente — mas quem vai agir é o cliente, então avisamos os dois.
      return res.status(400).json({ error: `Não foi possível gerar o Pix: ${generated.error}` });
    }

    const client = await db.pool.connect();
    let orderId;
    let publicToken;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO orders (buyer_name, buyer_phone, buyer_cpf, amount_cents, pix_code, status)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_payment') RETURNING id, public_token`,
        [buyerName, buyerPhone, buyerCpf, amountCents, generated.brCode]
      );
      orderId = inserted.rows[0].id;
      publicToken = inserted.rows[0].public_token;
      for (const m of mediaRows) {
        await client.query(
          'INSERT INTO order_items (order_id, media_id, price_cents) VALUES ($1, $2, $3)',
          [orderId, m.id, m.price_cents]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const qrCodeDataUrl = await generated.toQrDataUrl().catch(() => null);

    res.status(201).json({
      public_token: publicToken,
      amount_cents: amountCents,
      status: 'awaiting_payment',
      pix_code: generated.brCode,
      qr_code_data_url: qrCodeDataUrl,
      items: mediaRows.map((m) => ({ media_id: m.id, type: m.type, price_cents: m.price_cents })),
    });
  } catch (e) {
    next(e);
  }
});

// Lista todos os pedidos de um CPF, mais recentes primeiro — permite o
// cliente reabrir/baixar pedidos antigos mesmo sem ter guardado o link do
// public_token, independente do nome bater exatamente. Inclui o
// public_token de cada pedido (o front pode reusar os endpoints de proof
// se algum ainda estiver awaiting_payment). Lista vazia não é erro.
router.get('/by-cpf/:cpf', async (req, res, next) => {
  try {
    const cpf = String(req.params.cpf || '').replace(/\D/g, '');
    if (!isValidCpf(cpf)) {
      return res.status(400).json({ error: 'cpf inválido.' });
    }
    const rows = await db.all('SELECT * FROM orders WHERE buyer_cpf = $1 ORDER BY created_at DESC', [cpf]);
    const orders = [];
    for (const order of rows) {
      orders.push(serializeOrder(order, await loadOrderItems(order)));
    }
    res.json({ orders });
  } catch (e) {
    next(e);
  }
});

// Consulta o status do pedido (usado pra reabrir a tela depois de recarregar
// a página, sem precisar refazer a busca por selfie).
router.get('/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'token inválido.' });
    }
    const order = await db.get('SELECT * FROM orders WHERE public_token = $1', [token]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const items = await loadOrderItems(order);
    res.json(serializeOrder(order, items));
  } catch (e) {
    next(e);
  }
});

// Emite o token de upload direto pro storage pro comprovante (público, mas só
// pra um pedido existente que ainda esteja aguardando pagamento).
router.post('/:token/proof/upload-url', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'token inválido.' });
    }
    const order = await db.get('SELECT status FROM orders WHERE public_token = $1', [token]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    if (order.status !== 'awaiting_payment') {
      return res.status(409).json({ error: `Pedido já está com status "${order.status}".` });
    }

    await storage.handleClientUpload(req, res, async (pathname) => {
      if (!pathname.startsWith('proofs/')) {
        throw new Error('Caminho de upload inválido.');
      }
      return {
        allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
        maximumSizeInBytes: MAX_PROOF_BYTES,
      };
    });
  } catch (e) {
    next(e);
  }
});

// Cliente já subiu o comprovante direto pro Blob; aqui só registramos a URL
// e liberamos o pedido — todas as mídias do pedido ficam disponíveis pra
// download de uma vez.
//
// ponytail: NÃO existe verificação real de pagamento (sem gateway, sem
// webhook do banco, sem OCR do comprovante). O pedido vira "paid" só por
// registrar a URL de um arquivo aqui — decisão consciente do dono do
// produto, que vende pra gente conhecida e prefere confiar a bloquear
// compra por fricção de aprovação manual/IA. Se algum dia isso mudar
// (público maior, desconhecidos), o upgrade natural é: gateway Pix real com
// webhook de confirmação, ou pelo menos revisão manual antes de liberar.
router.post('/:token/proof', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'token inválido.' });
    }
    const order = await db.get('SELECT * FROM orders WHERE public_token = $1', [token]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    if (order.status !== 'awaiting_payment') {
      return res.status(409).json({ error: `Pedido já está com status "${order.status}".` });
    }

    const proofUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type : '';
    if (!proofUrl || !storage.isOwnStorageUrl(proofUrl) || !PROOF_MIME.test(contentType) ||
        !pathnameOf(proofUrl).startsWith('proofs/')) {
      return res.status(400).json({
        error: 'url (do upload direto ao storage) e content_type (JPEG, PNG, WEBP ou PDF) são obrigatórios e válidos.',
      });
    }

    await db.query('UPDATE orders SET proof_path = $1, status = $2 WHERE id = $3', [proofUrl, 'paid', order.id]);

    const updatedOrder = { ...order, proof_path: proofUrl, status: 'paid' };
    const items = await loadOrderItems(updatedOrder);
    res.json(serializeOrder(updatedOrder, items));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
