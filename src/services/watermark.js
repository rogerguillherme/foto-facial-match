// Marca d'água pro preview de fotos (antes da compra): texto repetido na
// diagonal, semi-transparente, sobre a própria imagem. `sharp` porque é uma
// lib de imagem madura com binário pré-compilado (Linux/Windows) — não tem a
// dor de compilação nativa que o `better-sqlite3` deu neste projeto. Só foto:
// vídeo é TODO à parte (reconhecimento facial em vídeo, ver README).
const sharp = require('sharp');

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWatermarkSvg(width, height, text) {
  const label = escapeXml((text || 'PREVIEW').slice(0, 40));
  const cx = width / 2;
  const cy = height / 2;
  // Marca central grande e mais transparente, além do padrão repetido menor
  // e mais opaco (mesma combinação usada por banco de imagens tipo
  // Shutterstock): sozinho, o padrão pequeno dá pra "aparar" um recorte livre
  // de marca se o espaçamento for grande; a marca central atravessando o
  // meio da foto dificulta muito mais um recorte útil, porque cobre a área
  // onde normalmente está o assunto principal (rosto/corpo).
  const centerFontSize = Math.max(40, Math.round(Math.min(width, height) * 0.16));
  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="wm" width="200" height="100" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <text x="0" y="60" font-size="28" font-family="sans-serif" font-weight="bold"
                fill="#ffffff" fill-opacity="0.52">${label}</text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wm)" />
      <text x="${cx}" y="${cy}" font-size="${centerFontSize}" font-family="sans-serif" font-weight="bold"
            fill="#ffffff" fill-opacity="0.22" text-anchor="middle" dominant-baseline="middle"
            transform="rotate(-30 ${cx} ${cy})">${label}</text>
    </svg>
  `;
}

// Gera a versão com marca d'água a partir dos bytes originais. Mesmas
// dimensões, sem thumbnail/resize — só a foto com o texto sobreposto,
// recodificada em JPEG.
async function addWatermark(buffer, text) {
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  if (!width || !height) {
    throw new Error('Não foi possível ler as dimensões da imagem para aplicar a marca d\'água.');
  }
  const svg = buildWatermarkSvg(width, height, text);
  return image.composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82 }).toBuffer();
}

module.exports = { addWatermark };
