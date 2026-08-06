const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const {
  creerDemande, trouverParReference,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
} = require("../db/database");

// ------------------------------------------------------------
// Liste officielle des pieces exigees (identique a l'application interne)
// ------------------------------------------------------------
const DOCUMENTS_REQUIS = [
  { cle: "demande_signee", numero: 1, label: "Demande de crÃ©dit signÃ©e, adressÃ©e au Directeur GÃ©nÃ©ral" },
  { cle: "cni", numero: 2, label: "Photocopie de la CNI en cours de validitÃ©" },
  { cle: "bulletins_paie", numero: 3, label: "3 derniers bulletins de paie" },
  { cle: "attestation_virement", numero: 4, label: "Attestation de virement irrÃ©vocable" },
  { cle: "attestation_travail", numero: 5, label: "Attestation de travail (ou de prÃ©sence effective)" },
  { cle: "contrat_travail", numero: 6, label: "Contrat de travail (secteur privÃ©)" },
  { cle: "niu", numero: 7, label: "NIU (NumÃ©ro d'Identifiant Unique)" },
  { cle: "plan_localisation", numero: 8, label: "Plan de localisation" },
];

// ------------------------------------------------------------
// Reconnaissance automatique du contenu des documents
// Approche : lecture du texte du PDF (pdf-parse) + recherche de
// mots-clÃ©s propres Ã  chaque piÃ¨ce. Un document scannÃ© (image,
// sans couche de texte) ne peut pas Ãªtre analysÃ© ainsi : il est
// simplement marquÃ© "Ã  vÃ©rifier manuellement" plutÃ´t que rejetÃ©.
// ------------------------------------------------------------
const MOTS_CLES = {
  demande_signee: ["demande de crÃ©dit", "directeur gÃ©nÃ©ral", "je soussignÃ©", "j'ai l'honneur"],
  cni: ["carte nationale d'identitÃ©", "rÃ©publique du cameroun", "republic of cameroon", "date de naissance"],
  bulletins_paie: ["bulletin de paie", "bulletin de salaire", "net Ã  payer", "salaire brut"],
  attestation_virement: ["virement irrÃ©vocable", "attestation de virement", "domiciliation"],
  attestation_travail: ["attestation de travail", "atteste que", "prÃ©sence effective"],
  contrat_travail: ["contrat de travail", "employeur", "durÃ©e indÃ©terminÃ©e", "durÃ©e dÃ©terminÃ©e"],
  niu: ["numÃ©ro d'identifiant unique", " niu ", "contribuable"],
  plan_localisation: ["plan de localisation", "localisation", "itinÃ©raire"],
};

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

async function verifierDocument(cle, buffer) {
  if (buffer.length < 5 || buffer.slice(0, 5).toString() !== "%PDF-") {
    return { statut: "invalide", details: "Le fichier n'est pas un PDF valide." };
  }
  let texte = "";
  try {
    texte = " " + (await extraireTexte(buffer)).toLowerCase().replace(/\s+/g, " ") + " ";
  } catch (e) {
    return { statut: "invalide", details: "Ce fichier PDF est illisible ou corrompu." };
  }
  if (!texte.trim()) {
    return { statut: "a_verifier", details: "Document scannÃ© (image) â€” vÃ©rification manuelle par l'agent." };
  }

  const scorePropre = (MOTS_CLES[cle] || []).filter(m => texte.includes(m)).length;
  let meilleurAutre = null, meilleurScore = 0;
  for (const [autreCle, mots] of Object.entries(MOTS_CLES)) {
    if (autreCle === cle) continue;
    const score = mots.filter(m => texte.includes(m)).length;
    if (score > meilleurScore) { meilleurScore = score; meilleurAutre = autreCle; }
  }

  if (scorePropre === 0 && meilleurScore >= 1) {
    const autreLabel = (DOCUMENTS_REQUIS.find(d => d.cle === meilleurAutre) || {}).label || meilleurAutre;
    return { statut: "suspect", details: `Ce fichier ressemble plutÃ´t Ã  : Â« ${autreLabel} Â». VÃ©rifiez votre dÃ©pÃ´t.` };
  }
  if (scorePropre >= 1) return { statut: "reconnu", details: null };
  return { statut: "a_verifier", details: "Contenu non reconnu automatiquement â€” vÃ©rification manuelle par l'agent." };
}

