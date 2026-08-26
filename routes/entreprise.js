// ============================================================
// Parcours de demande de crédit — ENTREPRISES (PME et Corporate)
//
// CORPORATE : parcours inchangé — infos -> vérification email ->
// détails du prêt -> documents (liste fixe) -> récapitulatif -> envoi.
//
// PME : parcours spécifique, revu en profondeur —
//   infos (champs du formulaire papier PME, RIEN d'obligatoire à part
//   l'email, nécessaire pour recevoir le code de vérification)
//   -> vérification email
//   -> choix d'un agent PME nommé (le dossier lui sera assigné)
//   -> documents (8 emplacements libres, SANS intitulé imposé : le
//      client tape lui-même le nom de chaque pièce ; rien n'est
//      obligatoire, un dossier incomplet peut être envoyé)
//   -> récapitulatif + génération du code de suivi
//   -> envoi (calcul d'un score de risque indicatif, comme pour les
//      particuliers, visible par l'agent puis par le chef des PME)
//
// Ensuite : l'agent PME choisi ne fait que RECOMMANDER une décision
// (voir deuxEtapes dans routes/espace-fabrique.js) ; c'est le chef des
// PME (voir routes/chef-pme.js) qui valide définitivement — le client
// ne voit "accepté"/"refusé" qu'à ce moment-là.
// ============================================================
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { verifierDocument, normaliser } = require("../modele/verification");
const { genererCodeOTP, envoyerCodeParEmail, masquerEmail } = require("../modele/email");
const { evaluerRisquePME } = require("../modele/risque");
const {
  creerDemande, trouverParReference,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
} = require("../db/database");

const TYPES_VALIDES = ["pme", "corporate"];
const LABEL_TYPE = { pme: "PME", corporate: "Corporate (grande entreprise)" };

// Agents PME nommés — comptes créés automatiquement (voir db/database.js)
// avec des mots de passe simples fournis à l'agence.
const AGENTS_PME = [
  { identifiant: "eyoum", nom: "Mme Eyoum" },
  { identifiant: "dim", nom: "Mr Dim" },
  { identifiant: "pidjou", nom: "Mr Pidjou" },
  { identifiant: "ibrahima", nom: "Mr Ibrahima" },
  { identifiant: "guypabdo", nom: "Mr Guy Pabdo" },
  { identifiant: "nnengue", nom: "Mme Nnengue" },
  { identifiant: "nanfack", nom: "Mr Nanfack" },
  { identifiant: "noudjeu", nom: "Mme Noudjeu" },
];

// Nombre d'emplacements de documents libres proposés au client PME.
const NB_DOCUMENTS_LIBRES_PME = 8;

// ------------------------------------------------------------
// CORPORATE — liste de pièces fixe (inchangée)
// ------------------------------------------------------------
const DOCUMENTS_CORPORATE = [
  { cle: "statuts", numero: 1, label: "Statuts de la société" },
  { cle: "rccm", numero: 2, label: "Registre du Commerce (RCCM)" },
  { cle: "etats_financiers_certifies", numero: 3, label: "États financiers certifiés (bilan, compte de résultat)" },
  { cle: "attestation_fiscale", numero: 4, label: "Attestation de non-redevance fiscale" },
  { cle: "pv_organe", numero: 5, label: "Procès-verbal de l'organe habilité autorisant l'emprunt" },
  { cle: "piece_representant", numero: 6, label: "Pièce d'identité du représentant légal" },
];
const MOTS_CLES_CORPORATE = {
  statuts: ["statuts", "objet social", "capital social"],
  rccm: ["registre du commerce", "rccm", "immatriculation"],
  etats_financiers_certifies: ["bilan", "compte de resultat", "certifie", "commissaire aux comptes"],
  attestation_fiscale: ["non redevance", "attestation fiscale", "impots"],
  pv_organe: ["proces verbal", "conseil d'administration", "assemblee", "autorise"],
  piece_representant: ["carte nationale", "identite", "representant legal", "date de naissance"],
};

