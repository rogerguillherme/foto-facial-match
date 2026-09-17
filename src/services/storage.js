// Storage em Vercel Blob. O arquivo vai direto do navegador pro Blob via
// uploadPresigned() (@vercel/blob/client) — não passa mais pelo corpo das
// nossas serverless functions, que têm um limite de ~4.5MB de request body
// na Vercel (fotos de celular passam disso fácil). `handleClientUpload()` é
// o wrapper comum às 3 rotas que emitem token de upload (media/match/orders);
// cada rota só define o que é permitido (tipos, tamanho, prefixo do path).
//
// Por quê o fluxo "presigned" (handleUploadPresigned/issueSignedToken) e não
// o fluxo "client token" mais comum da documentação (handleUpload/upload):
// esse projeto conecta o Blob store só com credenciais OIDC (sem
// BLOB_READ_WRITE_TOKEN estático — decisão de infra já tomada, ver `vercel
// storage status`), e `generateClientTokenFromReadWriteToken` (usado por
// `handleUpload`) exige um token estático. `issueSignedToken` já suporta
// OIDC nativamente, então é o que funciona sem mexer na configuração do
// projeto. O front-end usa `uploadPresigned()` (não `upload()`) pra combinar.
const { handleUploadPresigned } = require('@vercel/blob/client');
const { issueSignedToken } = require('@vercel/blob'); // issueSignedToken só existe no pacote principal, não em /client
const config = require('../config');

// ponytail: não usamos `onUploadCompleted` (o webhook oficial que a Vercel
// chama quando o upload termina) porque ele não funciona em localhost sem
// túnel (ngrok), e o app já confia no front-end pra confirmar o upload e
// mandar os metadados (mesma superfície de confiança que existia antes,
// quando o front mandava o arquivo direto pro nosso endpoint). Upgrade
// natural se isso virar um produto com uploads de terceiros não confiáveis:
// mover o registro no banco pra dentro de `onUploadCompleted` e validar lá.
//
// `buildTokenOptions(pathname, clientPayload, multipart)` deve validar o
// pathname e devolver `{ allowedContentTypes, maximumSizeInBytes }`.
async function handleClientUpload(req, res, buildTokenOptions) {
  try {
    const jsonResponse = await handleUploadPresigned({
      body: req.body,
      request: req,
      getSignedToken: async (pathname, clientPayload, multipart) => {
        const { allowedContentTypes, maximumSizeInBytes } = await buildTokenOptions(pathname, clientPayload, multipart);
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          validUntil: Date.now() + 60 * 60 * 1000,
          allowedContentTypes,
          maximumSizeInBytes,
        });
        return { token, urlOptions: { addRandomSuffix: true } };
      },
    });
    res.json(jsonResponse);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Confere que uma URL de mídia recebida do cliente é mesmo do nosso Blob
// store (e não uma URL arbitrária) — evita registrar lixo no catálogo e,
// mais importante, evita SSRF quando o backend baixa os bytes da URL pra
// indexar o rosto (POST /api/media).
function isOwnBlobUrl(url) {
  const storeId = (config.blobStoreId || '').replace(/^store_/, '').toLowerCase();
  if (!storeId) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === `${storeId}.public.blob.vercel-storage.com`;
  } catch {
    return false;
  }
}

function publicUrl(storagePath) {
  return storagePath;
}

module.exports = { handleClientUpload, isOwnBlobUrl, publicUrl };