// ------------------------------------------------------------
// Upload PDF uniquement (memes regles que l'application interne)
// ------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("SEUL_PDF_AUTORISE"));
    }
    cb(null, true);
  },
});

function genererReference() {
  const date = new Date();
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `AEC-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}-${code}`;
}

function genererIdBrouillon() {
  return crypto.randomBytes(12).toString("hex");
}

function validerTelephone(brut) {
  const chiffres = (brut || "").replace(/\D/g, "");
  const local = chiffres.startsWith("237") ? chiffres.slice(3) : chiffres;
  return /^6\d{8}$/.test(local) ? "+237 " + local : null;
}

function validerCNI(brut) {
  const v = (brut || "").trim().toUpperCase();
  return /^[A-Z0-9]{9}$/.test(v) ? v : null;
}

// NumÃ©ro de compte Afriland : 11 chiffres (format interne des comptes clients)
function validerNumeroCompte(brut) {
  const v = (brut || "").replace(/\s/g, "");
  return /^\d{11}$/.test(v) ? v : null;
}

// Code de vÃ©rification client : 4 Ã  6 chiffres
function validerCodeVerification(brut) {
  const v = (brut || "").trim();
  return /^\d{4,6}$/.test(v) ? v : null;
}

function etapeSuivante(d) {
  if (!d || !d.nom) return "/demande";
  if (!d.montant) return "/demande/pret";
  if (!d.documents) return "/demande/documents";
  return "/demande/recapitulatif";
}

// ------------------------------------------------------------
// Charge un brouillon existant (cookie brouillon_id) dans la
// session si celle-ci est vide, ou en crÃ©e un nouveau. Permet Ã 
// un client qui quitte la page et revient (mÃªme aprÃ¨s un
// redÃ©marrage du serveur) de reprendre sa demande lÃ  oÃ¹ il s'est
// arrÃªtÃ© â€” ou de savoir clairement qu'il en dÃ©marre une nouvelle.
// ------------------------------------------------------------
function chargerOuCreerBrouillon(req, res, next) {
  if (req.session.demande && req.session.demande.nom) return next();

  const idCookie = (req.cookies || {}).brouillon_id;
  const brouillon = trouverBrouillon(idCookie);

  if (brouillon && !brouillon.termine) {
    const donnees = { ...brouillon.donnees };
    // Sur disque ephemere (Render), les fichiers deja deposes peuvent avoir
    // disparu apres un redemarrage : on verifie avant de considerer l'etape faite.
    if (donnees.documents) {
      const dossierUploads = path.join(__dirname, "..", "uploads");
      const tousPresents = Object.values(donnees.documents)
        .every(doc => fs.existsSync(path.join(dossierUploads, doc.chemin)));
      if (!tousPresents) delete donnees.documents;
    }
    req.session.demande = donnees;
    req.session.brouillonId = idCookie;
    req.session.reprise = true;
    return next();
  }

  const nouvelId = genererIdBrouillon();
  req.session.demande = {};
  req.session.brouillonId = nouvelId;
  res.cookie("brouillon_id", nouvelId, {
    maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax",
  });
  next();
}

function persisterBrouillon(req) {
  if (req.session.brouillonId) {
    sauvegarderBrouillon(req.session.brouillonId, req.session.demande);
  }
}

router.use("/demande", chargerOuCreerBrouillon);

// ============================================================
// PAGE D'ACCUEIL
// ============================================================
router.get("/", (req, res) => {
  const brouillon = trouverBrouillon((req.cookies || {}).brouillon_id);
  const enCours = brouillon && !brouillon.termine && brouillon.donnees && brouillon.donnees.nom;
  res.render("accueil", {
    titre: "Afriland E-CrÃ©dit â€” Demande de crÃ©dit en ligne",
    enCours: !!enCours,
  });
});

// ============================================================
// SUIVI D'UNE DEMANDE (statut : en cours / acceptÃ©e / refusÃ©e)
// ============================================================
router.get("/suivi", (req, res) => {
  res.render("suivi", { titre: "Suivre ma demande â€” Afriland E-CrÃ©dit", erreur: null });
});

router.post("/suivi", (req, res) => {
  const reference = (req.body.reference || "").trim().toUpperCase();
  const demande = trouverParReference(reference);
  if (!demande) {
    return res.render("suivi", { titre: "Suivre ma demande â€” Afriland E-CrÃ©dit",
      erreur: "Aucune demande ne correspond Ã  cette rÃ©fÃ©rence. VÃ©rifiez votre saisie." });
  }
  res.redirect("/confirmation/" + demande.reference);
});