// ------------------------------------------------------------
// Upload PDF/image — mêmes règles que le parcours particulier
// ------------------------------------------------------------
const MIMETYPES_ACCEPTES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!MIMETYPES_ACCEPTES.includes(file.mimetype)) return cb(new Error("TYPE_FICHIER_NON_AUTORISE"));
    cb(null, true);
  },
});

function genererReference(type) {
  const date = new Date();
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const prefixe = type === "corporate" ? "AEC-CORP" : "AEC-PME";
  return `${prefixe}-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}-${code}`;
}

function genererIdBrouillon() { return crypto.randomBytes(12).toString("hex"); }

function validerTelephoneSouple(brut) {
  // Souple par rapport au parcours particulier : rien n'est obligatoire
  // côté PME, donc on accepte un champ vide, mais on garde un contrôle de
  // format basique si quelque chose a été saisi.
  if (!brut) return "";
  const chiffres = brut.replace(/\D/g, "");
  const local = chiffres.startsWith("237") ? chiffres.slice(3) : chiffres;
  return /^6\d{8}$/.test(local) ? "+237 " + local : brut.trim();
}

function validerTelephone(brut) {
  const chiffres = (brut || "").replace(/\D/g, "");
  const local = chiffres.startsWith("237") ? chiffres.slice(3) : chiffres;
  return /^6\d{8}$/.test(local) ? "+237 " + local : null;
}

function validerRCCM(brut) {
  const v = (brut || "").trim().toUpperCase();
  return v.length >= 6 ? v : null;
}

function validerNIU(brut) {
  const v = (brut || "").trim().toUpperCase();
  return v.length >= 6 ? v : null;
}

function etapeSuivante(type, d) {
  const base = `/demande-entreprise/${type}`;
  if (type === "pme") {
    if (!d || !d.email) return base;
    if (!d.email_verifie) return `${base}/verification-email`;
    if (!d.agent_assigne) return `${base}/choix-agent`;
    if (!d.documents_soumis) return `${base}/documents`;
    return `${base}/recapitulatif`;
  }
  if (!d || !d.raison_sociale) return base;
  if (!d.email_verifie) return `${base}/verification-email`;
  if (!d.montant) return `${base}/pret`;
  if (!d.documents) return `${base}/documents`;
  return `${base}/recapitulatif`;
}

