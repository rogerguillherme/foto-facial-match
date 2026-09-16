// Gera o payload EMV do Pix ("BR Code" / copia-e-cola) e um QR code local a
// partir dele. Usa `pix-utils` (npm, mantida, zero API externa) em vez de
// montar o TLV do Bacen na mão — ela já cuida de normalizar acento/maiúsculas
// e limites de tamanho de cada campo.
const { createStaticPix, hasError } = require('pix-utils');

// Campos do BR Code têm limite de tamanho (merchantName <= 25, merchantCity
// <= 15). Cortamos aqui em vez de deixar a lib rejeitar nome de fotógrafo
// comprido.
function truncate(str, max) {
  return String(str || '').slice(0, max);
}

// ponytail: não coletamos a cidade do fotógrafo (não existe esse campo no
// cadastro); "BRASIL" é um valor genérico aceito pela maioria das carteiras
// para o campo obrigatório merchantCity do BR Code. Se precisar do nome real
// da cidade, adicionar o campo no cadastro do fotógrafo.
const GENERIC_CITY = 'BRASIL';

function buildStaticPix({ pixKey, merchantName, amountCents, infoAdicional }) {
  const pix = createStaticPix({
    merchantName: truncate(merchantName, 25) || 'FOTOGRAFO',
    merchantCity: GENERIC_CITY,
    pixKey,
    transactionAmount: amountCents / 100,
    infoAdicional: infoAdicional ? truncate(infoAdicional, 40) : undefined,
  });

  if (hasError(pix)) {
    return { error: pix.message };
  }
  return { brCode: pix.toBRCode(), toQrDataUrl: () => pix.toImage() };
}

module.exports = { buildStaticPix };
