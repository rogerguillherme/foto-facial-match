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
const config = require('../../config');

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
  const result = await client.send(new IndexFacesCommand({
    CollectionId: config.aws.collectionId,
    Image: { Bytes: buffer },
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
  const result = await client.send(new SearchFacesByImageCommand({
    CollectionId: config.aws.collectionId,
    Image: { Bytes: buffer },
    FaceMatchThreshold: thresholdPercent,
    MaxFaces: 50,
  }));
  return (result.FaceMatches || []).map((m) => ({
    externalImageId: m.Face.ExternalImageId, // = media_id
    similarity: m.Similarity,
  }));
}

module.exports = { name: 'rekognition', detect, searchBySimilarFaces };
