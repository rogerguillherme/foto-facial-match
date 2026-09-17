# foto-facial-match

Backend: um fotógrafo sobe fotos/vídeos de eventos; o cliente final envia uma
selfie e o sistema encontra as mídias do catálogo em que ele aparece, para compra.

## Rodando localmente

```bash
npm install
cp .env.example .env   # ajuste DATABASE_URL e JWT_SECRET pelo menos
npm run migrate         # cria as tabelas no Postgres apontado por DATABASE_URL
npx vercel env pull .env.local --yes   # traz VERCEL_OIDC_TOKEN/BLOB_STORE_ID pro upload no Blob funcionar localmente
npm start               # http://localhost:3000
npm test                # smoke test end-to-end (cadastro -> chave pix -> upload -> busca -> compra -> comprovante -> liberado)
```

## Deploy (Vercel)

App publicado no time `rogers-projects-73fd0e69` como função serverless
(framework "Express" nativo da Vercel — sem `vercel.json`/entrypoint
customizado, o CLI detecta `src/app.js` e empacota tudo sozinho).

```bash
npx vercel --scope rogers-projects-73fd0e69          # preview
npx vercel --prod --scope rogers-projects-73fd0e69   # produção
```

Banco (Postgres/Neon) e storage (Vercel Blob) são provisionados uma vez por
projeto via `npx vercel storage create` / `npx vercel integration add neon`
(ver histórico do projeto) — as env vars de conexão já ficam configuradas
automaticamente. Depois de provisionar o banco, rode `npm run migrate` (com
`DATABASE_URL` do ambiente certo) pra criar as tabelas.

## Stack

- **Node.js + Express** — comum, sem exotismo. Roda na Vercel como função
  serverless via suporte nativo a Express da plataforma.
- **Postgres (Neon, via integração da Vercel)** com o client `pg` puro (sem
  ORM) — trocado do `node:sqlite` original porque o filesystem das funções
  serverless da Vercel é efêmero: um arquivo `.sqlite` não sobrevive entre
  invocações/deploys.
- **Vercel Blob** para mídia e comprovantes (era disco local) — mesmo motivo:
  sem filesystem persistente na Vercel. `src/services/storage.js` concentra
  a integração; o resto do app usa `handleClientUpload()`/`isOwnBlobUrl()`/
  `publicUrl()`. Upload vai direto do navegador pro Blob (ver seção
  "Upload direto pro Blob" abaixo) — nada de multer/multipart nas nossas
  rotas, o arquivo nunca passa pelo corpo das nossas serverless functions.
- **bcryptjs + jsonwebtoken** para login simples do fotógrafo (sem OAuth/social).
- **pix-utils** para montar o payload EMV do Pix ("BR Code" copia-e-cola) e
  gerar o QR code localmente (sem gateway/API externa) — ver seção Pagamento.

## Reconhecimento facial

Dois providers atrás da mesma interface (`src/services/faceRecognition.js`),
escolhidos por `FACE_PROVIDER` no `.env`:

- **`mock`** (padrão): não reconhece rosto de verdade, só compara bytes da
  imagem (cosine similarity de um vetor bem simples). Existe só para o
  pipeline inteiro (upload → indexação → busca → resultado) ser testável sem
  nenhuma credencial. Ver aviso `ponytail:` no topo de
  `src/services/faceProviders/mock.js`.
- **`rekognition`**: AWS Rekognition de verdade, via `@aws-sdk/client-rekognition`.
  Escolhido em vez de `face-api.js`/`node-canvas` porque o SDK é 100% JS — sem
  compilar `canvas`/`cairo` nativamente (mesma dor do Windows citada acima) — e
  porque o Rekognition já resolve detecção + indexação + busca por
  similaridade via "collections", sem a gente ter que guardar/comparar vetores
  na mão. Não precisa de credencial para o app subir; só é chamado se
  `FACE_PROVIDER=rekognition`.

## Modelo de dados (`src/db.js`)

`photographers` (com `pix_key` e o preço fixo por tipo de mídia,
`price_photo_cents`/`price_video_cents`) → `media` (foto/vídeo + preço
resolvido no upload a partir do preço fixo do fotógrafo + status de
indexação) → `media_faces` (rosto indexado por mídia) · `searches` +
`search_results` (cada busca por selfie e o que ela encontrou) · `orders`
(pedido com nome/telefone do cliente, o Pix copia-e-cola gerado, o
comprovante enviado e o status `awaiting_payment` → `paid`).

### Preço

O fotógrafo configura, uma vez, um preço fixo pra qualquer foto e outro fixo
pra qualquer vídeo (`PUT /api/auth/pricing`). Não existe mais preço por item:
todo upload usa o valor fixo do tipo correspondente no momento do upload
(gravado em `media.price_cents`, congelado dali pra frente mesmo que o
fotógrafo mude o preço fixo depois). Sem valor configurado, o preço é `0` —
o fotógrafo precisa configurar antes de vender.

## Pagamento (Pix manual, sem gateway)

Fluxo de compra, de propósito sem gateway/aprovação (ver aviso `ponytail:`
em `src/routes/orders.js`):

