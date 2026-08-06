const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const {
  creerDemande, trouverParReference,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
} = require("../db/database");

// ------------------------------------------------------------
// Liste officielle des pieces exigees (identique a l'application interne)
// ------------------------------------------------------------
const DOCUMENTS_REQUIS = [
  { cle: "demande_signee", numero: 1, label: "Demande de crédit signée, adressée au Directeur Général" },
  { cle: "cni", numero: 2, label: "Photocopie de la CNI en cours de validité" },
  { cle: "bulletins_paie", numero: 3, label: "3 derniers bulletins de paie" },
  { cle: "attestation_virement", numero: 4, label: "Attestation de virement irrévocable" },
  { cle: "attestation_travail", numero: 5, label: "Attestation de travail (ou de présence effective)" },
  { cle: "contrat_travail", numero: 6, label: "Contrat de travail (secteur privé)" },
  { cle: "niu", numero: 7, label: "NIU (Numéro d'Identifiant Unique)" },
  { cle: "plan_localisation", numero: 8, label: "Plan de localisation" },
];

// ------------------------------------------------------------
// Reconnaissance automatique du contenu des documents
// Approche : lecture du texte du PDF (pdf-parse) + recherche de
// mots-clés propres à chaque pièce. Un document scanné (image,
// sans couche de texte) ne peut pas être analysé ainsi : il est
// simplement marqué "à vérifier manuellement" plutôt que rejeté.
// ------------------------------------------------------------
const MOTS_CLES = {
  demande_signee: ["demande de crédit", "directeur général", "je soussigné", "j'ai l'honneur"],
  cni: ["carte nationale d'identité", "république du cameroun", "republic of cameroon", "date de naissance"],
  bulletins_paie: ["bulletin de paie", "bulletin de salaire", "net à payer", "salaire brut"],
  attestation_virement: ["virement irrévocable", "attestation de virement", "domiciliation"],
  attestation_travail: ["attestation de travail", "atteste que", "présence effective"],
  contrat_travail: ["contrat de travail", "employeur", "durée indéterminée", "durée déterminée"],
  niu: ["numéro d'identifiant unique", " niu ", "contribuable"],
  plan_localisation: ["plan de localisation", "localisation", "itinéraire"],
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
    return { statut: "a_verifier", details: "Document scanné (image) — vérification manuelle par l'agent." };
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
    return { statut: "suspect", details: `Ce fichier ressemble plutôt à : « ${autreLabel} ». Vérifiez votre dépôt.` };
  }
  if (scorePropre >= 1) return { statut: "reconnu", details: null };
  return { statut: "a_verifier", details: "Contenu non reconnu automatiquement — vérification manuelle par l'agent." };
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

// Numéro de compte Afriland : 11 chiffres (format interne des comptes clients)
function validerNumeroCompte(brut) {
  const v = (brut || "").replace(/\s/g, "");
  return /^\d{11}$/.test(v) ? v : null;
}

// ------------------------------------------------------------
// Vérification d'identité par code envoyé par email
// Tout demandeur doit déjà être client Afriland (condition pour
// obtenir un crédit) : on vérifie que l'email fourni lui appartient
// bien en envoyant un code à usage unique qu'il doit ressaisir.
// ------------------------------------------------------------
const transporteurEmail = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

function genererCodeOTP() {
  return String(crypto.randomInt(100000, 1000000)); // 6 chiffres
}

async function envoyerCodeParEmail(destinataire, prenom, code) {
  if (!transporteurEmail) {
    // Mode local / demo sans identifiants email configurés : le code est
    // simplement affiché dans la console pour permettre de tester le parcours.
    console.log(`>>> [MODE TEST — pas d'email configuré] Code pour ${destinataire} : ${code}`);
    return;
  }
  await transporteurEmail.sendMail({
    from: `"Afriland E-Crédit" <${process.env.EMAIL_USER}>`,
    to: destinataire,
    subject: "Votre code de vérification — Afriland E-Crédit",
    html: `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:auto;">
        <h2 style="color:#7C0A1E;">Afriland E-Crédit</h2>
        <p>Bonjour ${prenom},</p>
        <p>Voici votre code de vérification pour confirmer votre identité et continuer votre demande de crédit :</p>
        <p style="font-size:28px; font-weight:bold; letter-spacing:6px; color:#7C0A1E;">${code}</p>
        <p style="font-size:13px; color:#666;">Ce code est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
      </div>`,
  });
}

function masquerEmail(email) {
  const [u, d] = (email || "").split("@");
  if (!u || !d) return email;
  return u.slice(0, 2) + "***@" + d;
}

