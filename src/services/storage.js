// Storage em Cloudflare R2 (API S3). O arquivo vai direto do navegador pro R2
// via PUT numa URL pré-assinada — não passa pelo corpo das nossas serverless
// functions, que têm um limite de ~4.5MB de request body na Vercel (fotos de
// celular passam disso fácil). `handleClientUpload()` é o wrapper comum às 4
// rotas que emitem URL de upload (media/match/orders/auth); cada rota só
// define o que é permitido (tipos, tamanho, prefixo do path).
//
// Contrato com o front: POST { pathname, contentType, size } ->
// { uploadUrl, url }. `uploadUrl` assina Content-Type e Content-Length
// exatos, então o R2 rejeita um PUT com tipo/tamanho diferentes do declarado;
// `url` é a URL pública final (R2_PUBLIC_URL + key), que o front devolve pro
// endpoint de registro (POST /api/media etc.).
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');

// Cliente criado só no primeiro uso: o app sobe (e os testes de validação
// passam) mesmo sem as variáveis R2_*; só quem tenta usar o storage sem elas
// leva o erro claro.
let client;
function getClient() {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicUrl } = config.r2;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error('Storage R2 não configurado (defina R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET e R2_PUBLIC_URL).');
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // R2 não aceita os checksums CRC32 que o SDK novo adiciona por padrão
      // (viraria header assinado que o navegador não manda).
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

function publicBase() {
  return config.r2.publicUrl.replace(/\/+$/, '');
}

// Equivalente ao `addRandomSuffix` do Blob: "photos/1-foto.jpg" ->
// "photos/1-foto-<hex>.jpg". Mantém o prefixo e a extensão, evita colisão e
// sobrescrita de um arquivo existente por outro com o mesmo nome.
function withRandomSuffix(pathname) {
  const suffix = crypto.randomBytes(6).toString('hex');
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  return dot > slash + 1 ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
}

// Pathname vem do cliente: normaliza pra um caminho relativo seguro (sem
// "..", sem barra inicial/dupla, só caracteres previsíveis) antes de virar key.
function cleanPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname || pathname.length > 300) {
    throw new Error('pathname inválido.');
  }
  const parts = pathname.split('/').map((p) => p.replace(/[^A-Za-z0-9._-]/g, '_')).filter((p) => p && p !== '.' && p !== '..');
  if (parts.length < 2) throw new Error('pathname inválido.');
  return parts.join('/');
}

async function presignPut(key, contentType, size) {
  const command = new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: contentType, ContentLength: size });
  return getSignedUrl(getClient(), command, {
    expiresIn: 60 * 60,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}

// ponytail: não confirmamos o upload no servidor (sem webhook/HEAD no R2): o
// app confia no front-end pra avisar que terminou e mandar os metadados
// (mesma superfície de confiança de sempre; o registro em POST /api/media
// etc. valida que a URL é nossa e baixa os bytes de volta). Upgrade natural
// se virar produto com uploads de terceiros não confiáveis: HEAD no objeto
// antes de registrar.
//
// `buildTokenOptions(pathname)` deve validar o pathname e devolver
// `{ allowedContentTypes, maximumSizeInBytes }`; o wrapper confere o
// contentType/size do body contra isso.
async function handleClientUpload(req, res, buildTokenOptions) {
  try {
    const { pathname, contentType, size } = req.body || {};
    if (typeof contentType !== 'string' || !contentType) throw new Error('contentType obrigatório.');
    if (!Number.isInteger(size) || size <= 0) throw new Error('size obrigatório (bytes, inteiro positivo).');
    const clean = cleanPathname(pathname);
    const { allowedContentTypes, maximumSizeInBytes } = await buildTokenOptions(clean);
    if (!allowedContentTypes.includes(contentType)) throw new Error('Tipo de arquivo não permitido.');
    if (size > maximumSizeInBytes) throw new Error('Arquivo maior que o tamanho máximo permitido.');

    const key = withRandomSuffix(clean);
    const uploadUrl = await presignPut(key, contentType, size);
    res.json({ uploadUrl, url: `${publicBase()}/${key}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Confere que uma URL de mídia recebida do cliente é mesmo do nosso bucket
// (e não uma URL arbitrária) — evita registrar lixo no catálogo e, mais
// importante, evita SSRF quando o backend baixa os bytes da URL pra indexar o
// rosto (POST /api/media).
function isOwnStorageUrl(url) {
  if (!config.r2.publicUrl) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === new URL(config.r2.publicUrl).host;
  } catch {
    return false;
  }
}

// Só retorna a URL se for uma URL http(s) absoluta (o que os uploads sempre
// são). Registros antigos da era "disco local" guardavam um caminho relativo
// (ex.: "photos/x.jpg") em storage_path; devolver isso pro <img src>
// resultava em imagem quebrada (o navegador tentava carregar relativo à
// página e batia 404). Nesses casos retornamos null e quem consome decide
// (o front mostra "prévia indisponível" e a busca não oferece o item à venda).
function publicUrl(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath) return null;
  try {
    const parsed = new URL(storagePath);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? storagePath : null;
  } catch {
    return null;
  }
}

// Upload direto pelo servidor (não presigned) com a key exata informada.
async function putObject(key, buffer, contentType) {
  await getClient().send(new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, Body: buffer, ContentType: contentType }));
  return { url: `${publicBase()}/${key}` };
}

// Usado só pra gravar a versão com marca d'água já gerada em memória
// (`src/services/watermark.js`) logo depois do upload original do fotógrafo.
async function putPreview(mediaId, buffer) {
  return putObject(withRandomSuffix(`photos-preview/${mediaId}.jpg`), buffer, 'image/jpeg');
}

// Sobe a versão JPEG convertida de um upload original HEIC/HEIF (ver
// conversão em src/routes/media.js). Vai pro mesmo prefixo dos uploads
// originais ("photos/") porque este objeto PASSA a ser o `storage_path` da
// mídia — substitui a URL HEIC original, que fica órfã no bucket (sem
// problema, não precisa limpar).
async function putConverted(mediaId, buffer) {
  return putObject(withRandomSuffix(`photos/${mediaId}.jpg`), buffer, 'image/jpeg');
}

module.exports = { handleClientUpload, isOwnStorageUrl, publicUrl, putPreview, putConverted, putObject };
