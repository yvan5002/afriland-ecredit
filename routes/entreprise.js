// ============================================================
// Parcours de demande de crédit — ENTREPRISES
//
// Un SEUL formulaire de départ (plus de choix "PME ou Corporate"
// demandé au client) : selon le chiffre d'affaires renseigné, le
// dossier est automatiquement routé —
//
//   chiffre d'affaires > 2 milliards FCFA -> CORPORATE
//   chiffre d'affaires <= 2 milliards FCFA (ou non renseigné) -> PME
//
// Déroulé ensuite commun aux deux, seuls la liste de documents et le
// vivier d'agents diffèrent :
//   infos (rien d'obligatoire à part l'email)
//   -> vérification email (OTP)
//   -> choix d'un agent nommé ("Bienvenue chez les PME" / "...Corporates")
//   -> documents (PME : 8 emplacements libres, rien d'obligatoire —
//      Corporate : liste fixe de 16 pièces réglementaires/KYC/business)
//   -> récapitulatif + génération du code de suivi
//   -> envoi (score de risque indicatif pour la PME, comme pour les
//      particuliers)
//
// PME uniquement : l'agent choisi ne fait que RECOMMANDER une décision
// (voir deuxEtapes dans routes/espace-fabrique.js) ; c'est le chef des
// PME (routes/chef-pme.js) qui valide définitivement.
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
  creerDemande,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
} = require("../db/database");

const TYPES_VALIDES = ["pme", "corporate"];
const LABEL_TYPE = { pme: "PME", corporate: "Corporate (grande entreprise)" };
const BANNIERE_TYPE = { pme: "Bienvenue chez les PME", corporate: "Bienvenue chez les Corporates" };

// Seuil de routage automatique — à ajuster librement.
const SEUIL_CHIFFRE_AFFAIRES_CORPORATE = 2_000_000_000; // 2 milliards FCFA

// Agents PME nommés — comptes créés automatiquement (voir db/database.js).
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

// Agents Corporate — un seul compte pour l'instant (aucun nom fourni par
// l'agence à ce stade). Ajouter des entrées ici suffira à en proposer
// davantage au client, exactement comme pour les agents PME ci-dessus.
const AGENTS_CORPORATE = [
  { identifiant: "corporate", nom: "Service Corporate" },
];

function agentsPour(type) { return type === "pme" ? AGENTS_PME : AGENTS_CORPORATE; }

// Nombre d'emplacements de documents libres proposés au client PME.
const NB_DOCUMENTS_LIBRES_PME = 8;

// ------------------------------------------------------------
// CORPORATE — liste réelle transmise par l'agence (KYC + réglementaire + business).
// ------------------------------------------------------------
const DOCUMENTS_CORPORATE = [
  { cle: "pv_ag_3ans", numero: 1, label: "PV d'assemblée générale sur les 3 dernières années" },
  { cle: "pv_ag_dirigeant", numero: 2, label: "PV d'assemblée générale désignant le dirigeant" },
  { cle: "rapports_commissaires", numero: 3, label: "Rapports des commissaires aux comptes sur les 3 dernières années" },
  { cle: "cv_personnel_cle", numero: 4, label: "CV du personnel clé de la structure" },
  { cle: "attestations_engagement", numero: 5, label: "Attestations d'engagement et de non-engagement chez les confrères" },
  { cle: "demande_signee", numero: 6, label: "Demande signée par la personne habilitée par les statuts" },
  { cle: "autorisation_exploitation", numero: 7, label: "Autorisation d'exploitation d'un établissement de 1ère classe" },
  { cle: "autorisation_prelevement_eaux", numero: 8, label: "Autorisation de prélèvement des eaux à des fins industrielles" },
  { cle: "autorisation_deversement_eaux", numero: 9, label: "Autorisation de déversement des eaux usées de l'usine" },
  { cle: "attestation_environnementale", numero: 10, label: "Attestation de respect des obligations environnementales" },
  { cle: "certificat_conformite_env", numero: 11, label: "Certificat de conformité environnementale" },
  { cle: "balance_agee_creances", numero: 12, label: "Balance âgée des créances clients" },
  { cle: "balance_agee_dettes", numero: 13, label: "Balance âgée des dettes fournisseurs" },
  { cle: "etat_stocks", numero: 14, label: "État des stocks" },
  { cle: "dsf_3ans", numero: 15, label: "DSF (Déclarations Statistiques et Fiscales) — 3 derniers exercices" },
  { cle: "previsionnel_24mois", numero: 16, label: "Données prévisionnelles d'activité sur 24 mois" },
];
const MOTS_CLES_CORPORATE = {
  pv_ag_3ans: ["proces verbal", "assemblee generale", "exercice"],
  pv_ag_dirigeant: ["proces verbal", "assemblee generale", "dirigeant", "nomination"],
  rapports_commissaires: ["commissaire aux comptes", "rapport", "certification"],
  cv_personnel_cle: ["curriculum vitae", "cv", "experience", "formation"],
  attestations_engagement: ["attestation", "engagement", "confreres", "banque"],
  demande_signee: ["demande de credit", "financement", "statuts", "habilite"],
  autorisation_exploitation: ["autorisation", "exploitation", "etablissement", "1ere classe", "premiere classe"],
  autorisation_prelevement_eaux: ["autorisation", "prelevement", "eaux", "industrielle"],
  autorisation_deversement_eaux: ["autorisation", "deversement", "eaux usees", "usine"],
  attestation_environnementale: ["attestation", "environnement", "obligations"],
  certificat_conformite_env: ["certificat", "conformite", "environnementale"],
  balance_agee_creances: ["balance agee", "creances", "clients"],
  balance_agee_dettes: ["balance agee", "dettes", "fournisseurs"],
  etat_stocks: ["etat des stocks", "stock", "inventaire"],
  dsf_3ans: ["dsf", "declaration statistique", "fiscale", "exercice"],
  previsionnel_24mois: ["previsionnel", "prevision", "24 mois", "activite"],
};