// ============================================================
// ETAPE 1 â€” INFORMATIONS PERSONNELLES
// ============================================================
router.get("/demande", (req, res) => {
  const reprise = !!req.session.reprise;
  req.session.reprise = false;
  res.render("etape1", {
    titre: "Vos informations â€” Afriland E-CrÃ©dit", erreur: null,
    donnees: req.session.demande || {}, reprise,
  });
});

router.get("/demande/continuer", (req, res) => {
  res.redirect(etapeSuivante(req.session.demande));
});

router.get("/demande/nouveau", (req, res) => {
  if (req.session.brouillonId) supprimerBrouillon(req.session.brouillonId);
  res.clearCookie("brouillon_id");
  req.session.demande = {};
  delete req.session.brouillonId;
  res.redirect("/demande");
});

router.post("/demande/etape1", (req, res) => {
  const { nom, prenom, email, telephone, cni, client_existant, numero_compte, code_verification } = req.body;
  const telValide = validerTelephone(telephone);
  const cniValide = validerCNI(cni);
  const estClient = client_existant === "oui";
  const rendreErreur = (msg) => res.render("etape1", {
    titre: "Vos informations â€” Afriland E-CrÃ©dit", erreur: msg, donnees: req.body, reprise: false,
  });

  if (!nom || !prenom || !email) {
    return rendreErreur("Merci de renseigner votre nom, prÃ©nom et email.");
  }
  if (!telValide) {
    return rendreErreur("NumÃ©ro de tÃ©lÃ©phone invalide (format camerounais requis : 9 chiffres commenÃ§ant par 6).");
  }
  if (!cniValide) {
    return rendreErreur("Le numÃ©ro CNI doit contenir exactement 9 caractÃ¨res.");
  }

  let numeroCompteValide = null;
  let codeHash = null;
  if (estClient) {
    numeroCompteValide = validerNumeroCompte(numero_compte);
    if (!numeroCompteValide) {
      return rendreErreur("Le numÃ©ro de compte Afriland doit contenir exactement 11 chiffres.");
    }
    const codeValide = validerCodeVerification(code_verification);
    if (!codeValide) {
      return rendreErreur("Merci de dÃ©finir un code de vÃ©rification Ã  4-6 chiffres pour confirmer que vous Ãªtes bien le titulaire du compte.");
    }
    codeHash = bcrypt.hashSync(codeValide, 10);
  }

  req.session.demande = {
    nom, prenom, email, telephone: telValide, cni: cniValide,
    client_existant: estClient ? 1 : 0,
    numero_compte: numeroCompteValide,
    code_verification_hash: codeHash,
  };
  persisterBrouillon(req);
  res.redirect("/demande/pret");
});

// ============================================================
// ETAPE 2 â€” DETAILS DU PRET
// ============================================================
router.get("/demande/pret", (req, res) => {
  if (!req.session.demande || !req.session.demande.nom) return res.redirect("/demande");
  res.render("etape2", { titre: "Votre demande â€” Afriland E-CrÃ©dit", erreur: null, donnees: req.session.demande });
});

router.post("/demande/pret", (req, res) => {
  const { montant, duree, motif, situation } = req.body;
  const m = parseFloat(montant);
  const rendreErreur = (msg) => res.render("etape2", {
    titre: "Votre demande â€” Afriland E-CrÃ©dit", erreur: msg, donnees: { ...req.session.demande, montant, duree, motif, situation },
  });
  if (!m || m < 50000 || m > 5000000) {
    return rendreErreur("Le montant doit Ãªtre compris entre 50 000 et 5 000 000 FCFA.");
  }
  if (!duree || !motif || !situation) {
    return rendreErreur("Merci de complÃ©ter tous les champs.");
  }
  req.session.demande.montant = m;
  req.session.demande.duree = parseInt(duree);
  req.session.demande.motif = motif;
  req.session.demande.situation = situation;
  persisterBrouillon(req);
  res.redirect("/demande/documents");
});

// ============================================================
// ETAPE 3 â€” DOCUMENTS (8 pieces, PDF uniquement, verifiees)
// ============================================================
router.get("/demande/documents", (req, res) => {
  if (!req.session.demande || !req.session.demande.montant) return res.redirect("/demande");
  res.render("etape3", { titre: "Vos documents â€” Afriland E-CrÃ©dit", documents: DOCUMENTS_REQUIS, erreur: null });
});