// ------------------------------------------------------------
// Brouillon persistant — même principe que le parcours particulier,
// mais avec ses propres clés de session/cookie pour ne jamais entrer
// en conflit avec une demande "particulier" en cours dans le même
// navigateur.
// ------------------------------------------------------------
function chargerOuCreerBrouillon(req, res, next) {
  const type = req.params.type;
  const cleIdentite = type === "pme" ? "email" : "raison_sociale";
  if (req.session.demandeEntreprise && req.session.demandeEntreprise[cleIdentite]
      && req.session.demandeEntreprise.type === type) return next();

  const nomCookie = `brouillon_entreprise_${type}_id`;
  const idCookie = (req.cookies || {})[nomCookie];
  const brouillon = trouverBrouillon(idCookie);

  if (brouillon && !brouillon.termine && brouillon.donnees && brouillon.donnees.type === type) {
    const donnees = { ...brouillon.donnees };
    if (donnees.documents) {
      const dossierUploads = path.join(__dirname, "..", "uploads");
      const tousPresents = Object.values(donnees.documents)
        .every(doc => fs.existsSync(path.join(dossierUploads, doc.chemin)));
      if (!tousPresents) delete donnees.documents;
    }
    req.session.demandeEntreprise = donnees;
    req.session.brouillonEntrepriseId = idCookie;
    req.session.repriseEntreprise = true;
    return next();
  }

  const nouvelId = genererIdBrouillon();
  req.session.demandeEntreprise = { type };
  req.session.brouillonEntrepriseId = nouvelId;
  res.cookie(nomCookie, nouvelId, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" });
  next();
}

function persisterBrouillon(req) {
  if (req.session.brouillonEntrepriseId) {
    sauvegarderBrouillon(req.session.brouillonEntrepriseId, req.session.demandeEntreprise);
  }
}

router.param("type", (req, res, next, type) => {
  if (!TYPES_VALIDES.includes(type)) return res.redirect("/demande-entreprise");
  next();
});

// Page de choix — mount root ("/demande-entreprise")
router.get("/", (req, res) => {
  res.render("entreprise_choix", { titre: "Demande de crédit Entreprise — Afriland E-Crédit" });
});

router.use("/:type", chargerOuCreerBrouillon);

// ============================================================
// ÉTAPE 1 — INFORMATIONS SUR L'ENTREPRISE
// ============================================================
router.get("/:type", (req, res) => {
  const type = req.params.type;
  const reprise = !!req.session.repriseEntreprise;
  req.session.repriseEntreprise = false;
  res.render(type === "pme" ? "entreprise_infos_pme" : "entreprise_infos", {
    titre: `Votre entreprise — Afriland E-Crédit`,
    type, labelType: LABEL_TYPE[type],
    erreur: null, donnees: req.session.demandeEntreprise || { type }, reprise,
  });
});

router.get("/:type/nouveau", (req, res) => {
  const type = req.params.type;
  if (req.session.brouillonEntrepriseId) supprimerBrouillon(req.session.brouillonEntrepriseId);
  res.clearCookie(`brouillon_entreprise_${type}_id`);
  req.session.demandeEntreprise = { type };
  delete req.session.brouillonEntrepriseId;
  res.redirect(`/demande-entreprise/${type}`);
});

// ---- PME : formulaire libre, rien d'obligatoire sauf l'email ----
const CHAMPS_TEXTE_PME = [
  "raison_sociale", "numero_dossier", "forme_juridique", "rccm", "niu", "adresse",
  "capital", "chiffre_affaires", "effectif", "type_activite", "principaux_fournisseurs",
  "but_credit", "operation_compte", "origine_fonds", "destination", "montant_credit",
  "date_creation_entreprise", "total_bilan", "fatca", "representant_nom", "representant_prenom",
];

router.post("/:type/infos", async (req, res, next) => {
  const type = req.params.type;
  if (type === "pme") return traiterInfosPME(req, res);

  // ---- CORPORATE : parcours inchangé ----
  const { raison_sociale, rccm, niu_entreprise, secteur_activite, representant_nom, representant_prenom, email, telephone } = req.body;
  const telValide = validerTelephone(telephone);
  const rccmValide = validerRCCM(rccm);
  const niuValide = validerNIU(niu_entreprise);
  const rendreErreur = (msg) => res.render("entreprise_infos", {
    titre: `Votre entreprise — Afriland E-Crédit`,
    type, labelType: LABEL_TYPE[type],
    erreur: msg, donnees: { ...req.body, type }, reprise: false,
  });

  if (!raison_sociale || !representant_nom || !representant_prenom || !email) {
    return rendreErreur("Merci de compléter la raison sociale et l'identité du représentant légal.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rendreErreur("Adresse email invalide.");
  if (!telValide) return rendreErreur("Numéro de téléphone invalide (format camerounais requis : 9 chiffres commençant par 6).");
  if (!rccmValide) return rendreErreur("Numéro RCCM invalide.");
  if (!niuValide) return rendreErreur("Numéro NIU (entreprise) invalide.");

  const code = genererCodeOTP();
  req.session.demandeEntreprise = {
    type, raison_sociale, rccm: rccmValide, niu_entreprise: niuValide, secteur_activite,
    representant_nom, representant_prenom, email, telephone: telValide,
    email_verifie: false,
    otp_hash: bcrypt.hashSync(code, 10),
    otp_expire: Date.now() + 10 * 60 * 1000,
    otp_tentatives: 0,
  };
  persisterBrouillon(req);

  try {
    await envoyerCodeParEmail(email, representant_prenom, code);
  } catch (e) {
    return rendreErreur("Impossible d'envoyer l'email de vérification pour le moment. Réessayez dans quelques instants.");
  }

  res.redirect(`/demande-entreprise/${type}/verification-email`);
});

async function traiterInfosPME(req, res) {
  const type = "pme";
  const email = (req.body.email || "").trim();
  const rendreErreur = (msg) => res.render("entreprise_infos_pme", {
    titre: "Votre entreprise — Afriland E-Crédit",
    type, labelType: LABEL_TYPE[type],
    erreur: msg, donnees: { ...req.body, type }, reprise: false,
  });

  // Seul l'email est indispensable : c'est le seul moyen d'envoyer le code
  // de vérification et de confirmer que le dossier appartient bien à cette
  // personne. Tout le reste du formulaire est volontairement libre.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return rendreErreur("Une adresse email valide est nécessaire pour recevoir votre code de vérification.");
  }

  const donnees = { type, email };
  CHAMPS_TEXTE_PME.forEach(champ => { donnees[champ] = (req.body[champ] || "").trim(); });
  donnees.telephone = validerTelephoneSouple(req.body.telephone);

  const code = genererCodeOTP();
  donnees.email_verifie = false;
  donnees.otp_hash = bcrypt.hashSync(code, 10);
  donnees.otp_expire = Date.now() + 10 * 60 * 1000;
  donnees.otp_tentatives = 0;
  req.session.demandeEntreprise = donnees;
  persisterBrouillon(req);

  try {
    await envoyerCodeParEmail(email, donnees.representant_prenom || donnees.raison_sociale || "", code);
  } catch (e) {
    return rendreErreur("Impossible d'envoyer l'email de vérification pour le moment. Réessayez dans quelques instants.");
  }

  res.redirect(`/demande-entreprise/${type}/verification-email`);
}

// ============================================================
// ÉTAPE 2 — VÉRIFICATION EMAIL (OTP) — commune aux deux types
// ============================================================
router.get("/:type/verification-email", (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect(`/demande-entreprise/${type}`);
  if (d.email_verifie) return res.redirect(etapeSuivante(type, d));
  res.render("entreprise_verification_email", {
    titre: "Vérification — Afriland E-Crédit",
    type, labelType: LABEL_TYPE[type], erreur: null, emailMasque: masquerEmail(d.email),
  });
});

router.post("/:type/verification-email", (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect(`/demande-entreprise/${type}`);
  if (d.email_verifie) return res.redirect(etapeSuivante(type, d));

  const rendreErreur = (msg) => res.render("entreprise_verification_email", {
    titre: "Vérification — Afriland E-Crédit",
    type, labelType: LABEL_TYPE[type], erreur: msg, emailMasque: masquerEmail(d.email),
  });

  if (Date.now() > d.otp_expire) return rendreErreur("Ce code a expiré. Cliquez sur « Renvoyer le code » ci-dessous.");
  d.otp_tentatives = (d.otp_tentatives || 0) + 1;
  if (d.otp_tentatives > 5) return rendreErreur("Trop de tentatives incorrectes. Cliquez sur « Renvoyer le code » pour recommencer.");

  const saisi = (req.body.code || "").trim();
  if (!saisi || !bcrypt.compareSync(saisi, d.otp_hash)) {
    persisterBrouillon(req);
    return rendreErreur("Code incorrect. Vérifiez votre boîte mail et réessayez.");
  }

  d.email_verifie = true;
  delete d.otp_hash; delete d.otp_expire; delete d.otp_tentatives;
  persisterBrouillon(req);
  res.redirect(etapeSuivante(type, d));
});

router.get("/:type/verification-email/renvoyer", async (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect(`/demande-entreprise/${type}`);
  const code = genererCodeOTP();
  d.otp_hash = bcrypt.hashSync(code, 10);
  d.otp_expire = Date.now() + 10 * 60 * 1000;
  d.otp_tentatives = 0;
  persisterBrouillon(req);
  try { await envoyerCodeParEmail(d.email, d.representant_prenom || d.raison_sociale || "", code); } catch (e) { /* signale au prochain essai */ }
  res.redirect(`/demande-entreprise/${type}/verification-email`);
});

// ============================================================
// PME UNIQUEMENT — CHOIX DE L'AGENT
// ============================================================
router.get("/pme/choix-agent", (req, res) => {
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante("pme", d));
  res.render("entreprise_choix_agent", {
    titre: "Choisissez votre agent — Afriland E-Crédit",
    agents: AGENTS_PME, agentSelectionne: d.agent_assigne || "", erreur: null,
  });
});

router.post("/pme/choix-agent", (req, res) => {
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante("pme", d));

  const agentValide = AGENTS_PME.find(a => a.identifiant === req.body.agent_assigne);
  if (!agentValide) {
    return res.render("entreprise_choix_agent", {
      titre: "Choisissez votre agent — Afriland E-Crédit",
      agents: AGENTS_PME, agentSelectionne: "", erreur: "Merci de choisir un agent dans la liste.",
    });
  }

  d.agent_assigne = agentValide.identifiant;
  d.agent_assigne_nom = agentValide.nom;
  persisterBrouillon(req);
  res.redirect("/demande-entreprise/pme/documents");
});

