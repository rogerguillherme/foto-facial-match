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
  // Cloudflare R2 (API S3). publicUrl = domínio público do bucket (r2.dev ou
  // domínio próprio), usado pra montar a URL final e validar URLs recebidas do
  // cliente (ver storage.isOwnStorageUrl). Sem as variáveis o app sobe; só o
  // uso do storage falha (ver getClient em src/services/storage.js).
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    publicUrl: process.env.R2_PUBLIC_URL,
  },
};
