// Self-check de ponta a ponta (sem framework extra, só node:test + fetch
// nativo): sobe o app de verdade, cadastra fotógrafo, envia uma "foto",
// manda a mesma imagem como "selfie" (deve bater ~100% no provider mock),
// confere a listagem de resultados e o stub de compra.
//
// Upload é feito com o mesmo `uploadPresigned()` client-side que o navegador
// usa (@vercel/blob/client funciona igual em Node, é só fetch por baixo) —
// sobe de verdade pro Blob configurado em .env.local, exatamente como em
// produção, sem o arquivo passar pelo corpo de nenhuma rota da nossa API.
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadPresigned } = require('@vercel/blob/client');

const app = require('../src/app');

async function uploadToBlob(pathname, buffer, contentType, handleUploadUrl, headers) {
  const blob = await uploadPresigned(pathname, buffer, {
    access: 'public', // exigido pelo SDK como checagem client-side; ignorado na prática pelo fluxo presigned (o store já é público)
    contentType,
    handleUploadUrl,
    headers,
  });
  return blob.url;
}

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
  // e a validação de tipo é feita pelo content_type declarado no confirm.
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

  // Seed derivado do relógio: a mesma foto de teste (seed fixo) ficaria pra
  // sempre no catálogo real (Postgres/Blob de produção, sem limpeza entre
  // execuções), e bateria similaridade com selfies de execuções anteriores.
  const photoBytes = fakeJpeg(Date.now() % 250);
  const photoUrl = await uploadToBlob(
    `photos/${Date.now()}-foto.jpg`,
    photoBytes,
    'image/jpeg',
    `${baseUrl}/api/media/upload-url`,
    { Authorization: `Bearer ${token}` }
  );

  const uploadRes = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: photoUrl, content_type: 'image/jpeg', original_name: 'foto.jpg', event_name: 'Ensaio Teste' }),
  });
  assert.equal(uploadRes.status, 201);
  const media = await uploadRes.json();
  assert.equal(media.face_status, 'indexed');
  assert.equal(media.price_cents, 5000); // preço fixo de foto configurado acima, não veio do upload

  // Selfie idêntica em bytes à foto -> similaridade deve bater no topo.
  const selfieUrl = await uploadToBlob(
    `selfies/${Date.now()}-selfie.jpg`,
    photoBytes,
    'image/jpeg',
    `${baseUrl}/api/match/upload-url`
  );

  const matchRes = await fetch(`${baseUrl}/api/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: selfieUrl, content_type: 'image/jpeg' }),
  });
  assert.equal(matchRes.status, 201);
  const matchBody = await matchRes.json();
  // O catálogo é real (Postgres/Blob de produção, compartilhado entre
  // execuções deste teste) — não assumimos catálogo vazio, só que a própria
  // foto enviada aparece com similaridade alta.
  const ownMatch = matchBody.results.find((r) => r.media_id === media.id);
  assert.ok(ownMatch, 'a própria foto enviada deveria aparecer nos resultados');
  assert.ok(ownMatch.similarity > 95);

  const listRes = await fetch(`${baseUrl}/api/match/${matchBody.public_token}`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.results.length, matchBody.results.length);

  // media_id (singular) continua aceito por compat, normalizado internamente
  // pra uma lista de 1 item (ver normalizeMediaIds em src/routes/orders.js).
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
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].media_id, media.id);

  const getOrderRes = await fetch(`${baseUrl}/api/orders/${order.public_token}`);
  assert.equal(getOrderRes.status, 200);
  const fetchedOrder = await getOrderRes.json();
  assert.equal(fetchedOrder.status, 'awaiting_payment');
  assert.ok(fetchedOrder.pix_code);

  const proofUrl = await uploadToBlob(
    `proofs/${Date.now()}-comprovante.png`,
    Buffer.from('comprovante fake'),
    'image/png',
    `${baseUrl}/api/orders/${order.public_token}/proof/upload-url`
  );
  const proofRes = await fetch(`${baseUrl}/api/orders/${order.public_token}/proof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: proofUrl, content_type: 'image/png' }),
  });
  assert.equal(proofRes.status, 200);
  const paidOrder = await proofRes.json();
  assert.equal(paidOrder.status, 'paid');
  assert.equal(paidOrder.items.length, 1);
  assert.ok(paidOrder.items[0].download_url);

  // Reenviar comprovante num pedido já pago deve ser rejeitado (evita
  // sobrescrever o comprovante original sem necessidade) — já na emissão
  // do token de upload, antes de gastar upload nenhum.
  const secondProofUploadUrlRes = await fetch(`${baseUrl}/api/orders/${order.public_token}/proof/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-presigned-url', payload: { pathname: 'proofs/de-novo.png', multipart: false, clientPayload: null } }),
  });
  assert.equal(secondProofUploadUrlRes.status, 409);
});

test('validações básicas de borda de confiança', async () => {
  // e-mail malformado no cadastro
  const badRegister = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', email: 'nao-e-email', password: 'senha1234' }),
  });
  assert.equal(badRegister.status, 400);

  // upload sem token (nem chega a emitir o token de upload pro Blob)
  const noAuthUpload = await fetch(`${baseUrl}/api/media/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-presigned-url', payload: { pathname: 'photos/x.jpg', multipart: false, clientPayload: null } }),
  });
  assert.equal(noAuthUpload.status, 401);

  // compra de mídia inexistente
  const badOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_ids: [999999], buyer_name: 'Cliente', buyer_phone: '11999998888', buyer_cpf: '52998224725' }),
  });
  assert.equal(badOrder.status, 404);

  // telefone inválido
  const badPhoneOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_ids: [999999], buyer_name: 'Cliente', buyer_phone: '123', buyer_cpf: '52998224725' }),
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

  const photoUrl = await uploadToBlob(
    `photos/${Date.now()}-foto.jpg`,
    fakeJpeg((Date.now() + 77) % 250),
    'image/jpeg',
    `${baseUrl}/api/media/upload-url`,
    { Authorization: `Bearer ${token}` }
  );
  const uploadRes = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: photoUrl, content_type: 'image/jpeg', original_name: 'foto.jpg' }),
  });
  const media = await uploadRes.json();

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: media.id, buyer_name: 'Cliente', buyer_phone: '11999998888' }),
  });
  assert.equal(orderRes.status, 400);
});

