# foto-facial-match

Backend: um fotógrafo sobe fotos/vídeos de eventos; o cliente final envia uma
selfie e o sistema encontra as mídias do catálogo em que ele aparece, para compra.

## Rodando localmente

```bash
npm install
cp .env.example .env   # ajuste JWT_SECRET pelo menos
npm start               # http://localhost:3000
npm test                # smoke test end-to-end (cadastro -> chave pix -> upload -> busca -> compra -> comprovante -> liberado)
```

## Stack

- **Node.js + Express** — comum, sem exotismo.
- **node:sqlite** (módulo nativo do Node, sem dependência externa) em vez de
  `better-sqlite3` — a máquina de dev não tinha Visual Studio Build Tools e o
  `better-sqlite3` não tem binário pré-compilado pro Node 24 no Windows.
  `node:sqlite` evita compilação nativa por completo.
- **multer** (memória) + disco local para os arquivos.
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

`photographers` (com `pix_key`) → `media` (foto/vídeo + preço + status de
indexação) → `media_faces` (rosto indexado por mídia) · `searches` +
`search_results` (cada busca por selfie e o que ela encontrou) · `orders`
(pedido com nome/telefone do cliente, o Pix copia-e-cola gerado, o
comprovante enviado e o status `awaiting_payment` → `paid`).

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
| GET | `/api/auth/me` | fotógrafo (Bearer) | dados do próprio fotógrafo (inclui `pix_key`) |
| PUT | `/api/auth/pix-key` | fotógrafo (Bearer) | cadastra/edita a chave Pix fixa (`pix_key`) |
| POST | `/api/media` | fotógrafo (Bearer) | upload de foto/vídeo (`multipart/form-data`, campo `file`, mais `price_cents` e `event_name`); indexa o rosto se for foto |
| GET | `/api/media` | fotógrafo (Bearer) | lista o catálogo do próprio fotógrafo |
| POST | `/api/match` | público | cliente envia selfie (campo `selfie`), busca no catálogo inteiro, salva e retorna os resultados |
| GET | `/api/match/:searchId` | público | reconsulta os resultados de uma busca já feita |
| POST | `/api/orders` | público | cria o pedido (`media_id`, `buyer_name`, `buyer_phone`) e retorna o Pix copia-e-cola (`pix_code`) + QR (`qr_code_data_url`) |
| GET | `/api/orders/:id` | público | consulta status/pix do pedido; inclui `download_url` quando `paid` |
| POST | `/api/orders/:id/proof` | público | cliente sobe o comprovante (`multipart/form-data`, campo `proof`); libera o pedido (`paid`) na hora |

## TODOs explícitos / stubs

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