// ------------------------------------------------------------
// Upload PDF/image
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
  if (!brut) return "";
  const chiffres = brut.replace(/\D/g, "");
  const local = chiffres.startsWith("237") ? chiffres.slice(3) : chiffres;
  return /^6\d{8}$/.test(local) ? "+237 " + local : brut.trim();
}

function nombreDepuis(brut) {
  const n = parseFloat((brut || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Détermine PME/Corporate à partir du chiffre d'affaires déclaré.
function determinerType(chiffreAffairesBrut) {
  const ca = nombreDepuis(chiffreAffairesBrut);
  return ca !== null && ca > SEUIL_CHIFFRE_AFFAIRES_CORPORATE ? "corporate" : "pme";
}

function etapeSuivante(d) {
  if (!d || !d.email) return "/demande-entreprise";
  const type = d.type;
  if (!type) return "/demande-entreprise";
  const base = `/demande-entreprise/${type}`;
  if (!d.email_verifie) return `${base}/verification-email`;
  if (!d.agent_assigne) return `${base}/choix-agent`;
  if (!d.documents_soumis) return `${base}/documents`;
  return `${base}/recapitulatif`;
}

// ------------------------------------------------------------
// Brouillon persistant — UNE SEULE clé de session/cookie pour tout le
// parcours entreprise (le type n'est connu qu'après la première étape,
// donc il ne peut pas faire partie du nom du cookie comme avant).
// ------------------------------------------------------------
function chargerOuCreerBrouillon(req, res, next) {
  if (req.session.demandeEntreprise && req.session.demandeEntreprise.email) return next();

  const idCookie = (req.cookies || {}).brouillon_entreprise_id;
  const brouillon = trouverBrouillon(idCookie);

  if (brouillon && !brouillon.termine && brouillon.donnees && brouillon.donnees.email) {
    const donnees = { ...brouillon.donnees };
    if (donnees.documents) {
      const dossierUploads = path.join(__dirname, "..", "uploads");
      const tousPresents = Object.values(donnees.documents)
        .every(doc => fs.existsSync(path.join(dossierUploads, doc.chemin)));
      if (!tousPresents) { delete donnees.documents; delete donnees.documents_soumis; }
    }
    req.session.demandeEntreprise = donnees;
    req.session.brouillonEntrepriseId = idCookie;
    req.session.repriseEntreprise = true;
    return next();
  }

  const nouvelId = genererIdBrouillon();
  req.session.demandeEntreprise = {};
  req.session.brouillonEntrepriseId = nouvelId;
  res.cookie("brouillon_entreprise_id", nouvelId, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" });
  next();
}

function persisterBrouillon(req) {
  if (req.session.brouillonEntrepriseId) {
    sauvegarderBrouillon(req.session.brouillonEntrepriseId, req.session.demandeEntreprise);
  }
}

router.use(chargerOuCreerBrouillon);

router.param("type", (req, res, next, type) => {
  if (!TYPES_VALIDES.includes(type)) return res.redirect("/demande-entreprise");
  next();
});

// S'assure qu'on n'accède pas à une étape "pme" alors que le dossier en
// session a été déterminé "corporate" (ou l'inverse).
function exigerBonType(req, res, next) {
  const d = req.session.demandeEntreprise;
  if (d && d.type && d.type !== req.params.type) return res.redirect(etapeSuivante(d));
  next();
}

// ============================================================
// ÉTAPE 1 — FORMULAIRE UNIQUE (le type se détermine après coup)
// ============================================================
const CHAMPS_TEXTE_ENTREPRISE = [
  "raison_sociale", "numero_dossier", "forme_juridique", "rccm", "niu", "adresse",
  "capital", "chiffre_affaires", "effectif", "type_activite", "principaux_fournisseurs",
  "but_credit", "operation_compte", "origine_fonds", "destination", "montant_credit",
  "date_creation_entreprise", "total_bilan", "fatca", "representant_nom", "representant_prenom",
];

router.get("/", (req, res) => {
  const reprise = !!req.session.repriseEntreprise;
  req.session.repriseEntreprise = false;
  const d = req.session.demandeEntreprise;
  if (d && d.email) return res.redirect(etapeSuivante(d));
  res.render("entreprise_infos_pme", {
    titre: "Votre entreprise — Afriland E-Crédit",
    erreur: null, donnees: d || {}, reprise,
  });
});

router.get("/nouveau", (req, res) => {
  if (req.session.brouillonEntrepriseId) supprimerBrouillon(req.session.brouillonEntrepriseId);
  res.clearCookie("brouillon_entreprise_id");
  req.session.demandeEntreprise = {};
  delete req.session.brouillonEntrepriseId;
  res.redirect("/demande-entreprise");
});

router.post("/infos", async (req, res) => {
  const email = (req.body.email || "").trim();
  const rendreErreur = (msg) => res.render("entreprise_infos_pme", {
    titre: "Votre entreprise — Afriland E-Crédit",
    erreur: msg, donnees: { ...req.body }, reprise: false,
  });

  // Seul l'email est indispensable : c'est le seul moyen d'envoyer le code
  // de vérification et de confirmer que le dossier appartient bien à cette
  // personne. Tout le reste du formulaire est volontairement libre.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return rendreErreur("Une adresse email valide est nécessaire pour recevoir votre code de vérification.");
  }

  const type = determinerType(req.body.chiffre_affaires);

  const donnees = { type, email };
  CHAMPS_TEXTE_ENTREPRISE.forEach(champ => { donnees[champ] = (req.body[champ] || "").trim(); });
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
});

// ============================================================
// ÉTAPE 2 — VÉRIFICATION EMAIL (OTP) — commune aux deux types
// ============================================================
router.get("/:type/verification-email", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect("/demande-entreprise");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));
  res.render("entreprise_verification_email", {
    titre: "Vérification — Afriland E-Crédit",
    type, labelType: LABEL_TYPE[type], erreur: null, emailMasque: masquerEmail(d.email),
  });
});