function etapeSuivante(d) {
  if (!d || !d.nom) return "/demande";
  if (!d.email_verifie) return "/demande/verification-email";
  if (!d.montant) return "/demande/pret";
  if (!d.documents) return "/demande/documents";
  return "/demande/recapitulatif";
}

// ------------------------------------------------------------
// Charge un brouillon existant (cookie brouillon_id) dans la
// session si celle-ci est vide, ou en crée un nouveau. Permet à
// un client qui quitte la page et revient (même après un
// redémarrage du serveur) de reprendre sa demande là où il s'est
// arrêté — ou de savoir clairement qu'il en démarre une nouvelle.
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
    titre: "Afriland E-Crédit — Demande de crédit en ligne",
    enCours: !!enCours,
  });
});

// ============================================================
// SUIVI D'UNE DEMANDE (statut : en cours / acceptée / refusée)
// ============================================================
router.get("/suivi", (req, res) => {
  res.render("suivi", { titre: "Suivre ma demande — Afriland E-Crédit", erreur: null });
});

router.post("/suivi", (req, res) => {
  const reference = (req.body.reference || "").trim().toUpperCase();
  const demande = trouverParReference(reference);
  if (!demande) {
    return res.render("suivi", { titre: "Suivre ma demande — Afriland E-Crédit",
      erreur: "Aucune demande ne correspond à cette référence. Vérifiez votre saisie." });
  }
  res.redirect("/confirmation/" + demande.reference);
});

// ============================================================
// ETAPE 1 — INFORMATIONS PERSONNELLES
// ============================================================
router.get("/demande", (req, res) => {
  const reprise = !!req.session.reprise;
  req.session.reprise = false;
  res.render("etape1", {
    titre: "Vos informations — Afriland E-Crédit", erreur: null,
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

router.post("/demande/etape1", async (req, res) => {
  const { nom, prenom, email, telephone, cni, numero_compte } = req.body;
  const telValide = validerTelephone(telephone);
  const cniValide = validerCNI(cni);
  const numeroCompteValide = validerNumeroCompte(numero_compte);
  const rendreErreur = (msg) => res.render("etape1", {
    titre: "Vos informations — Afriland E-Crédit", erreur: msg, donnees: req.body, reprise: false,
  });

  if (!nom || !prenom || !email) {
    return rendreErreur("Merci de renseigner votre nom, prénom et email.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return rendreErreur("Adresse email invalide.");
  }
  if (!telValide) {
    return rendreErreur("Numéro de téléphone invalide (format camerounais requis : 9 chiffres commençant par 6).");
  }
  if (!cniValide) {
    return rendreErreur("Le numéro CNI doit contenir exactement 9 caractères.");
  }
  if (!numeroCompteValide) {
    return rendreErreur("Le numéro de compte Afriland doit contenir exactement 11 chiffres. Un compte est nécessaire pour toute demande de crédit.");
  }

  const code = genererCodeOTP();
  req.session.demande = {
    nom, prenom, email, telephone: telValide, cni: cniValide,
    numero_compte: numeroCompteValide,
    email_verifie: false,
    otp_hash: bcrypt.hashSync(code, 10),
    otp_expire: Date.now() + 10 * 60 * 1000,
    otp_tentatives: 0,
  };
  persisterBrouillon(req);

  try {
    await envoyerCodeParEmail(email, prenom, code);
  } catch (e) {
    return rendreErreur("Impossible d'envoyer l'email de vérification pour le moment. Réessayez dans quelques instants.");
  }

  res.redirect("/demande/verification-email");
});

// ============================================================
// VÉRIFICATION DE L'EMAIL PAR CODE (OTP)
// ============================================================
router.get("/demande/verification-email", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.nom) return res.redirect("/demande");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));
  res.render("verification_email", {
    titre: "Vérification de votre identité — Afriland E-Crédit",
    erreur: null, emailMasque: masquerEmail(d.email),
  });
});

router.post("/demande/verification-email", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.nom) return res.redirect("/demande");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));

  const rendreErreur = (msg) => res.render("verification_email", {
    titre: "Vérification de votre identité — Afriland E-Crédit",
    erreur: msg, emailMasque: masquerEmail(d.email),
  });

  if (Date.now() > d.otp_expire) {
    return rendreErreur("Ce code a expiré. Cliquez sur « Renvoyer le code » ci-dessous.");
  }
  d.otp_tentatives = (d.otp_tentatives || 0) + 1;
  if (d.otp_tentatives > 5) {
    return rendreErreur("Trop de tentatives incorrectes. Cliquez sur « Renvoyer le code » pour recommencer.");
  }

  const saisi = (req.body.code || "").trim();
  if (!saisi || !bcrypt.compareSync(saisi, d.otp_hash)) {
    persisterBrouillon(req);
    return rendreErreur("Code incorrect. Vérifiez votre boîte mail et réessayez.");
  }

  d.email_verifie = true;
  delete d.otp_hash;
  delete d.otp_expire;
  delete d.otp_tentatives;
  persisterBrouillon(req);
  res.redirect("/demande/pret");
});

