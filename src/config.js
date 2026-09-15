require('dotenv').config();
const path = require('node:path');

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
  dbPath: path.join(__dirname, '..', 'data', process.env.NODE_ENV === 'test' ? 'test.sqlite' : 'app.sqlite'),
  uploadsDir: path.join(__dirname, '..', process.env.NODE_ENV === 'test' ? 'uploads-test' : 'uploads'),
};