router.post("/demande/documents", upload.fields(DOCUMENTS_REQUIS.map(d => ({ name: d.cle, maxCount: 1 }))), async (req, res, next) => {
  try {
    const manquants = DOCUMENTS_REQUIS.filter(d => !req.files || !req.files[d.cle]);
    if (manquants.length) {
      return res.render("etape3", { titre: "Vos documents â€” Afriland E-CrÃ©dit", documents: DOCUMENTS_REQUIS,
        erreur: `PiÃ¨ce(s) manquante(s) : ${manquants.map(d => d.label).join(", ")}` });
    }

    // Verification du contenu de chaque PDF avant tout enregistrement sur disque
    const resultats = {};
    for (const d of DOCUMENTS_REQUIS) {
      resultats[d.cle] = await verifierDocument(d.cle, req.files[d.cle][0].buffer);
    }
    const problemes = DOCUMENTS_REQUIS
      .filter(d => resultats[d.cle].statut === "invalide" || resultats[d.cle].statut === "suspect")
      .map(d => `${d.label} â€” ${resultats[d.cle].details}`);
    if (problemes.length) {
      return res.render("etape3", { titre: "Vos documents â€” Afriland E-CrÃ©dit", documents: DOCUMENTS_REQUIS,
        erreur: `Certaines piÃ¨ces dÃ©posÃ©es ne correspondent pas Ã  ce qui est attendu :\n${problemes.join(" | ")}` });
    }

    const dossierClient = path.join(__dirname, "..", "uploads", req.session.demande.cni + "_" + Date.now());
    fs.mkdirSync(dossierClient, { recursive: true });

    const documentsEnregistres = {};
    DOCUMENTS_REQUIS.forEach(d => {
      const fichier = req.files[d.cle][0];
      const nomStocke = `${d.cle}.pdf`;
      fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
      documentsEnregistres[d.cle] = {
        nom: fichier.originalname,
        chemin: path.join(path.basename(dossierClient), nomStocke),
        verification: resultats[d.cle].statut, // "reconnu" | "a_verifier"
      };
    });

    req.session.demande.documents = documentsEnregistres;
    persisterBrouillon(req);
    res.redirect("/demande/recapitulatif");
  } catch (e) {
    next(e);
  }
});

// gestion propre de l'erreur "seul PDF autorise" levee par multer fileFilter
router.use((err, req, res, next) => {
  if (err && err.message === "SEUL_PDF_AUTORISE") {
    return res.render("etape3", { titre: "Vos documents â€” Afriland E-CrÃ©dit", documents: DOCUMENTS_REQUIS,
      erreur: "Seuls les fichiers PDF sont acceptÃ©s pour chaque piÃ¨ce." });
  }
  next(err);
});

// ============================================================
// ETAPE 4 â€” RECAPITULATIF ET SOUMISSION
// ============================================================
router.get("/demande/recapitulatif", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents) return res.redirect("/demande");
  res.render("etape4", { titre: "RÃ©capitulatif â€” Afriland E-CrÃ©dit", d, documents: DOCUMENTS_REQUIS });
});

router.post("/demande/soumettre", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents) return res.redirect("/demande");

  const reference = genererReference();
  creerDemande({
    reference, nom: d.nom, prenom: d.prenom, email: d.email, telephone: d.telephone, cni: d.cni,
    client_existant: d.client_existant, numero_compte: d.numero_compte,
    code_verification_hash: d.code_verification_hash,
    montant: d.montant, duree: d.duree, motif: d.motif, situation: d.situation,
    documents: d.documents, statut: "nouvelle", date_soumission: new Date().toISOString(),
  });

  if (req.session.brouillonId) supprimerBrouillon(req.session.brouillonId);
  res.clearCookie("brouillon_id");
  req.session.demande = null;
  delete req.session.brouillonId;
  res.redirect("/confirmation/" + reference);
});

// ============================================================
// CONFIRMATION / STATUT DE LA DEMANDE
// ============================================================
router.get("/confirmation/:reference", (req, res) => {
  const demande = trouverParReference(req.params.reference);
  if (!demande) return res.redirect("/");
  res.render("confirmation", { titre: "Ma demande â€” Afriland E-CrÃ©dit", demande });
});

module.exports = router;

