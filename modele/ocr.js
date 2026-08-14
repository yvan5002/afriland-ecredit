// ============================================================
// OCR (lecture optique) pour les documents déposés en scan/photo,
// que ce soit à l'intérieur d'un PDF ou directement en JPG/PNG.
//
// On évite volontairement le module natif "canvas" (il échoue
// régulièrement à s'installer correctement sur les hébergeurs
// gratuits comme Render, cf. avertissements dans les logs) : tout
// le décodage/redimensionnement d'image se fait en JS pur.
//   - PDF -> pdfjs-dist (décode JPEG/PNG/CCITT/JBIG2 en JS)
//   - JPEG direct -> jpeg-js
//   - PNG direct -> pngjs
//   - ré-encodage -> pngjs
//   - lecture du texte -> tesseract.js (OCR pur JS/WASM)
//
// Les données linguistiques (français) sont fournies localement
// dans modele/tessdata/fra.traineddata — pas de téléchargement à
// chaque démarrage.
// ============================================================
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");
const Tesseract = require("tesseract.js");

const LIMITE_TAILLE = 1700; // au-delà, l'OCR n'est pas plus précis mais devient nettement plus lent

let workerPromise = null;

// Le worker OCR est coûteux à démarrer (~1s) : on le crée une seule
// fois et on le réutilise pour toutes les vérifications suivantes.
function obtenirWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker("fra", 1, {
      langPath: path.join(__dirname, "tessdata"),
      gzip: false,
      cachePath: "/tmp/tess-cache",
    });
  }
  return workerPromise;
}

// ------------------------------------------------------------
// Redimensionnement générique (nearest-neighbor) sur des pixels
// RGBA bruts, puis ré-encodage en PNG.
// ------------------------------------------------------------
function redimensionnerEtEncoderPNG(width, height, dataRGBA) {
  const facteur = Math.max(1, Math.ceil(Math.max(width, height) / LIMITE_TAILLE));
  let largeurFinale = width, hauteurFinale = height, donneesFinale = dataRGBA;

  if (facteur > 1) {
    largeurFinale = Math.floor(width / facteur);
    hauteurFinale = Math.floor(height / facteur);
    donneesFinale = new Uint8ClampedArray(largeurFinale * hauteurFinale * 4);
    for (let y = 0; y < hauteurFinale; y++) {
      for (let x = 0; x < largeurFinale; x++) {
        const srcIdx = ((y * facteur) * width + (x * facteur)) * 4;
        const dstIdx = (y * largeurFinale + x) * 4;
        for (let c = 0; c < 4; c++) donneesFinale[dstIdx + c] = dataRGBA[srcIdx + c];
      }
    }
  }

  const png = new PNG({ width: largeurFinale, height: hauteurFinale });
  donneesFinale.copy ? donneesFinale.copy(png.data) : png.data.set(donneesFinale);
  return PNG.sync.write(png);
}

// Convertit les pixels d'une image décodée par pdfjs (3, 1 ou 4 canaux)
// en RGBA brut exploitable par redimensionnerEtEncoderPNG.
function pdfjsVersRGBA(img) {
  const { width, height, data } = img;
  const nbPixels = width * height;
  const nbCanaux = data.length / nbPixels;
  const rgba = new Uint8ClampedArray(nbPixels * 4);
  for (let i = 0; i < nbPixels; i++) {
    if (nbCanaux === 3) {
      rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    } else if (nbCanaux === 1) {
      const v = data[i]; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = data[i * 4]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4 + 2];
      rgba[i * 4 + 3] = data[i * 4 + 3] !== undefined ? data[i * 4 + 3] : 255;
    }
  }
  return { width, height, rgba };
}

async function extraireImagePlusGrandeDuPDF(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const page = await doc.getPage(1);
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const cles = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (opList.fnArray[i] === OPS.paintImageXObject) cles.push(opList.argsArray[i][0]);
    }
    let meilleureImg = null, meilleureSurface = 0;
    for (const cle of cles) {
      const img = await new Promise(resolve => page.objs.get(cle, resolve));
      if (!img || !img.width || !img.height) continue;
      const surface = img.width * img.height;
      if (surface > meilleureSurface) { meilleureSurface = surface; meilleureImg = img; }
    }
    return meilleureImg;
  } finally {
    await doc.destroy();
  }
}

/**
 * Décode une image JPG ou PNG "brute" (déposée directement, pas dans un
 * PDF) et la ré-encode en PNG redimensionné, prête pour l'OCR ou l'affichage.
 */
function imageBruteVersPNG(buffer, mimetype) {
  let width, height, rgba;
  if (mimetype === "image/png") {
    const png = PNG.sync.read(buffer);
    width = png.width; height = png.height; rgba = png.data;
  } else {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    width = decoded.width; height = decoded.height; rgba = decoded.data; // déjà en RGBA
  }
  return redimensionnerEtEncoderPNG(width, height, rgba);
}

/**
 * Extrait l'image la plus grande de la première page d'un PDF et la
 * renvoie encodée en PNG (redimensionnée si nécessaire). Utilisé à la
 * fois pour l'OCR et pour afficher la photo de la CNI côté client
 * (vérification d'identité).
 */
async function extraireImagePNGDuPDF(buffer) {
  const img = await extraireImagePlusGrandeDuPDF(buffer);
  if (!img) return null;
  const { width, height, rgba } = pdfjsVersRGBA(img);
  return redimensionnerEtEncoderPNG(width, height, rgba);
}

/**
 * OCR d'un PDF scanné (image) — extrait l'image et lit son texte.
 * Retourne une chaîne vide si aucune image exploitable n'est trouvée.
 */
async function texteParOCR(buffer) {
  const pngBuffer = await extraireImagePNGDuPDF(buffer);
  if (!pngBuffer) return "";
  const worker = await obtenirWorker();
  const { data: { text } } = await worker.recognize(pngBuffer);
  return text || "";
}

/**
 * OCR direct sur une photo JPG/PNG déposée telle quelle (pas dans un PDF).
 */
async function texteParOCRImage(buffer, mimetype) {
  const pngBuffer = imageBruteVersPNG(buffer, mimetype);
  const worker = await obtenirWorker();
  const { data: { text } } = await worker.recognize(pngBuffer);
  return text || "";
}

module.exports = { texteParOCR, texteParOCRImage, extraireImagePNGDuPDF, imageBruteVersPNG };
