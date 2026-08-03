const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { creerDemande, trouverParReference } = require("../db/database");

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

function validerTelephone(brut) {
  const chiffres = (brut || "").replace(/\D/g, "");
  const local = chiffres.startsWith("237") ? chiffres.slice(3) : chiffres;
  return /^6\d{8}$/.test(local) ? "+237 " + local : null;
}

function validerCNI(brut) {
  const v = (brut || "").trim().toUpperCase();
  return /^[A-Z0-9]{9}$/.test(v) ? v : null;
}

// ============================================================
// PAGE D'ACCUEIL
// ============================================================
router.get("/", (req, res) => {
  res.render("accueil", { titre: "Afriland E-Crédit — Demande de crédit en ligne" });
});

// ============================================================
// ETAPE 1 — INFORMATIONS PERSONNELLES
// ============================================================
router.get("/demande", (req, res) => {
  req.session.demande = {};
  res.render("etape1", { titre: "Vos informations — Afriland E-Crédit", erreur: null, donnees: {} });
});

router.post("/demande/etape1", (req, res) => {
  const { nom, prenom, email, telephone, cni, client_existant, numero_compte } = req.body;
  const telValide = validerTelephone(telephone);
  const cniValide = validerCNI(cni);

  if (!nom || !prenom || !email) {
    return res.render("etape1", { titre: "Vos informations — Afriland E-Crédit",
      erreur: "Merci de renseigner votre nom, prénom et email.", donnees: req.body });
  }
  if (!telValide) {
    return res.render("etape1", { titre: "Vos informations — Afriland E-Crédit",
      erreur: "Numéro de téléphone invalide (format camerounais requis : 9 chiffres commençant par 6).", donnees: req.body });
  }
  if (!cniValide) {
    return res.render("etape1", { titre: "Vos informations — Afriland E-Crédit",
      erreur: "Le numéro CNI doit contenir exactement 9 caractères.", donnees: req.body });
  }

  req.session.demande = {
    nom, prenom, email, telephone: telValide, cni: cniValide,
    client_existant: client_existant === "oui" ? 1 : 0,
    numero_compte: numero_compte || null,
  };
  res.redirect("/demande/pret");
});

// ============================================================
// ETAPE 2 — DETAILS DU PRET
// ============================================================
router.get("/demande/pret", (req, res) => {
  if (!req.session.demande || !req.session.demande.nom) return res.redirect("/demande");
  res.render("etape2", { titre: "Votre demande — Afriland E-Crédit", erreur: null });
});

router.post("/demande/pret", (req, res) => {
  const { montant, duree, motif, situation } = req.body;
  const m = parseFloat(montant);
  if (!m || m < 50000 || m > 5000000) {
    return res.render("etape2", { titre: "Votre demande — Afriland E-Crédit",
      erreur: "Le montant doit être compris entre 50 000 et 5 000 000 FCFA." });
  }
  if (!duree || !motif || !situation) {
    return res.render("etape2", { titre: "Votre demande — Afriland E-Crédit",
      erreur: "Merci de compléter tous les champs." });
  }
  req.session.demande.montant = m;
  req.session.demande.duree = parseInt(duree);
  req.session.demande.motif = motif;
  req.session.demande.situation = situation;
  res.redirect("/demande/documents");
});

// ============================================================
// ETAPE 3 — DOCUMENTS (8 pieces, PDF uniquement)
// ============================================================
router.get("/demande/documents", (req, res) => {
  if (!req.session.demande || !req.session.demande.montant) return res.redirect("/demande");
  res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS, erreur: null });
});

router.post("/demande/documents", upload.fields(DOCUMENTS_REQUIS.map(d => ({ name: d.cle, maxCount: 1 }))), (req, res, next) => {
  const manquants = DOCUMENTS_REQUIS.filter(d => !req.files || !req.files[d.cle]);
  if (manquants.length) {
    return res.render("etape3", { titre: "Vos documents — Afriland E-Crédit", documents: DOCUMENTS_REQUIS,
      erreur: `Pièce(s) manquante(s) : ${manquants.map(d => d.label).join(", ")}` });
  }

  const dossierClient = path.join(__dirname, "..", "uploads", req.session.demande.cni + "_" + Date.now());
  fs.mkdirSync(dossierClient, { recursive: true });

  const documentsEnregistres = {};
  DOCUMENTS_REQUIS.forEach(d => {
    const fichier = req.files[d.cle][0];
    const nomStocke = `${d.cle}.pdf`;
    fs.writeFileSync(path.join(dossierClient, nomStocke), fichier.buffer);
    documentsEnregistres[d.cle] = { nom: fichier.originalname, chemin: path.join(path.basename(dossierClient), nomStocke) };
  });

  req.session.demande.documents = documentsEnregistres;
  res.redirect("/demande/recapitulatif");
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
  if (!d || !d.documents) return res.redirect("/demande");

  const reference = genererReference();
  creerDemande({
    reference, nom: d.nom, prenom: d.prenom, email: d.email, telephone: d.telephone, cni: d.cni,
    client_existant: d.client_existant, numero_compte: d.numero_compte,
    montant: d.montant, duree: d.duree, motif: d.motif, situation: d.situation,
    documents: d.documents, statut: "nouvelle", date_soumission: new Date().toISOString(),
  });

  req.session.demande = null;
  res.redirect("/confirmation/" + reference);
});

// ============================================================
// CONFIRMATION
// ============================================================
router.get("/confirmation/:reference", (req, res) => {
  const demande = trouverParReference(req.params.reference);
  if (!demande) return res.redirect("/");
  res.render("confirmation", { titre: "Demande envoyée — Afriland E-Crédit", demande });
});

module.exports = router;
