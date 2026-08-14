const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { texteParOCR, texteParOCRImage, extraireImagePNGDuPDF, imageBruteVersPNG } = require("../modele/ocr");
const { evaluerRisque } = require("../modele/risque");
const { SMS_ACTIF, envoyerCodeParSMS, verifierCodeSMS } = require("../modele/sms");
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

async function verifierDocument(cle, buffer, mimetype) {
  const estImage = mimetype === "image/jpeg" || mimetype === "image/jpg" || mimetype === "image/png";
  const estPDF = mimetype === "application/pdf" || (!estImage && buffer.length >= 5 && buffer.slice(0, 5).toString() === "%PDF-");

  if (!estImage && !estPDF) {
    return { statut: "invalide", details: "Le fichier n'est ni un PDF ni une image (JPG/PNG) valide." };
  }

  let texte = "";

  if (estImage) {
    // Photo directe (JPG/PNG) : lecture optique immédiate, pas d'étape de texte numérique.
    try {
      const texteOCR = await texteParOCRImage(buffer, mimetype);
      texte = " " + (texteOCR || "").toLowerCase().replace(/\s+/g, " ") + " ";
    } catch (e) {
      console.error(">>> [ERREUR OCR IMAGE]", e.message || e);
    }
  } else {
    try {
      texte = " " + (await extraireTexte(buffer)).toLowerCase().replace(/\s+/g, " ") + " ";
    } catch (e) {
      return { statut: "invalide", details: "Ce fichier PDF est illisible ou corrompu." };
    }

    // Pas de texte numérique dans le PDF -> c'est probablement un scan/photo :
    // on tente une lecture optique (OCR) de l'image avant d'abandonner.
    if (!texte.trim()) {
      try {
        const texteOCR = await texteParOCR(buffer);
        if (texteOCR && texteOCR.trim()) {
          texte = " " + texteOCR.toLowerCase().replace(/\s+/g, " ") + " ";
        }
      } catch (e) {
        console.error(">>> [ERREUR OCR]", e.message || e);
      }
    }
  }

  if (!texte.trim()) {
    return { statut: "a_verifier", details: "Document illisible automatiquement (image de mauvaise qualité) — vérification manuelle par l'agent." };
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
const MIMETYPES_ACCEPTES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo
  fileFilter: (req, file, cb) => {
    if (!MIMETYPES_ACCEPTES.includes(file.mimetype)) {
      return cb(new Error("TYPE_FICHIER_NON_AUTORISE"));
    }
    cb(null, true);
  },
});

function extensionPourMimetype(mimetype) {
  if (mimetype === "image/png") return "png";
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") return "jpg";
  return "pdf";
}

function genererReference() {
  const date = new Date();
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `AfB-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}-${code}`;
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
// ------------------------------------------------------------
// Envoi d'email — deux méthodes possibles, choisies automatiquement
// selon les variables d'environnement présentes :
//
//   1) BREVO (recommandé) : API HTTP, pas de connexion SMTP directe,
//      donc pas bloquée par Gmail sur les IP des serveurs cloud
//      (Render, Railway, etc.). Variables : BREVO_API_KEY,
//      BREVO_SENDER_EMAIL (et BREVO_SENDER_NOM en option).
//
//   2) GMAIL SMTP (repli) : nécessite un mot de passe d'application
//      Gmail. Variables : EMAIL_USER, EMAIL_PASS.
//
// Si aucune des deux n'est configurée, on reste en mode test
// (le code s'affiche uniquement dans les logs).
// ------------------------------------------------------------
const BREVO_ACTIF = !!process.env.BREVO_API_KEY && !!process.env.BREVO_SENDER_EMAIL;

const transporteurEmail = (!BREVO_ACTIF && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

function genererCodeOTP() {
  return String(crypto.randomInt(100000, 1000000)); // 6 chiffres
}

function gabaritEmailCode(prenom, code) {
  return `
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:auto;">
      <h2 style="color:#7C0A1E;">Afriland E-Crédit</h2>
      <p>Bonjour ${prenom},</p>
      <p>Voici votre code de vérification pour confirmer votre identité et continuer votre demande de crédit :</p>
      <p style="font-size:28px; font-weight:bold; letter-spacing:6px; color:#7C0A1E;">${code}</p>
      <p style="font-size:13px; color:#666;">Ce code est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    </div>`;
}

async function envoyerViaBrevo(destinataire, prenom, code) {
  const reponse = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NOM || "Afriland E-Crédit",
      },
      to: [{ email: destinataire, name: prenom || destinataire }],
      subject: "Votre code de vérification — Afriland E-Crédit",
      htmlContent: gabaritEmailCode(prenom, code),
    }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Brevo a refusé l'envoi (HTTP ${reponse.status}) : ${detail}`);
  }
}