test('pedido com várias mídias: busca por selfie encontra as duas, compra as duas com um Pix só, comprovante libera as duas', async () => {
  const email = `fotografo-multi-${Date.now()}@teste.com`;
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fotógrafo Multi', email, password: 'senha1234' }),
  });
  const { token } = await registerRes.json();

  await fetch(`${baseUrl}/api/auth/pix-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pix_key: 'fotografo-multi@example.com' }),
  });
  await fetch(`${baseUrl}/api/auth/pricing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ price_photo_cents: 3000, price_video_cents: 6000 }),
  });

  // Mesmos bytes nas duas fotos (e na selfie), de propósito: o provider mock
  // só compara bytes (ver aviso `ponytail:` em faceProviders/mock.js), então
  // isso garante que a mesma selfie "reconhece" as duas com similaridade alta
  // — o que simula o caso real de a mesma pessoa aparecer em duas fotos.
  const sharedBytes = fakeJpeg(Date.now() % 250);

  async function uploadPhoto(name) {
    const url = await uploadToBlob(
      `photos/${Date.now()}-${name}.jpg`,
      sharedBytes,
      'image/jpeg',
      `${baseUrl}/api/media/upload-url`,
      { Authorization: `Bearer ${token}` }
    );
    const res = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url, content_type: 'image/jpeg', original_name: `${name}.jpg`, event_name: 'Evento Multi' }),
    });
    assert.equal(res.status, 201);
    return res.json();
  }

  const mediaA = await uploadPhoto('foto-a');
  const mediaB = await uploadPhoto('foto-b');

  const selfieUrl = await uploadToBlob(
    `selfies/${Date.now()}-selfie-multi.jpg`,
    sharedBytes,
    'image/jpeg',
    `${baseUrl}/api/match/upload-url`
  );
  const matchRes = await fetch(`${baseUrl}/api/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: selfieUrl, content_type: 'image/jpeg' }),
  });
  assert.equal(matchRes.status, 201);
  const matchBody = await matchRes.json();
  const foundIds = matchBody.results.map((r) => r.media_id);
  assert.ok(foundIds.includes(mediaA.id) && foundIds.includes(mediaB.id), 'as duas fotos deveriam aparecer na busca');

  // Pedido com as duas mídias selecionadas -> um Pix só, valor total somado.
  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_ids: [mediaA.id, mediaB.id], buyer_name: 'Cliente Multi', buyer_phone: '11988887777' }),
  });
  assert.equal(orderRes.status, 201);
  const order = await orderRes.json();
  assert.equal(order.amount_cents, 6000); // 2x price_photo_cents (3000 cada)
  assert.equal(order.items.length, 2);
  assert.ok(order.pix_code.includes('br.gov.bcb.pix'));

  const proofUrl = await uploadToBlob(
    `proofs/${Date.now()}-comprovante-multi.png`,
    Buffer.from('comprovante fake multi'),
    'image/png',
    `${baseUrl}/api/orders/${order.public_token}/proof/upload-url`
  );
  const proofRes = await fetch(`${baseUrl}/api/orders/${order.public_token}/proof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: proofUrl, content_type: 'image/png' }),
  });
  assert.equal(proofRes.status, 200);
  const paidOrder = await proofRes.json();
  assert.equal(paidOrder.status, 'paid');
  assert.equal(paidOrder.items.length, 2);
  const downloadUrls = paidOrder.items.map((it) => it.download_url);
  assert.ok(downloadUrls.every(Boolean), 'as duas mídias deveriam ter download_url');
  assert.notEqual(downloadUrls[0], downloadUrls[1]);

  // GET /api/orders/:token depois de pago também deve trazer as duas.
  const getPaidRes = await fetch(`${baseUrl}/api/orders/${order.public_token}`);
  const getPaidBody = await getPaidRes.json();
  assert.equal(getPaidBody.items.length, 2);
});