// ============================================================
// ÉTAPE 3 (CORPORATE UNIQUEMENT) — DÉTAILS DU PRÊT
// ============================================================
router.get("/corporate/pret", (req, res) => {
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante("corporate", d));
  res.render("entreprise_pret", { titre: "Votre demande — Afriland E-Crédit", type: "corporate", labelType: LABEL_TYPE.corporate, erreur: null, donnees: d });
});

router.post("/corporate/pret", (req, res) => {
  const { montant, duree, motif } = req.body;
  const m = parseFloat(montant);
  const rendreErreur = (msg) => res.render("entreprise_pret", {
    titre: "Votre demande — Afriland E-Crédit", type: "corporate", labelType: LABEL_TYPE.corporate,
    erreur: msg, donnees: { ...req.session.demandeEntreprise, montant, duree, motif },
  });
  if (!m || m < 500000) return rendreErreur("Le montant doit être d'au moins 500 000 FCFA pour un crédit entreprise.");
  if (!duree || !motif) return rendreErreur("Merci de compléter tous les champs.");

  req.session.demandeEntreprise.montant = m;
  req.session.demandeEntreprise.duree = parseInt(duree);
  req.session.demandeEntreprise.motif = motif;
  persisterBrouillon(req);
  res.redirect("/demande-entreprise/corporate/documents");
});