async function envoyerCodeParEmail(destinataire, prenom, code) {
  if (BREVO_ACTIF) {
    await envoyerViaBrevo(destinataire, prenom, code);
    return;
  }
  if (transporteurEmail) {
    await transporteurEmail.sendMail({
      from: `"Afriland E-Crédit" <${process.env.EMAIL_USER}>`,
      to: destinataire,
      subject: "Votre code de vérification — Afriland E-Crédit",
      html: gabaritEmailCode(prenom, code),
    });
    return;
  }
  // Mode local / demo sans identifiants email configurés : le code est
  // simplement affiché dans la console pour permettre de tester le parcours.
  console.log(`>>> [MODE TEST — pas d'email configuré] Code pour ${destinataire} : ${code}`);
}

function masquerEmail(email) {
  const [u, d] = (email || "").split("@");
  if (!u || !d) return email;
  return u.slice(0, 2) + "***@" + d;
}

function masquerTelephone(numero) {
  if (!numero) return numero;
  return numero.slice(0, -4).replace(/\d/g, "•") + numero.slice(-4);
}

function etapeSuivante(d) {
  if (!d || !d.nom) return "/demande";
  if (!d.email_verifie) return "/demande/verification-email";
  if (!d.montant) return "/demande/pret";
  if (!d.documents) return "/demande/documents";
  if (!d.identite_verifiee) return "/demande/verification-identite";
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
    console.error(">>> [ERREUR ENVOI EMAIL]", e.message || e);
    return rendreErreur("Impossible d'envoyer l'email de vérification pour le moment. Réessayez dans quelques instants.");
  }

  res.redirect("/demande/verification-email");
});

// ------------------------------------------------------------
// "Email oublié" — bascule vers une vérification par SMS à la place.
// ------------------------------------------------------------
router.post("/demande/verification-sms", async (req, res) => {
  const d = req.session.demande;
  if (!d || !d.nom) return res.redirect("/demande");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));

  const rendreErreur = (msg) => res.render("verification_email", {
    titre: "Vérification de votre identité — Afriland E-Crédit",
    erreur: msg, emailMasque: masquerEmail(d.email),
    smsActif: SMS_ACTIF, methodeActuelle: d.methode_verification || "email", telephoneMasque: null,
  });

  if (!SMS_ACTIF) {
    return rendreErreur("La vérification par SMS n'est pas disponible pour le moment. Merci d'utiliser l'email.");
  }

  try {
    const numeroInternational = await envoyerCodeParSMS(req.body.telephone_sms);
    d.methode_verification = "sms";
    d.telephone_verification = numeroInternational;
    delete d.otp_hash;
    delete d.otp_expire;
    delete d.otp_tentatives;
    persisterBrouillon(req);
    res.redirect("/demande/verification-email");
  } catch (e) {
    console.error(">>> [ERREUR ENVOI SMS]", e.message || e);
    return rendreErreur("Impossible d'envoyer le SMS pour le moment. Vérifiez le numéro et réessayez.");
  }
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
    smsActif: SMS_ACTIF, methodeActuelle: d.methode_verification || "email",
    telephoneMasque: d.telephone_verification ? masquerTelephone(d.telephone_verification) : null,
  });
});