1. Fotógrafo cadastra a própria chave Pix em `/api/auth/pix-key` (tela de
   configurações em `fotografo.html`).
2. Cliente encontra uma mídia pela selfie, informa nome + telefone em
   `POST /api/orders` e recebe um Pix estático (copia-e-cola + QR) com o
   valor exato da mídia, gerado localmente com `pix-utils`.
3. Cliente paga por fora (app do banco) e sobe o comprovante em
   `POST /api/orders/:id/proof`.
4. Só de subir o arquivo, o pedido já vira `paid` e a mídia fica liberada
   pra download — **não há nenhuma verificação real do pagamento** (sem
   webhook do banco, sem OCR do comprovante, sem aprovação manual). É uma
   decisão consciente do dono do produto: vende pra gente conhecida e prefere
   confiar a barrar venda com fricção.

## Endpoints

| Método | Rota | Quem | O que faz |
|---|---|---|---|
| POST | `/api/auth/register` | público | cadastra fotógrafo, retorna JWT |
| POST | `/api/auth/login` | público | login do fotógrafo, retorna JWT |
| GET | `/api/auth/me` | fotógrafo (Bearer) | dados do próprio fotógrafo (inclui `pix_key`, `price_photo_cents`, `price_video_cents`) |
| PUT | `/api/auth/pix-key` | fotógrafo (Bearer) | cadastra/edita a chave Pix fixa (`pix_key`) |
| PUT | `/api/auth/pricing` | fotógrafo (Bearer) | cadastra/edita o preço fixo por tipo (`price_photo_cents`, `price_video_cents`, inteiros >= 0 em centavos) |
| POST | `/api/media/upload-url` | fotógrafo (Bearer) | emite o token de upload direto pro Vercel Blob (chamado pelo SDK client-side, não à mão) |
| POST | `/api/media` | fotógrafo (Bearer) | registra no catálogo a mídia já enviada ao Blob (`url`, `content_type`, `original_name`, `event_name` em JSON); preço é resolvido pelo tipo usando o preço fixo já configurado; indexa o rosto se for foto |
| GET | `/api/media` | fotógrafo (Bearer) | lista o catálogo do próprio fotógrafo |
| POST | `/api/match/upload-url` | público | emite o token de upload direto pro Blob pra selfie |
| POST | `/api/match` | público | cliente confirma a selfie já enviada ao Blob (`url`, `content_type` em JSON), busca no catálogo inteiro, salva e retorna os resultados |
| GET | `/api/match/:searchId` | público | reconsulta os resultados de uma busca já feita |
| POST | `/api/orders` | público | cria o pedido (`media_id`, `buyer_name`, `buyer_phone`) e retorna o Pix copia-e-cola (`pix_code`) + QR (`qr_code_data_url`) |
| GET | `/api/orders/:id` | público | consulta status/pix do pedido; inclui `download_url` quando `paid` |
| POST | `/api/orders/:id/proof/upload-url` | público | emite o token de upload direto pro Blob pro comprovante (só se o pedido estiver `awaiting_payment`) |
| POST | `/api/orders/:id/proof` | público | cliente confirma o comprovante já enviado ao Blob (`url`, `content_type` em JSON); libera o pedido (`paid`) na hora |

### Upload direto pro Blob (sem passar pela function)

As Serverless Functions da Vercel têm um limite de ~4.5MB de corpo de
requisição de ENTRADA — pouco pra foto de celular. Por isso os 3 uploads
(mídia do fotógrafo, selfie do cliente, comprovante do Pix) vão direto do
navegador pro Vercel Blob via `uploadPresigned()` do `@vercel/blob/client`
(carregado por CDN, `https://esm.sh/@vercel/blob/client`, sem bundler): o
front chama a rota `.../upload-url` correspondente pra pegar um token
assinado, sobe o arquivo direto pro Blob, e só então confirma no endpoint
principal (JSON com a URL do Blob) — que é quem grava no banco (e, no caso
de foto, baixa os bytes de volta do Blob pra indexar o rosto; isso é
requisição de SAÍDA, sem o limite de 4.5MB).

Usamos o fluxo **presigned** (`handleUploadPresigned`/`issueSignedToken`),
não o fluxo mais comum de "client token" (`handleUpload`/`upload`) da
documentação: este projeto conecta o Blob store só com credenciais OIDC
(sem `BLOB_READ_WRITE_TOKEN` estático — ver `npx vercel storage status`), e
`generateClientTokenFromReadWriteToken` (usado por `handleUpload`) exige um
token estático. `issueSignedToken` já suporta OIDC nativamente.

## TODOs explícitos / stubs

- **Reconhecimento facial em vídeo**: vídeos são guardados e listados, mas
  **não** entram na busca por selfie — extrair frames (ffmpeg) e indexar cada
  um fica pra depois. Ver comentário `TODO` em `src/routes/media.js`
  (`face_status: 'skipped_video'`).
- **Provider mock não é reconhecimento facial real** — é só para dev/teste
  sem credencial. Trocar para `FACE_PROVIDER=rekognition` (com credenciais
  AWS reais nas env vars do projeto) antes de qualquer uso com clientes de
  verdade.