test('pedido rejeita mídias de fotógrafos diferentes', async () => {
  async function newPhotographerWithPhoto(suffix) {
    const email = `fotografo-mix-${suffix}-${Date.now()}@teste.com`;
    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Fotógrafo ${suffix}`, email, password: 'senha1234' }),
    });
    const { token } = await registerRes.json();
    await fetch(`${baseUrl}/api/auth/pix-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pix_key: `fotografo-mix-${suffix}@example.com` }),
    });
    await fetch(`${baseUrl}/api/auth/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ price_photo_cents: 2000, price_video_cents: 4000 }),
    });
    const photoUrl = await uploadToBlob(
      `photos/${Date.now()}-mix-${suffix}.jpg`,
      fakeJpeg((Date.now() + suffix.length) % 250),
      'image/jpeg',
      `${baseUrl}/api/media/upload-url`,
      { Authorization: `Bearer ${token}` }
    );
    const uploadRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: photoUrl, content_type: 'image/jpeg', original_name: `mix-${suffix}.jpg` }),
    });
    return uploadRes.json();
  }

  const mediaFromA = await newPhotographerWithPhoto('a');
  const mediaFromB = await newPhotographerWithPhoto('b');

  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_ids: [mediaFromA.id, mediaFromB.id], buyer_name: 'Cliente', buyer_phone: '11999998888' }),
  });
  assert.equal(orderRes.status, 400);
});
