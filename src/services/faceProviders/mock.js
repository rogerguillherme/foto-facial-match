// Provider MOCK: não faz reconhecimento facial de verdade. Serve para
// desenvolver/testar o pipeline (upload -> indexação -> busca -> resultado)
// sem precisar de credenciais de nenhum serviço externo.
//
// ponytail: a "similaridade" aqui é só uma comparação grosseira dos bytes da
// imagem (não detecta rosto, não é invariante a pose/luz/ângulo). Ceiling:
// não usar em produção. Upgrade path: trocar FACE_PROVIDER=rekognition no
// .env (ou plugar outro provider real seguindo a mesma interface).
const crypto = require('node:crypto');

const DIMENSIONS = 64;

function toVector(buffer) {
  const vector = new Array(DIMENSIONS).fill(0);
  const chunkSize = Math.max(1, Math.floor(buffer.length / DIMENSIONS));
  for (let i = 0; i < DIMENSIONS; i++) {
    const start = i * chunkSize;
    const end = i === DIMENSIONS - 1 ? buffer.length : start + chunkSize;
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    vector[i] = count > 0 ? sum / count / 255 : 0;
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// "Detecta" um rosto na imagem. Mock: assume sempre que há 1 rosto.
async function detect(buffer) {
  const embedding = toVector(buffer);
  const externalFaceId = crypto.createHash('sha1').update(buffer).digest('hex');
  return { externalFaceId, embedding };
}

// Recebe a selfie e compara com os embeddings já salvos no banco (media_faces).
// `catalogFaces` é [{ mediaId, embeddingJson }] carregado pelo chamador.
async function searchBySimilarFaces(buffer, catalogFaces, thresholdPercent) {
  const { embedding: queryVector } = await detect(buffer);
  const results = [];
  for (const face of catalogFaces) {
    if (!face.embedding_json) continue;
    const candidateVector = JSON.parse(face.embedding_json);
    const similarity = Math.max(0, cosineSimilarity(queryVector, candidateVector)) * 100;
    if (similarity >= thresholdPercent) {
      results.push({ mediaId: face.media_id, similarity });
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}

module.exports = { name: 'mock', detect, searchBySimilarFaces };
