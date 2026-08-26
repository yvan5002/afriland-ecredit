// ============================================================
// Vérification générique du contenu d'un document (PDF ou image).
// Partagée par les 3 parcours clients (particulier, PME, corporate) :
// chacun fournit sa propre liste de mots-clés par type de pièce, la
// mécanique de lecture (texte natif + OCR + comparaison) est commune.
// ============================================================
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { texteParOCR, texteParOCRImage } = require("./ocr");

// IMPORTANT : la comparaison ignore les accents et la casse. L'OCR
// (tesseract.js) restitue très souvent mal les accents sur des
// documents scannés/photographiés ("Republique" au lieu de
// "République") — sans cette normalisation, un document pourtant
// correct n'est presque jamais reconnu.
function normaliser(texte) {
  return (texte || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // retire les accents
    .replace(/\s+/g, " ");
}

async function extraireTexte(buffer) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false,
  }).promise;
  let texte = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const contenu = await page.getTextContent();
      texte += contenu.items.map(it => it.str).join(" ") + " ";
    }
  } finally {
    await doc.destroy();
  }
  return texte;
}

/**
 * Vérifie qu'un document déposé correspond bien à la pièce attendue.
 * @param cle        clé du document déposé (ex: "bulletins_paie")
 * @param buffer     contenu brut du fichier
 * @param mimetype   type MIME détecté à l'upload
 * @param motsCles   objet { cle: [mots-clés normalisés sans accent] } pour CE dossier
 * @param liste      liste des pièces attendues [{ cle, label }] pour CE dossier (sert à nommer le document deviné en cas d'erreur)
 */
async function verifierDocument(cle, buffer, mimetype, motsCles, liste) {
  const estImage = mimetype === "image/jpeg" || mimetype === "image/jpg" || mimetype === "image/png";
  const estPDF = mimetype === "application/pdf" || (!estImage && buffer.length >= 5 && buffer.slice(0, 5).toString() === "%PDF-");

  if (!estImage && !estPDF) {
    return { statut: "invalide", details: "Le fichier n'est ni un PDF ni une image (JPG/PNG) valide." };
  }

  let texte = "";

  if (estImage) {
    try {
      const texteOCR = await texteParOCRImage(buffer, mimetype);
      texte = " " + normaliser(texteOCR) + " ";
    } catch (e) {
      console.error(">>> [ERREUR OCR IMAGE]", e.message || e);
    }
  } else {
    try {
      texte = " " + normaliser(await extraireTexte(buffer)) + " ";
    } catch (e) {
      return { statut: "invalide", details: "Ce fichier PDF est illisible ou corrompu." };
    }
    if (!texte.trim()) {
      try {
        const texteOCR = await texteParOCR(buffer);
        if (texteOCR && texteOCR.trim()) texte = " " + normaliser(texteOCR) + " ";
      } catch (e) {
        console.error(">>> [ERREUR OCR]", e.message || e);
      }
    }
  }

  if (!texte.trim()) {
    return { statut: "a_verifier", details: "Document illisible automatiquement (image de mauvaise qualité) — vérification manuelle." };
  }

  const scorePropre = (motsCles[cle] || []).filter(m => texte.includes(m)).length;
  let meilleurAutre = null, meilleurScore = 0;
  for (const [autreCle, mots] of Object.entries(motsCles)) {
    if (autreCle === cle) continue;
    const score = mots.filter(m => texte.includes(m)).length;
    if (score > meilleurScore) { meilleurScore = score; meilleurAutre = autreCle; }
  }

  if (scorePropre === 0 && meilleurScore >= 1) {
    const autreLabel = (liste.find(d => d.cle === meilleurAutre) || {}).label || meilleurAutre;
    return { statut: "suspect", details: `Ce fichier ressemble plutôt à : « ${autreLabel} ». Vérifiez votre dépôt.` };
  }
  if (scorePropre >= 1) return { statut: "reconnu", details: null };
  return { statut: "a_verifier", details: "Contenu non reconnu automatiquement — vérification manuelle." };
}

module.exports = { normaliser, extraireTexte, verifierDocument };
