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
    db.prepare('UPDATE media SET face_status = ? WHERE id = ?').run('no_face', mediaId);
    return 'no_face';
  }
  db.prepare(
    'INSERT INTO media_faces (media_id, external_face_id, embedding_json) VALUES (?, ?, ?)'
  ).run(
    mediaId,
    detection.externalFaceId,
    detection.embedding ? JSON.stringify(detection.embedding) : null
  );
  db.prepare('UPDATE media SET face_status = ? WHERE id = ?').run('indexed', mediaId);
  return 'indexed';
}

// Busca no catálogo inteiro quais mídias têm rosto parecido com a selfie.
// Retorna [{ mediaId, similarity }] ordenado por similaridade desc.
async function searchBySelfie(selfieBuffer) {
  if (provider.name === 'rekognition') {
    const matches = await provider.searchBySimilarFaces(selfieBuffer, null, config.faceMatchThreshold);
    return matches
      .map((m) => ({ mediaId: Number(m.externalImageId), similarity: m.similarity }))
      .filter((m) => Number.isFinite(m.mediaId));
  }

  const catalogFaces = db.prepare('SELECT media_id, embedding_json FROM media_faces').all();
  return provider.searchBySimilarFaces(selfieBuffer, catalogFaces, config.faceMatchThreshold);
}

module.exports = { indexPhotoFace, searchBySelfie, providerName: provider.name };
