// Helper mínimo de fetch + token do fotógrafo em localStorage. Sem framework.
function getToken() { return localStorage.getItem('ffm_token'); }
function setToken(t) { t ? localStorage.setItem('ffm_token', t) : localStorage.removeItem('ffm_token'); }

async function api(path, opts = {}) {
  const headers = {};
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (opts.auth) {
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição.');
  return data;
}

// Content-Type por extensão, pra quando o navegador manda file.type vazio
// (HEIC no Safari, por exemplo). Extensão desconhecida fica vazia e o
// backend responde 400.
const EXT_TYPES = {
  heic: 'image/heic', heif: 'image/heic', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime',
};

function fileType(file) {
  return file.type || EXT_TYPES[file.name.split('.').pop().toLowerCase()] || '';
}

// Upload direto do navegador pro Cloudflare R2: pede uma URL pré-assinada
// pra rota `handleUploadUrl` e envia o arquivo com PUT, sem passar pelo
// corpo das nossas serverless functions (limite de ~4.5MB da Vercel).
// Retorna { url, contentType } — use o contentType nas chamadas seguintes.
async function uploadToStorage(pathname, file, { handleUploadUrl, headers = {} }) {
  const contentType = fileType(file);
  const res = await fetch(handleUploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ pathname, contentType, size: file.size }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição.');
  const put = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!put.ok) throw new Error(`Falha ao enviar o arquivo (${put.status}).`);
  return { url: data.url, contentType };
}
