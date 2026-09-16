// Self-check de ponta a ponta (sem framework extra, só node:test + fetch
// nativo): sobe o app de verdade, cadastra fotógrafo, envia uma "foto",
// manda a mesma imagem como "selfie" (deve bater ~100% no provider mock),
// confere a listagem de resultados e o stub de compra.
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const uploadsTestDir = path.join(__dirname, '..', 'uploads-test');
for (const f of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
  fs.rmSync(path.join(dataDir, f), { force: true });
}
fs.rmSync(uploadsTestDir, { recursive: true, force: true });

const app = require('../src/app');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

function fakeJpeg(seed) {
  // Não precisa ser um JPEG válido de verdade: o provider mock só olha bytes,
  // e o multer só valida o Content-Type declarado no form-data.
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + seed) % 256;
  return buf;
}

test('fluxo completo: cadastro -> chave pix -> upload -> busca por selfie -> compra -> comprovante -> liberado', async () => {
  const email = `fotografo-${Date.now()}@teste.com`;

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fotógrafo Teste', email, password: 'senha1234' }),
  });
  assert.equal(registerRes.status, 201);
  const { token } = await registerRes.json();
  assert.ok(token);

  const pixRes = await fetch(`${baseUrl}/api/auth/pix-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pix_key: 'fotografo-teste@example.com' }),
  });
  assert.equal(pixRes.status, 200);

  const pricingRes = await fetch(`${baseUrl}/api/auth/pricing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ price_photo_cents: 5000, price_video_cents: 9000 }),
  });
  assert.equal(pricingRes.status, 200);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const me = await meRes.json();
  assert.equal(me.price_photo_cents, 5000);
  assert.equal(me.price_video_cents, 9000);

  const photoBytes = fakeJpeg(1);
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([photoBytes], { type: 'image/jpeg' }), 'foto.jpg');
  uploadForm.append('event_name', 'Ensaio Teste');

  const uploadRes = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm,
  });
  assert.equal(uploadRes.status, 201);
  const media = await uploadRes.json();
  assert.equal(media.face_status, 'indexed');
  assert.equal(media.price_cents, 5000); // preço fixo de foto configurado acima, não veio do upload

  // Selfie idêntica em bytes à foto -> similaridade deve bater no topo.
  const selfieForm = new FormData();
  selfieForm.append('selfie', new Blob([photoBytes], { type: 'image/jpeg' }), 'selfie.jpg');

  const matchRes = await fetch(`${baseUrl}/api/match`, { method: 'POST', body: selfieForm });
  assert.equal(matchRes.status, 201);
  const matchBody = await matchRes.json();
  assert.equal(matchBody.results.length, 1);
  assert.equal(matchBody.results[0].media_id, media.id);
  assert.ok(matchBody.results[0].similarity > 95);

  const listRes = await fetch(`${baseUrl}/api/match/${matchBody.search_id}`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.results.length, 1);

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: media.id, buyer_name: 'Cliente Teste', buyer_phone: '11999998888' }),
  });
  assert.equal(orderRes.status, 201);
  const order = await orderRes.json();
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.amount_cents, 5000);
  assert.ok(order.pix_code.includes('br.gov.bcb.pix'));
  assert.ok(order.qr_code_data_url.startsWith('data:image/png;base64,'));

  const getOrderRes = await fetch(`${baseUrl}/api/orders/${order.order_id}`);
  assert.equal(getOrderRes.status, 200);
  const fetchedOrder = await getOrderRes.json();
  assert.equal(fetchedOrder.status, 'awaiting_payment');
  assert.ok(fetchedOrder.pix_code);

  const proofForm = new FormData();
  proofForm.append('proof', new Blob([Buffer.from('comprovante fake')], { type: 'image/png' }), 'comprovante.png');
  const proofRes = await fetch(`${baseUrl}/api/orders/${order.order_id}/proof`, {
    method: 'POST',
    body: proofForm,
  });
  assert.equal(proofRes.status, 200);
  const paidOrder = await proofRes.json();
  assert.equal(paidOrder.status, 'paid');
  assert.ok(paidOrder.download_url);

  // Reenviar comprovante num pedido já pago deve ser rejeitado (evita
  // sobrescrever o comprovante original sem necessidade).
  const secondProofForm = new FormData();
  secondProofForm.append('proof', new Blob([Buffer.from('outro')], { type: 'image/png' }), 'de-novo.png');
  const secondProofRes = await fetch(`${baseUrl}/api/orders/${order.order_id}/proof`, {
    method: 'POST',
    body: secondProofForm,
  });
  assert.equal(secondProofRes.status, 409);
});

test('validações básicas de borda de confiança', async () => {
  // e-mail malformado no cadastro
  const badRegister = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', email: 'nao-e-email', password: 'senha1234' }),
  });
  assert.equal(badRegister.status, 400);

  // upload sem token
  const noAuthUpload = await fetch(`${baseUrl}/api/media`, { method: 'POST', body: new FormData() });
  assert.equal(noAuthUpload.status, 401);

  // compra de mídia inexistente
  const badOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: 999999, buyer_name: 'Cliente', buyer_phone: '11999998888' }),
  });
  assert.equal(badOrder.status, 404);

  // telefone inválido
  const badPhoneOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: 999999, buyer_name: 'Cliente', buyer_phone: '123' }),
  });
  assert.equal(badPhoneOrder.status, 400);
});

test('compra bloqueada quando o fotógrafo não cadastrou chave Pix', async () => {
  const email = `fotografo-sem-pix-${Date.now()}@teste.com`;
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sem Pix', email, password: 'senha1234' }),
  });
  const { token } = await registerRes.json();

  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([fakeJpeg(2)], { type: 'image/jpeg' }), 'foto.jpg');
  const uploadRes = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm,
  });
  const media = await uploadRes.json();

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: media.id, buyer_name: 'Cliente', buyer_phone: '11999998888' }),
  });
  assert.equal(orderRes.status, 400);
});
