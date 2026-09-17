// Normalização e validação da chave Pix ANTES de gravar no cadastro do
// fotógrafo e de montar o BR Code. É a correção do bug "o pagamento desse Pix
// falhou / indisponibilidade temporária": o app do banco pagador resolve a
// chave embutida no copia-e-cola via DICT, então ela precisa estar na forma
// canônica exata:
//   - CPF: 11 dígitos, sem pontuação
//   - CNPJ: 14 dígitos, sem pontuação
//   - E-mail: minúsculo, sem espaços
//   - Telefone: E.164 com DDI do Brasil, ex.: +5548999999999
//   - Aleatória (EVP): o UUID
// Antes disso a chave era gravada crua (só trim + limite de tamanho), então um
// telefone digitado como "(48) 99999-9999" ou um CPF com pontos gerava um
// copia-e-cola estruturalmente válido (CRC ok) mas com uma chave que o banco
// não conseguia resolver -> falha genérica no app do pagador.
//
// `declaredType` (opcional) desfaz a única ambiguidade real: 11 dígitos podem
// ser um CPF ou um celular com DDD. Quando o tipo não vem, tentamos detectar
// (e-mail/EVP/CNPJ e CPF por dígito verificador); 11 dígitos que não passam no
// dígito verificador de CPF caem no erro pedindo pra informar o tipo.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EVP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PHONE_TYPES = new Set(['phone', 'telefone', 'celular']);
const EVP_TYPES = new Set(['evp', 'aleatoria', 'aleatória', 'random']);

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

// Dígitos verificadores de CPF (algoritmo padrão da Receita).
function isValidCpf(cpf) {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let check = (sum * 10) % 11 % 10;
  if (check !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  check = (sum * 10) % 11 % 10;
  return check === Number(cpf[10]);
}

// Dígitos verificadores de CNPJ (algoritmo padrão da Receita).
function isValidCnpj(cnpj) {
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cnpj[i]) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

// Constrói a chave de telefone em E.164 (+55DDDNUMERO) a partir de qualquer
// entrada razoável: com ou sem +55, com ou sem pontuação.
function normalizePhone(raw) {
  let d = onlyDigits(raw);
  // Remove DDI do Brasil se já veio embutido (55 + 10/11 dígitos = 12/13).
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  // Remove um 0 de operadora/tronco na frente do DDD, se houver.
  if (d.length > 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10 && d.length !== 11) {
    return { error: 'Telefone inválido: informe DDD + número (ex.: 48 99999-9999).' };
  }
  return { key: '+55' + d, type: 'phone' };
}

// Retorna { key, type } normalizado, ou { error } com mensagem pro usuário.
// rawKey = o que o fotógrafo digitou; declaredType = tipo escolhido na UI (ou
// undefined pra detecção automática).
function normalizePixKey(rawKey, declaredType) {
  const raw = String(rawKey == null ? '' : rawKey).trim();
  if (!raw) return { error: 'Informe a chave Pix.' };

  const type = declaredType ? String(declaredType).trim().toLowerCase() : null;
  const isEmail = EMAIL_RE.test(raw);
  const lower = raw.toLowerCase();
  const isEvp = EVP_RE.test(lower);
  const digits = onlyDigits(raw);

  // E-mail
  if (type === 'email' || (!type && isEmail)) {
    if (!isEmail) return { error: 'E-mail inválido para chave Pix.' };
    if (raw.length > 77) return { error: 'E-mail muito longo (máx. 77 caracteres).' };
    return { key: lower, type: 'email' };
  }

  // Aleatória (EVP)
  if (EVP_TYPES.has(type) || (!type && isEvp)) {
    if (!isEvp) return { error: 'Chave aleatória inválida: deve ser um UUID (36 caracteres).' };
    return { key: lower, type: 'evp' };
  }

  // Telefone (declarado, ou detectado por prefixo + / DDI 55)
  if (PHONE_TYPES.has(type) || (!type && (raw.startsWith('+') || (digits.length >= 12 && digits.startsWith('55'))))) {
    return normalizePhone(raw);
  }

  // CNPJ
  if (type === 'cnpj' || (!type && digits.length === 14)) {
    if (!isValidCnpj(digits)) return { error: 'CNPJ inválido: confira os 14 dígitos.' };
    return { key: digits, type: 'cnpj' };
  }

  // CPF
  if (type === 'cpf' || (!type && digits.length === 11)) {
    if (!isValidCpf(digits)) {
      // 11 dígitos que não são um CPF válido: quase sempre é um celular
      // digitado sem o tipo. Guia o usuário em vez de gravar chave quebrada.
      return { error: 'Chave inválida. Se for um CELULAR, selecione o tipo "Celular"; se for CPF, confira os dígitos.' };
    }
    return { key: digits, type: 'cpf' };
  }

  return {
    error: 'Não reconheci a chave Pix. Selecione o tipo (CPF, CNPJ, e-mail, celular ou aleatória) e confira o valor.',
  };
}

module.exports = { normalizePixKey, isValidCpf, isValidCnpj };