router.post("/demande/verification-email", async (req, res) => {
  const d = req.session.demande;
  if (!d || !d.nom) return res.redirect("/demande");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));

  const rendreErreur = (msg) => res.render("verification_email", {
    titre: "Vérification de votre identité — Afriland E-Crédit",
    erreur: msg, emailMasque: masquerEmail(d.email),
    smsActif: SMS_ACTIF, methodeActuelle: d.methode_verification || "email",
    telephoneMasque: d.telephone_verification ? masquerTelephone(d.telephone_verification) : null,
  });

  const saisi = (req.body.code || "").trim();

  // Méthode SMS : la vérification du code est déléguée à Twilio Verify,
  // on ne gère ni expiration ni tentatives nous-mêmes de ce côté.
  if (d.methode_verification === "sms") {
    if (!saisi) return rendreErreur("Merci de saisir le code reçu par SMS.");
    const valide = await verifierCodeSMS(d.telephone_verification, saisi);
    if (!valide) return rendreErreur("Code incorrect ou expiré. Vérifiez vos SMS et réessayez.");
    d.email_verifie = true; // nom de champ conservé pour ne rien casser ailleurs dans le code
    persisterBrouillon(req);
    return res.redirect("/demande/pret");
  }

  // Méthode email (par défaut)
  if (Date.now() > d.otp_expire) {
    return rendreErreur("Ce code a expiré. Cliquez sur « Renvoyer le code » ci-dessous.");
  }
  d.otp_tentatives = (d.otp_tentatives || 0) + 1;
  if (d.otp_tentatives > 5) {
    return rendreErreur("Trop de tentatives incorrectes. Cliquez sur « Renvoyer le code » pour recommencer.");
  }

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
  } catch (e) {
    console.error(">>> [ERREUR ENVOI EMAIL — renvoi]", e.message || e);
    /* on laisse la page de verification signaler le souci au prochain essai */
  }
  res.redirect("/demande/verification-email");
});

// ============================================================
// ETAPE 2 — DETAILS DU PRET + PROFIL POUR LE MODELE DE RISQUE
// ============================================================
const { construireCategories } = require("../modele/libelles");
const donneesModele = require("../modele/modele_risque.json");
const CATEGORIES_FORMULAIRE = construireCategories(donneesModele);

// Champs catégoriels du modèle (hors telephone/travailleur_etranger, gérés
// séparément dans le formulaire car ce sont de simples oui/non).
const CHAMPS_CATEGORIELS_PROFIL = donneesModele.colonnes_categorielles.filter(
  c => c !== "telephone" && c !== "travailleur_etranger"
);
const CHAMPS_NUMERIQUES_PROFIL = donneesModele.colonnes_numeriques.filter(
  c => c !== "duree_credit_mois" && c !== "montant_credit"
);

router.get("/demande/pret", (req, res) => {
  if (!req.session.demande || !req.session.demande.email_verifie) return res.redirect(etapeSuivante(req.session.demande));
  res.render("etape2", {
    titre: "Votre demande — Afriland E-Crédit", erreur: null,
    donnees: req.session.demande, categories: CATEGORIES_FORMULAIRE,
  });
});

router.post("/demande/pret", (req, res) => {
  const { montant, duree, motif, situation } = req.body;
  const m = parseFloat(montant);
  const rendreErreur = (msg) => res.render("etape2", {
    titre: "Votre demande — Afriland E-Crédit", erreur: msg,
    donnees: { ...req.session.demande, ...req.body }, categories: CATEGORIES_FORMULAIRE,
  });

  if (!m || m < 50000 || m > 5000000) {
    return rendreErreur("Le montant doit être compris entre 50 000 et 5 000 000 FCFA.");
  }
  if (!duree || !motif || !situation) {
    return rendreErreur("Merci de compléter tous les champs.");
  }

  const manquants = [];
  CHAMPS_CATEGORIELS_PROFIL.forEach(c => { if (!req.body[c]) manquants.push(c); });
  ["telephone", "travailleur_etranger"].forEach(c => { if (!req.body[c]) manquants.push(c); });
  CHAMPS_NUMERIQUES_PROFIL.forEach(c => { if (req.body[c] === undefined || req.body[c] === "") manquants.push(c); });
  if (manquants.length) {
    return rendreErreur("Merci de compléter toutes les informations de votre profil.");
  }

  req.session.demande.montant = m;
  req.session.demande.duree = parseInt(duree);
  req.session.demande.motif = motif;
  req.session.demande.situation = req.body.situation === "__autre__" ? (req.body.situation_autre || "autre").trim() : req.body.situation;

  const profilRisque = {
    duree_credit_mois: parseInt(duree),
    montant_credit: m,
  };
  CHAMPS_CATEGORIELS_PROFIL.forEach(c => {
    const valeur = req.body[c];
    profilRisque[c] = valeur === "__autre__" ? (req.body[c + "_autre"] || "autre").trim() : valeur;
  });
  CHAMPS_NUMERIQUES_PROFIL.forEach(c => { profilRisque[c] = Number(req.body[c]); });
  profilRisque.telephone = req.body.telephone;
  profilRisque.travailleur_etranger = req.body.travailleur_etranger;
  req.session.demande.profil_risque = profilRisque;

  persisterBrouillon(req);
  res.redirect("/demande/documents");
});

