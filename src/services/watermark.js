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
  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="wm" width="320" height="160" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <text x="0" y="90" font-size="34" font-family="sans-serif" font-weight="bold"
                fill="#ffffff" fill-opacity="0.35">${label}</text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wm)" />
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
