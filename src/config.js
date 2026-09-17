require('dotenv').config();

function required(name, fallback) {
  return process.env[name] || fallback;
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: required('JWT_SECRET', 'dev-secret-troque-em-producao'),
  faceProvider: required('FACE_PROVIDER', 'mock'), // 'mock' | 'rekognition'
  faceMatchThreshold: Number(process.env.FACE_MATCH_THRESHOLD) || 80,
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    collectionId: required('REKOGNITION_COLLECTION_ID', 'foto-facial-match'),
  },
  // Postgres hospedado (Neon/Vercel Postgres/Supabase injetam DATABASE_URL ou
  // POSTGRES_URL como env var do projeto). Sem fallback pra arquivo local:
  // filesystem da Vercel é efêmero, banco tem que ser um Postgres de verdade.
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  // Injetado automaticamente pela Vercel no ambiente do projeto; usado pra
  // validar que uma URL de mídia recebida do cliente é mesmo do nosso Blob
  // store (ver storage.isOwnBlobUrl).
  blobStoreId: process.env.BLOB_STORE_ID,
};