// ============================================================
// ÉTAPE 4 — DOCUMENTS
// ============================================================
router.get("/:type/documents", (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;

  if (type === "pme") {
    if (!d || !d.agent_assigne) return res.redirect(etapeSuivante(type, d));
    return res.render("entreprise_documents_pme", {
      titre: "Vos documents — Afriland E-Crédit", nbEmplacements: NB_DOCUMENTS_LIBRES_PME,
      documentsExistants: d.documents || {}, erreur: null,
    });
  }

  if (!d || !d.montant) return res.redirect(etapeSuivante(type, d));
  res.render("entreprise_documents", {
    titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type],
    documents: DOCUMENTS_CORPORATE, erreur: null,
  });
});

router.post("/:type/documents", (req, res, next) => {
  const type = req.params.type;

  if (type === "pme") {
    const champs = [];
    for (let i = 1; i <= NB_DOCUMENTS_LIBRES_PME; i++) champs.push({ name: `fichier_${i}`, maxCount: 1 });
    return upload.fields(champs)(req, res, (err) => {
      if (err) return next(err);
      traiterDocumentsPME(req, res).catch(next);
    });
  }

  upload.fields(DOCUMENTS_CORPORATE.map(d => ({ name: d.cle, maxCount: 1 })))(req, res, async (err) => {
    if (err) return next(err);
    try {
      const liste = DOCUMENTS_CORPORATE;
      const manquants = liste.filter(d => !req.files || !req.files[d.cle]);
      if (manquants.length) {
        return res.render("entreprise_documents", {
          titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], documents: liste,
          erreur: `Pièce(s) manquante(s) : ${manquants.map(d => d.label).join(", ")}`,
        });
      }

      const resultats = {};
      for (const d of liste) {
        resultats[d.cle] = await verifierDocument(d.cle, req.files[d.cle][0].buffer, req.files[d.cle][0].mimetype, MOTS_CLES_CORPORATE, liste);
      }
      const problemes = liste
        .filter(d => resultats[d.cle].statut === "invalide" || resultats[d.cle].statut === "suspect")
        .map(d => `${d.label} — ${resultats[d.cle].details}`);
      if (problemes.length) {
        return res.render("entreprise_documents", {
          titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], documents: liste,
          erreur: `Certaines pièces déposées ne correspondent pas à ce qui est attendu :\n${problemes.join(" | ")}`,
        });
      }

      const dossierClient = path.join(__dirname, "..", "uploads", `${type}_${req.session.demandeEntreprise.rccm}_${Date.now()}`);
      fs.mkdirSync(dossierClient, { recursive: true });

      const documentsEnregistres = {};
      liste.forEach(d => {
        const fichier = req.files[d.cle][0];
        const nomStocke = `${d.cle}.pdf`;
        fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
        documentsEnregistres[d.cle] = {
          nom: fichier.originalname,
          chemin: path.join(path.basename(dossierClient), nomStocke),
          verification: resultats[d.cle].statut,
        };
      });

      req.session.demandeEntreprise.documents = documentsEnregistres;
      persisterBrouillon(req);
      res.redirect(`/demande-entreprise/${type}/recapitulatif`);
    } catch (e) {
      next(e);
    }
  });
});