// ============================================================
// ETAPE 3 — DOCUMENTS (8 pieces, PDF uniquement, verifiees)
// ============================================================
// ------------------------------------------------------------
// Verification "live" d'une seule piece a la fois (appelee en
// AJAX depuis etape3.ejs des que le client choisit un fichier,
// pour un retour immediat avant meme la soumission du formulaire).
// ------------------------------------------------------------
router.post("/demande/documents/verifier-un", (req, res) => {
  upload.single("fichier")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ statut: "invalide", details: "Seuls les fichiers PDF, JPG ou PNG sont acceptés." });
    }
    const cle = req.body.cle;
    const docReq = DOCUMENTS_REQUIS.find(d => d.cle === cle);
    if (!docReq) return res.status(400).json({ statut: "invalide", details: "Pièce inconnue." });
    if (!req.file) return res.status(400).json({ statut: "invalide", details: "Aucun fichier reçu." });
    try {
      const resultat = await verifierDocument(cle, req.file.buffer, req.file.mimetype);
      res.json(resultat);
    } catch (e) {
      res.status(500).json({ statut: "invalide", details: "Erreur lors de la vérification." });
    }
  });
});

router.get("/demande/documents", (req, res) => {
  if (!req.session.demande || !req.session.demande.email_verifie || !req.session.demande.montant) return res.redirect(etapeSuivante(req.session.demande));
  res.render("etape3", {
    titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS, erreur: null,
    documentsExistants: req.session.demande.documents || {},
  });
});

router.post("/demande/documents", upload.fields(DOCUMENTS_REQUIS.map(d => ({ name: d.cle, maxCount: 1 }))), async (req, res, next) => {
  try {
    const documentsExistants = req.session.demande.documents || {};
    const manquants = DOCUMENTS_REQUIS.filter(d => (!req.files || !req.files[d.cle]) && !documentsExistants[d.cle]);
    if (manquants.length) {
      return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
        documentsExistants, erreur: `Pièce(s) manquante(s) : ${manquants.map(d => d.label).join(", ")}` });
    }

    // Seuls les nouveaux fichiers réellement envoyés sont (re)vérifiés — les
    // pièces déjà déposées lors d'un passage précédent sont conservées telles
    // quelles, sans redemander au client de les fournir à nouveau.
    const resultats = {};
    for (const d of DOCUMENTS_REQUIS) {
      if (req.files && req.files[d.cle]) {
        resultats[d.cle] = await verifierDocument(d.cle, req.files[d.cle][0].buffer, req.files[d.cle][0].mimetype);
      }
    }
    const problemes = DOCUMENTS_REQUIS
      .filter(d => resultats[d.cle] && (resultats[d.cle].statut === "invalide" || resultats[d.cle].statut === "suspect"))
      .map(d => `${d.label} — ${resultats[d.cle].details}`);
    if (problemes.length) {
      return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
        documentsExistants, erreur: `Certaines pièces déposées ne correspondent pas à ce qui est attendu :\n${problemes.join(" | ")}` });
    }

    const dossierClient = path.join(__dirname, "..", "uploads", req.session.demande.cni + "_" + Date.now());
    let dossierCree = false;

    const documentsEnregistres = { ...documentsExistants };
    DOCUMENTS_REQUIS.forEach(d => {
      if (!req.files || !req.files[d.cle]) return; // on garde la pièce déjà déposée précédemment
      if (!dossierCree) { fs.mkdirSync(dossierClient, { recursive: true }); dossierCree = true; }
      const fichier = req.files[d.cle][0];
      const nomStocke = `${d.cle}.${extensionPourMimetype(fichier.mimetype)}`;
      fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
      documentsEnregistres[d.cle] = {
        nom: fichier.originalname,
        chemin: path.join(path.basename(dossierClient), nomStocke),
        mimetype: fichier.mimetype,
        verification: resultats[d.cle].statut, // "reconnu" | "a_verifier"
      };
    });

    req.session.demande.documents = documentsEnregistres;
    persisterBrouillon(req);
    res.redirect("/demande/verification-identite");
  } catch (e) {
    next(e);
  }
});

