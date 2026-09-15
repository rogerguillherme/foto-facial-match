# foto-facial-match

Backend: um fotógrafo sobe fotos/vídeos de eventos; o cliente final envia uma
selfie e o sistema encontra as mídias do catálogo em que ele aparece, para compra.

## Rodando localmente

```bash
npm install
cp .env.example .env   # ajuste JWT_SECRET pelo menos
npm start               # http://localhost:3000
npm test                # smoke test end-to-end (cadastro -> upload -> busca -> compra)
```

## Stack

- **Node.js + Express** — comum, sem exotismo.
- **node:sqlite** (módulo nativo do Node, sem dependência externa) em vez de
  `better-sqlite3` — a máquina de dev não tinha Visual Studio Build Tools e o
  `better-sqlite3` não tem binário pré-compilado pro Node 24 no Windows.
  `node:sqlite` evita compilação nativa por completo.
- **multer** (memória) + disco local para os arquivos.
- **bcryptjs + jsonwebtoken** para login simples do fotógrafo (sem OAuth/social).

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

`photographers` → `media` (foto/vídeo + preço + status de indexação) →
`media_faces` (rosto indexado por mídia) · `searches` + `search_results`
(cada busca por selfie e o que ela encontrou) · `orders` (stub de compra).

## Endpoints

| Método | Rota | Quem | O que faz |
|---|---|---|---|
| POST | `/api/auth/register` | público | cadastra fotógrafo, retorna JWT |
| POST | `/api/auth/login` | público | login do fotógrafo, retorna JWT |
| POST | `/api/media` | fotógrafo (Bearer) | upload de foto/vídeo (`multipart/form-data`, campo `file`, mais `price_cents` e `event_name`); indexa o rosto se for foto |
| GET | `/api/media` | fotógrafo (Bearer) | lista o catálogo do próprio fotógrafo |
| POST | `/api/match` | público | cliente envia selfie (campo `selfie`), busca no catálogo inteiro, salva e retorna os resultados |
| GET | `/api/match/:searchId` | público | reconsulta os resultados de uma busca já feita |
| POST | `/api/orders` | público | stub de compra (`media_id`, `buyer_email`); marca como `stub_paid` na hora |

## TODOs explícitos / stubs

- **Pagamento**: `/api/orders` só registra a intenção e marca `stub_paid` — sem
  gateway real (Stripe/Mercado Pago/etc). Ver comentário `TODO` em
  `src/routes/orders.js`.
- **Reconhecimento facial em vídeo**: vídeos são guardados e listados, mas
  **não** entram na busca por selfie — extrair frames (ffmpeg) e indexar cada
  um fica pra depois. Ver comentário `TODO` em `src/routes/media.js`
  (`face_status: 'skipped_video'`).
- **Provider mock não é reconhecimento facial real** — é só para dev/teste
  sem credencial. Trocar para `FACE_PROVIDER=rekognition` (com credenciais
  AWS reais no `.env`) antes de qualquer uso com clientes de verdade.
- **Storage local em disco**: ok para um fotógrafo/uma máquina. Trocar
  `src/services/storage.js` por um client S3-compatível quando precisar
  servir de mais de uma instância — o resto do app não conhece o disco
  diretamente.