router.post("/:type/verification-email", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect("/demande-entreprise");
  if (d.email_verifie) return res.redirect(etapeSuivante(d));

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
  res.redirect(etapeSuivante(d));
});

router.get("/:type/verification-email/renvoyer", exigerBonType, async (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email) return res.redirect("/demande-entreprise");
  const code = genererCodeOTP();
  d.otp_hash = bcrypt.hashSync(code, 10);
  d.otp_expire = Date.now() + 10 * 60 * 1000;
  d.otp_tentatives = 0;
  persisterBrouillon(req);
  try { await envoyerCodeParEmail(d.email, d.representant_prenom || d.raison_sociale || "", code); } catch (e) { /* signale au prochain essai */ }
  res.redirect(`/demande-entreprise/${type}/verification-email`);
});

// ============================================================
// ÉTAPE 3 — CHOIX DE L'AGENT (liste + bannière selon le type)
// ============================================================
router.get("/:type/choix-agent", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante(d));
  res.render("entreprise_choix_agent", {
    titre: "Choisissez votre agent — Afriland E-Crédit",
    type, banniere: BANNIERE_TYPE[type],
    agents: agentsPour(type), agentSelectionne: d.agent_assigne || "", erreur: null,
  });
});

router.post("/:type/choix-agent", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie) return res.redirect(etapeSuivante(d));

  const agentValide = agentsPour(type).find(a => a.identifiant === req.body.agent_assigne);
  if (!agentValide) {
    return res.render("entreprise_choix_agent", {
      titre: "Choisissez votre agent — Afriland E-Crédit",
      type, banniere: BANNIERE_TYPE[type], agents: agentsPour(type), agentSelectionne: "",
      erreur: "Merci de choisir un agent dans la liste.",
    });
  }

  d.agent_assigne = agentValide.identifiant;
  d.agent_assigne_nom = agentValide.nom;
  persisterBrouillon(req);
  res.redirect(`/demande-entreprise/${type}/documents`);
});

