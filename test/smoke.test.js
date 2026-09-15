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

test('fluxo completo: cadastro -> upload -> busca por selfie -> compra', async () => {
  const email = `fotografo-${Date.now()}@teste.com`;

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fotógrafo Teste', email, password: 'senha1234' }),
  });
  assert.equal(registerRes.status, 201);
  const { token } = await registerRes.json();
  assert.ok(token);

  const photoBytes = fakeJpeg(1);
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([photoBytes], { type: 'image/jpeg' }), 'foto.jpg');
  uploadForm.append('price_cents', '5000');
  uploadForm.append('event_name', 'Ensaio Teste');

  const uploadRes = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm,
  });
  assert.equal(uploadRes.status, 201);
  const media = await uploadRes.json();
  assert.equal(media.face_status, 'indexed');

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
    body: JSON.stringify({ media_id: media.id, buyer_email: 'cliente@teste.com' }),
  });
  assert.equal(orderRes.status, 201);
  const order = await orderRes.json();
  assert.equal(order.status, 'stub_paid');
  assert.equal(order.amount_cents, 5000);
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
    body: JSON.stringify({ media_id: 999999, buyer_email: 'cliente@teste.com' }),
  });
  assert.equal(badOrder.status, 404);
});