// Documents PME : 8 emplacements libres, intitulé tapé par le client,
// AUCUN n'est obligatoire — le client peut envoyer un dossier incomplet.
async function traiterDocumentsPME(req, res) {
  const type = "pme";
  const d = req.session.demandeEntreprise;
  if (!d || !d.agent_assigne) return res.redirect(etapeSuivante(type, d));

  const documentsEnregistres = { ...(d.documents || {}) };
  let dossierClient = null;

  for (let i = 1; i <= NB_DOCUMENTS_LIBRES_PME; i++) {
    const cle = `doc_${i}`;
    const fichier = req.files && req.files[`fichier_${i}`] && req.files[`fichier_${i}`][0];
    const libelleSaisi = ((req.body && req.body[`libelle_${i}`]) || "").trim();

    if (!fichier) continue; // emplacement laissé vide — autorisé

    // Reconnaissance adaptée : les mots-clés sont ceux tapés PAR LE CLIENT
    // lui-même pour nommer sa pièce (pas de catalogue fixe possible ici,
    // contrairement au particulier/corporate). Mêmes moteurs (OCR + texte
    // natif) que le reste de l'application — voir modele/verification.js.
    const motsDuLibelle = normaliser(libelleSaisi).split(/[^a-z0-9]+/).filter(m => m.length >= 4);
    const motsCles = { [cle]: motsDuLibelle };
    const liste = [{ cle, label: libelleSaisi || `Document ${i}` }];

    const resultat = await verifierDocument(cle, fichier.buffer, fichier.mimetype, motsCles, liste);
    if (resultat.statut === "invalide") {
      return res.render("entreprise_documents_pme", {
        titre: "Vos documents — Afriland E-Crédit", nbEmplacements: NB_DOCUMENTS_LIBRES_PME,
        documentsExistants: d.documents || {},
        erreur: `Emplacement ${i} (${libelleSaisi || "sans intitulé"}) — ${resultat.details}`,
      });
    }

    if (!dossierClient) {
      dossierClient = path.join(__dirname, "..", "uploads", `pme_${(d.rccm || d.email || "dossier").replace(/[^a-zA-Z0-9]/g, "")}_${Date.now()}`);
      fs.mkdirSync(dossierClient, { recursive: true });
    }
    const nomStocke = `${cle}.pdf`;
    fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
    documentsEnregistres[cle] = {
      nom: fichier.originalname,
      libelle: libelleSaisi || `Document ${i}`,
      chemin: path.join(path.basename(dossierClient), nomStocke),
      verification: resultat.statut, // "reconnu" | "a_verifier" (jamais "suspect" ici : pas de catalogue à comparer)
    };
  }

  d.documents = documentsEnregistres;
  d.documents_soumis = true;
  persisterBrouillon(req);
  res.redirect("/demande-entreprise/pme/recapitulatif");
}