// ============================================================
// ÉTAPE 4 — DOCUMENTS
// ============================================================
router.get("/:type/documents", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.agent_assigne) return res.redirect(etapeSuivante(d));

  if (type === "pme") {
    return res.render("entreprise_documents_pme", {
      titre: "Vos documents — Afriland E-Crédit", nbEmplacements: NB_DOCUMENTS_LIBRES_PME,
      documentsExistants: d.documents || {}, erreur: null,
    });
  }
  res.render("entreprise_documents", {
    titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type],
    documents: DOCUMENTS_CORPORATE, erreur: null,
  });
});

router.post("/:type/documents", exigerBonType, (req, res, next) => {
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
      const d = req.session.demandeEntreprise;
      const manquants = liste.filter(doc => !req.files || !req.files[doc.cle]);
      if (manquants.length) {
        return res.render("entreprise_documents", {
          titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], documents: liste,
          erreur: `Pièce(s) manquante(s) : ${manquants.map(doc => doc.label).join(", ")}`,
        });
      }

      const resultats = {};
      for (const doc of liste) {
        resultats[doc.cle] = await verifierDocument(doc.cle, req.files[doc.cle][0].buffer, req.files[doc.cle][0].mimetype, MOTS_CLES_CORPORATE, liste);
      }
      const problemes = liste
        .filter(doc => resultats[doc.cle].statut === "invalide" || resultats[doc.cle].statut === "suspect")
        .map(doc => `${doc.label} — ${resultats[doc.cle].details}`);
      if (problemes.length) {
        return res.render("entreprise_documents", {
          titre: "Vos documents — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], documents: liste,
          erreur: `Certaines pièces déposées ne correspondent pas à ce qui est attendu :\n${problemes.join(" | ")}`,
        });
      }

      const dossierClient = path.join(__dirname, "..", "uploads", `corporate_${(d.rccm || d.email || "dossier").replace(/[^a-zA-Z0-9]/g, "")}_${Date.now()}`);
      fs.mkdirSync(dossierClient, { recursive: true });

      const documentsEnregistres = {};
      liste.forEach(doc => {
        const fichier = req.files[doc.cle][0];
        const nomStocke = `${doc.cle}.pdf`;
        fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
        documentsEnregistres[doc.cle] = {
          nom: fichier.originalname, libelle: doc.label,
          chemin: path.join(path.basename(dossierClient), nomStocke),
          verification: resultats[doc.cle].statut,
        };
      });

      d.documents = documentsEnregistres;
      d.documents_soumis = true;
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
  const d = req.session.demandeEntreprise;
  if (!d || !d.agent_assigne) return res.redirect(etapeSuivante(d));

  const documentsEnregistres = { ...(d.documents || {}) };
  let dossierClient = null;

  for (let i = 1; i <= NB_DOCUMENTS_LIBRES_PME; i++) {
    const cle = `doc_${i}`;
    const fichier = req.files && req.files[`fichier_${i}`] && req.files[`fichier_${i}`][0];
    const libelleSaisi = ((req.body && req.body[`libelle_${i}`]) || "").trim();

    if (!fichier) continue; // emplacement laissé vide — autorisé

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
      verification: resultat.statut,
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
router.get("/:type/recapitulatif", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.documents_soumis) return res.redirect(etapeSuivante(d));

  if (type === "pme") {
    return res.render("entreprise_recapitulatif_pme", { titre: "Récapitulatif — Afriland E-Crédit", d });
  }
  res.render("entreprise_recapitulatif", { titre: "Récapitulatif — Afriland E-Crédit", type, labelType: LABEL_TYPE[type], d, documents: DOCUMENTS_CORPORATE });
});

router.post("/:type/soumettre", exigerBonType, (req, res) => {
  const type = req.params.type;
  const d = req.session.demandeEntreprise;
  if (!d || !d.email_verifie || !d.documents_soumis) return res.redirect(etapeSuivante(d));

  const reference = genererReference(type);

  let scoreRisque = null;
  if (type === "pme") {
    try {
      scoreRisque = evaluerRisquePME({
        montant: d.montant_credit, chiffre_affaires: d.chiffre_affaires,
        total_bilan: d.total_bilan, capital: d.capital,
      });
    } catch (e) {
      console.error(">>> [ERREUR MODELE DE RISQUE PME]", e.message || e);
    }
  }

  creerDemande({
    reference, type, nom_affiche: d.raison_sociale || `Dossier ${LABEL_TYPE[type]} (${d.email})`,
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

  if (req.session.brouillonEntrepriseId) supprimerBrouillon(req.session.brouillonEntrepriseId);
  res.clearCookie("brouillon_entreprise_id");
  req.session.demandeEntreprise = null;
  delete req.session.brouillonEntrepriseId;
  res.redirect("/confirmation/" + reference);
});

module.exports = router;