router.get("/demande/verification-email/renvoyer", async (req, res) => {
  const d = req.session.demande;
  if (!d || !d.nom) return res.redirect("/demande");
  const code = genererCodeOTP();
  d.otp_hash = bcrypt.hashSync(code, 10);
  d.otp_expire = Date.now() + 10 * 60 * 1000;
  d.otp_tentatives = 0;
  persisterBrouillon(req);
  try {
    await envoyerCodeParEmail(d.email, d.prenom, code);
  } catch (e) { /* on laisse la page de verification signaler le souci au prochain essai */ }
  res.redirect("/demande/verification-email");
});

// ============================================================
// ETAPE 2 — DETAILS DU PRET
// ============================================================
router.get("/demande/pret", (req, res) => {
  if (!req.session.demande || !req.session.demande.email_verifie) return res.redirect(etapeSuivante(req.session.demande));
  res.render("etape2", { titre: "Votre demande — Afriland E-Crédit", erreur: null, donnees: req.session.demande });
});

router.post("/demande/pret", (req, res) => {
  const { montant, duree, motif, situation } = req.body;
  const m = parseFloat(montant);
  const rendreErreur = (msg) => res.render("etape2", {
    titre: "Votre demande — Afriland E-Crédit", erreur: msg, donnees: { ...req.session.demande, montant, duree, motif, situation },
  });
  if (!m || m < 50000 || m > 5000000) {
    return rendreErreur("Le montant doit être compris entre 50 000 et 5 000 000 FCFA.");
  }
  if (!duree || !motif || !situation) {
    return rendreErreur("Merci de compléter tous les champs.");
  }
  req.session.demande.montant = m;
  req.session.demande.duree = parseInt(duree);
  req.session.demande.motif = motif;
  req.session.demande.situation = situation;
  persisterBrouillon(req);
  res.redirect("/demande/documents");
});

// ============================================================
// ETAPE 3 — DOCUMENTS (8 pieces, PDF uniquement, verifiees)
// ============================================================
router.get("/demande/documents", (req, res) => {
  if (!req.session.demande || !req.session.demande.email_verifie || !req.session.demande.montant) return res.redirect(etapeSuivante(req.session.demande));
  res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS, erreur: null });
});

router.post("/demande/documents", upload.fields(DOCUMENTS_REQUIS.map(d => ({ name: d.cle, maxCount: 1 }))), async (req, res, next) => {
  try {
    const manquants = DOCUMENTS_REQUIS.filter(d => !req.files || !req.files[d.cle]);
    if (manquants.length) {
      return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
        erreur: `Pièce(s) manquante(s) : ${manquants.map(d => d.label).join(", ")}` });
    }

    // Verification du contenu de chaque PDF avant tout enregistrement sur disque
    const resultats = {};
    for (const d of DOCUMENTS_REQUIS) {
      resultats[d.cle] = await verifierDocument(d.cle, req.files[d.cle][0].buffer);
    }
    const problemes = DOCUMENTS_REQUIS
      .filter(d => resultats[d.cle].statut === "invalide" || resultats[d.cle].statut === "suspect")
      .map(d => `${d.label} — ${resultats[d.cle].details}`);
    if (problemes.length) {
      return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
        erreur: `Certaines pièces déposées ne correspondent pas à ce qui est attendu :\n${problemes.join(" | ")}` });
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
    return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
      erreur: "Seuls les fichiers PDF sont acceptés pour chaque pièce." });
  }
  next(err);
});

// ============================================================
// ETAPE 4 — RECAPITULATIF ET SOUMISSION
// ============================================================
router.get("/demande/recapitulatif", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents) return res.redirect("/demande");
  res.render("etape4", { titre: "Récapitulatif — Afriland E-Crédit", d, documents: DOCUMENTS_REQUIS });
});

router.post("/demande/soumettre", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.email_verifie || !d.documents) return res.redirect(etapeSuivante(d));

  const reference = genererReference();
  creerDemande({
    reference, nom: d.nom, prenom: d.prenom, email: d.email, telephone: d.telephone, cni: d.cni,
    numero_compte: d.numero_compte, email_verifie: true,
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
  res.render("confirmation", { titre: "Ma demande — Afriland E-Crédit", demande });
});

module.exports = router;