router.use((err, req, res, next) => {
  if (err && err.message === "TYPE_FICHIER_NON_AUTORISE") {
    const type = req.params.type;
    if (type === "pme") {
      return res.render("entreprise_documents_pme", {
        titre: "Vos documents — Afriland E-Crédit", nbEmplacements: NB_DOCUMENTS_LIBRES_PME,
        documentsExistants: (req.session.demandeEntreprise && req.session.demandeEntreprise.documents) || {},
        erreur: "Seuls les fichiers PDF, JPG ou PNG sont acceptés.",
      });
    }
    return res.render("entreprise_documents", {
      titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], documents: DOCUMENTS_CORPORATE,
      erreur: "Seuls les fichiers PDF, JPG ou PNG sont acceptés pour chaque pièce.",
    });
  }
  next(err);
});

// ============================================================
// ÉTAPE 5 — RÉCAPITULATIF ET SOUMISSION
// ============================================================
router.get("/:type/recapitulatif", (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;

  if (type === "pme") {
    if (!d || !d.documents_soumis) return res.redirect(etapeSuivante(type, d));
    return res.render("entreprise_recapitulatif_pme", { titre: "Récapitulatif — Afriland E-Crédit", d });
  }

  if (!d || !d.documents) return res.redirect(etapeSuivante(type, d));
  res.render("entreprise_recapitulatif", { titre: "Récapitulatif — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], d, documents: DOCUMENTS_CORPORATE });
});

router.post("/:type/soumettre", (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante(type, d));

  const reference = genererReference(type);

  if (type === "pme") {
    if (!d.documents_soumis) return res.redirect(etapeSuivante(type, d));

    let scoreRisque = null;
    try {
      scoreRisque = evaluerRisquePME({
        montant: d.montant_credit, chiffre_affaires: d.chiffre_affaires,
        total_bilan: d.total_bilan, capital: d.capital,
      });
    } catch (e) {
      console.error(">>> [ERREUR MODELE DE RISQUE PME]", e.message || e);
    }

    creerDemande({
      reference, type, nom_affiche: d.raison_sociale || `Dossier PME (${d.email})`,
      raison_sociale: d.raison_sociale, numero_dossier: d.numero_dossier, forme_juridique: d.forme_juridique,
      rccm: d.rccm, niu_entreprise: d.niu, adresse: d.adresse, capital: d.capital,
      chiffre_affaires: d.chiffre_affaires, effectif: d.effectif, type_activite: d.type_activite,
      principaux_fournisseurs: d.principaux_fournisseurs, motif: d.but_credit,
      operation_compte: d.operation_compte, origine_fonds: d.origine_fonds, destination: d.destination,
      montant: parseFloat(d.montant_credit) || 0, date_creation_entreprise: d.date_creation_entreprise,
      total_bilan: d.total_bilan, fatca: d.fatca,
      representant_nom: d.representant_nom, representant_prenom: d.representant_prenom,
      email: d.email, telephone: d.telephone, email_verifie: true,
      agent_assigne: d.agent_assigne, agent_assigne_nom: d.agent_assigne_nom,
      score_risque_pourcentage: scoreRisque ? scoreRisque.pourcentage : null,
      score_risque_facteurs: scoreRisque ? scoreRisque.facteurs : null,
      documents: d.documents || {}, statut: "nouvelle", date_soumission: new Date().toISOString(),
    });
  } else {
    if (!d.documents) return res.redirect(etapeSuivante(type, d));
    creerDemande({
      reference, type, nom_affiche: d.raison_sociale,
      raison_sociale: d.raison_sociale, rccm: d.rccm, niu_entreprise: d.niu_entreprise,
      secteur_activite: d.secteur_activite, representant_nom: d.representant_nom, representant_prenom: d.representant_prenom,
      email: d.email, telephone: d.telephone, email_verifie: true,
      montant: d.montant, duree: d.duree, motif: d.motif,
      documents: d.documents, statut: "nouvelle", date_soumission: new Date().toISOString(),
    });
  }

  if (req.session.brouillonEntrepriseId) supprimerBrouillon(req.session.brouillonEntrepriseId);
  res.clearCookie(`brouillon_entreprise_${type}_id`);
  req.session.demandeEntreprise = null;
  delete req.session.brouillonEntrepriseId;
  res.redirect("/confirmation/" + reference);
});

module.exports = router;
