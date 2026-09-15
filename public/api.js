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