// gestion propre de l'erreur "type de fichier non autorise" levee par multer fileFilter
router.use((err, req, res, next) => {
  if (err && err.message === "TYPE_FICHIER_NON_AUTORISE") {
    return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
      documentsExistants: (req.session.demande && req.session.demande.documents) || {},
      erreur: "Seuls les fichiers PDF, JPG ou PNG sont acceptés pour chaque pièce." });
  }
  next(err);
});

// ============================================================
// ETAPE VERIFICATION D'IDENTITE — comparaison photo/CNI
// (juste avant le récapitulatif)
// ============================================================
router.get("/demande/verification-identite", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents) return res.redirect(etapeSuivante(d));
  if (d.identite_verifiee) return res.redirect("/demande/recapitulatif");
  res.render("verification_identite", {
    titre: "Vérification d'identité — Afriland E-Crédit",
    erreur: null,
  });
});

// Sert la photo de la CNI déjà déposée, pour comparaison côté navigateur
// (jamais stockée séparément, toujours relue depuis le fichier original —
// que ce soit un PDF scanné ou une photo JPG/PNG déposée directement).
router.get("/demande/verification-identite/image-cni", async (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents || !d.documents.cni) return res.status(404).end();
  try {
    const cheminComplet = path.join(__dirname, "..", "uploads", d.documents.cni.chemin);
    const buffer = fs.readFileSync(cheminComplet);
    const mimetype = d.documents.cni.mimetype || "application/pdf";
    const png = mimetype === "application/pdf"
      ? await extraireImagePNGDuPDF(buffer)
      : imageBruteVersPNG(buffer, mimetype);
    if (!png) return res.status(404).end();
    res.set("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    console.error(">>> [ERREUR IMAGE CNI]", e.message || e);
    res.status(500).end();
  }
});

router.post("/demande/verification-identite", (req, res) => {
  const d = req.session.demande;
  if (!d || !d.documents) return res.redirect(etapeSuivante(d));

  const correspond = req.body.correspond === "oui";
  const score = parseFloat(req.body.score);

  d.identite_verifiee = true;
  d.identite_correspond = correspond;
  d.identite_score = isNaN(score) ? null : Math.round(score * 100) / 100;
  persisterBrouillon(req);
  res.redirect("/demande/recapitulatif");
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

  // Calcul du score de risque (modèle scikit-learn porté en JS — voir modele/risque.js)
  let scoreRisque = null;
  if (d.profil_risque) {
    try {
      scoreRisque = evaluerRisque(d.profil_risque);
    } catch (e) {
      console.error(">>> [ERREUR MODELE DE RISQUE]", e.message || e);
    }
  }

  creerDemande({
    reference, nom: d.nom, prenom: d.prenom, email: d.email, telephone: d.telephone, cni: d.cni,
    numero_compte: d.numero_compte, email_verifie: true,
    montant: d.montant, duree: d.duree, motif: d.motif, situation: d.situation,
    profil_risque: d.profil_risque || null,
    score_risque_pourcentage: scoreRisque ? scoreRisque.pourcentage : null,
    score_risque_facteurs: scoreRisque ? scoreRisque.facteurs : null,
    identite_correspond: d.identite_correspond !== undefined ? d.identite_correspond : null,
    identite_score: d.identite_score !== undefined ? d.identite_score : null,
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
