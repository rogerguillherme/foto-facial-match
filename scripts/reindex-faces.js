// Backfill de rostos pro Rekognition. Rodar UMA vez logo depois de trocar
// FACE_PROVIDER de "mock" pra "rekognition".
//
// Por quê: enquanto o provider era o mock, as fotos foram indexadas gravando
// um embedding em `media_faces` (comparado localmente). O Rekognition NÃO usa
// esse embedding — ele tem a própria "collection". Então, ao trocar de
// provider, a busca por selfie passa a olhar a collection do Rekognition, que
// começa vazia: nenhuma foto já enviada apareceria até ser reindexada. Este
// script baixa os bytes de cada foto do Blob e reindexa na collection.
//
// Uso (com as env vars do ambiente certo — as mesmas da Vercel):
//   FACE_PROVIDER=rekognition AWS_REGION=... AWS_ACCESS_KEY_ID=... \
//   AWS_SECRET_ACCESS_KEY=... DATABASE_URL=... node scripts/reindex-faces.js
//
// É seguro rodar numa collection nova/vazia. Se rodar de novo numa collection
// que já tem rostos, o Rekognition apenas adiciona faces repetidas (não
// quebra a busca, mas polui a collection) — o ideal é recriar a collection
// antes de um reprocessamento total.
const config = require('../src/config');
const db = require('../src/db');
const storage = require('../src/services/storage');
const faceRecognition = require('../src/services/faceRecognition');

async function reindex() {
  if (config.faceProvider !== 'rekognition') {
    console.error(
      'FACE_PROVIDER não é "rekognition". Defina FACE_PROVIDER=rekognition (e as credenciais AWS) antes de rodar o backfill.'
    );
    process.exit(1);
  }

  const photos = await db.all(
    "SELECT id, storage_path FROM media WHERE type = 'photo' ORDER BY id"
  );
  console.log(`Reindexando ${photos.length} foto(s) na collection "${config.aws.collectionId}"...`);

  let indexed = 0, noFace = 0, failed = 0, skipped = 0;
  for (const photo of photos) {
    const url = storage.publicUrl(photo.storage_path);
    if (!url) {
      // Registro antigo sem URL de Blob válida — não dá pra baixar os bytes.
      skipped++;
      console.warn(`  mídia ${photo.id}: pulada (storage_path sem URL válida).`);
      continue;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`download do Blob falhou (status ${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const status = await faceRecognition.indexPhotoFace(photo.id, buffer);
      if (status === 'indexed') indexed++;
      else if (status === 'no_face') noFace++;
      else failed++;
      console.log(`  mídia ${photo.id}: ${status}`);
    } catch (e) {
      failed++;
      await db.query('UPDATE media SET face_status = $1 WHERE id = $2', ['failed', photo.id]).catch(() => {});
      console.error(`  mídia ${photo.id}: erro — ${e.message}`);
    }
  }

  console.log(`\nConcluído. indexadas=${indexed} sem_rosto=${noFace} falhas=${failed} puladas=${skipped}`);
  await db.pool.end();
}

reindex().catch((e) => {
  console.error('Falha no backfill:', e);
  process.exit(1);
});
