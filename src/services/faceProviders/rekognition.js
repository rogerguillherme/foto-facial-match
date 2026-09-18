// Provider real: AWS Rekognition. Escolhido em vez de face-api.js/node-canvas
// porque o SDK é 100% JS (sem compilação nativa de canvas/cairo, que costuma
// travar no Windows sem Visual Studio) e porque o Rekognition já resolve
// detecção + indexação + busca por similaridade via "collections" — não
// precisamos guardar nem comparar vetores nós mesmos.
//
// Não requer credenciais para o app subir: só é chamado se FACE_PROVIDER=rekognition.
const {
  RekognitionClient,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  CreateCollectionCommand,
  ResourceAlreadyExistsException,
} = require('@aws-sdk/client-rekognition');
const sharp = require('sharp');
const config = require('../../config');

const MAX_BYTES = 5 * 1024 * 1024; // limite do Rekognition pra Image.Bytes inline

// Fotos de câmera/celular passam fácil do limite de 5MB do Rekognition pra
// Image.Bytes (diferente de referenciar via S3, que aceita até 15MB — não é
// o nosso caso, as mídias ficam no Vercel Blob). Reduz largura/qualidade JPEG
// até caber, mantendo aspecto; a resolução final ainda é mais que suficiente
// pra detecção de rosto.
async function shrinkForRekognition(buffer) {
  if (buffer.length <= MAX_BYTES) return buffer;
  let width = 2000;
  let quality = 85;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resized = await sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    if (resized.length <= MAX_BYTES) return resized;
    width = Math.round(width * 0.75);
    quality = Math.max(50, quality - 10);
  }
  throw new Error('Não foi possível reduzir a imagem abaixo do limite do Rekognition (5MB).');
}

const client = new RekognitionClient({
  region: config.aws.region,
  credentials: config.aws.accessKeyId
    ? { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey }
    : undefined,
});

let collectionReady = false;
async function ensureCollection() {
  if (collectionReady) return;
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: config.aws.collectionId }));
  } catch (err) {
    if (!(err instanceof ResourceAlreadyExistsException)) throw err;
  }
  collectionReady = true;
}

// Indexa o(s) rosto(s) da mídia na collection do Rekognition. ExternalImageId
// é o media_id do nosso banco, então o resultado da busca já volta ligado à mídia.
async function detect(buffer, externalImageId) {
  await ensureCollection();
  const image = await shrinkForRekognition(buffer);
  const result = await client.send(new IndexFacesCommand({
    CollectionId: config.aws.collectionId,
    Image: { Bytes: image },
    ExternalImageId: String(externalImageId),
    MaxFaces: 5,
    QualityFilter: 'AUTO',
    DetectionAttributes: [],
  }));
  const face = result.FaceRecords?.[0]?.Face;
  if (!face) return null; // nenhum rosto detectado na mídia
  return { externalFaceId: face.FaceId, embedding: null };
}

// Busca na collection inteira por rostos parecidos com a selfie.
async function searchBySimilarFaces(buffer, _catalogFacesUnused, thresholdPercent) {
  await ensureCollection();
  const image = await shrinkForRekognition(buffer);
  const result = await client.send(new SearchFacesByImageCommand({
    CollectionId: config.aws.collectionId,
    Image: { Bytes: image },
    FaceMatchThreshold: thresholdPercent,
    MaxFaces: 50,
  }));
  return (result.FaceMatches || []).map((m) => ({
    externalImageId: m.Face.ExternalImageId, // = media_id
    similarity: m.Similarity,
  }));
}

module.exports = { name: 'rekognition', detect, searchBySimilarFaces };
