// Orquestra o provider de reconhecimento facial ativo (mock ou rekognition,
// ver .env FACE_PROVIDER) e esconde dos routes a diferença entre os dois:
// o mock guarda embeddings no nosso banco e compara localmente; o Rekognition
// mantém sua própria "collection" e devolve os resultados já prontos.
const db = require('../db');
const config = require('../config');
const mockProvider = require('./faceProviders/mock');
const rekognitionProvider = require('./faceProviders/rekognition');

const provider = config.faceProvider === 'rekognition' ? rekognitionProvider : mockProvider;

// Indexa o rosto de uma foto recém-enviada. Retorna o novo face_status.
async function indexPhotoFace(mediaId, buffer) {
  const detection = await provider.detect(buffer, mediaId);
  if (!detection) {
    await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['no_face', mediaId]);
    return 'no_face';
  }
  await db.query(
    'INSERT INTO media_faces (media_id, external_face_id, embedding_json) VALUES ($1, $2, $3)',
    [mediaId, detection.externalFaceId, detection.embedding ? JSON.stringify(detection.embedding) : null]
  );
  await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['indexed', mediaId]);
  return 'indexed';
}

// Busca no catálogo inteiro quais mídias têm rosto parecido com a selfie.
// Retorna [{ mediaId, similarity }] ordenado por similaridade desc.
async function searchBySelfie(selfieBuffer) {
  if (provider.name === 'rekognition') {
    const matches = await provider.searchBySimilarFaces(selfieBuffer, null, config.faceMatchThreshold);
    const candidates = matches
      .map((m) => ({ mediaId: Number(m.externalImageId), similarity: m.similarity }))
      .filter((m) => Number.isFinite(m.mediaId));
    if (!candidates.length) return candidates;
    // A collection do Rekognition vive fora do banco: rostos de mídias já
    // apagadas continuam nela e estouravam a FK de search_results. Só vale
    // quem ainda existe no catálogo.
    const alive = new Set(
      (await db.all('SELECT id FROM media WHERE id = ANY($1::int[])', [candidates.map((m) => m.mediaId)])).map((r) => r.id)
    );
    return candidates.filter((m) => alive.has(m.mediaId));
  }

  const catalogFaces = await db.all('SELECT media_id, embedding_json FROM media_faces');
  return provider.searchBySimilarFaces(selfieBuffer, catalogFaces, config.faceMatchThreshold);
}

module.exports = { indexPhotoFace, searchBySelfie, providerName: provider.name };
