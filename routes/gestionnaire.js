const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const {
  trouverParId, listerDemandesParStatut, compterParStatut, enregistrerDecision,
  verifierMdpGestionnaire, trouverGestionnaireParIdentifiant,
} = require("../db/database");

// ------------------------------------------------------------
// Les gestionnaires sont désormais gérés depuis l'espace directeur d'agence
// (création, désactivation) et stockés en base — voir db/database.js
// (un premier gestionnaire "gestionnaire" / "afriland2026" est créé automatiquement
// au tout premier démarrage pour ne rien casser).
//
// Un gestionnaire désactivé ("déconnecté" par le directeur) est bloqué dès
// sa prochaine requête, même s'il avait déjà une session active.
// ------------------------------------------------------------
function exigerGestionnaire(req, res, next) {
  if (!req.session.gestionnaireConnecte) return res.redirect("/gestionnaire/connexion");
  const gestionnaire = trouverGestionnaireParIdentifiant(req.session.gestionnaireIdentifiant);
  if (!gestionnaire || !gestionnaire.actif) {
    req.session.gestionnaireConnecte = null;
    return res.redirect("/gestionnaire/connexion?deconnecte=1");
  }
  next();
}

// ============================================================
// CONNEXION
// ============================================================
router.get("/connexion", (req, res) => {
  if (req.session.gestionnaireConnecte) return res.redirect("/gestionnaire/tableau-bord");
  res.render("gestionnaire_connexion", {
    titre: "Espace gestionnaire — Afriland E-Crédit",
    erreur: req.query.deconnecte ? "Votre accès a été désactivé par un directeur." : null,
  });
});

router.post("/connexion", (req, res) => {
  const { identifiant, mdp } = req.body;
  const gestionnaire = verifierMdpGestionnaire(identifiant, mdp);
  if (gestionnaire) {
    req.session.gestionnaireConnecte = true;
    req.session.gestionnaireIdentifiant = gestionnaire.identifiant;
    req.session.gestionnaireNom = gestionnaire.nom;
    return res.redirect("/gestionnaire/tableau-bord");
  }
  res.render("gestionnaire_connexion", {
    titre: "Espace gestionnaire — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

router.post("/deconnexion", (req, res) => {
  req.session.gestionnaireConnecte = null;
  res.redirect("/gestionnaire/connexion");
});

// ============================================================
// TABLEAU DE BORD — demandes en attente (statut = nouvelle)
// ============================================================
router.get("/tableau-bord", exigerGestionnaire, (req, res) => {
  const demandes = listerDemandesParStatut("nouvelle");
  res.render("gestionnaire_tableau_bord", {
    titre: "Demandes à traiter — Espace gestionnaire",
    gestionnaireNom: req.session.gestionnaireNom,
    demandes,
    compteurs: {
      nouvelle: compterParStatut("nouvelle"),
      acceptee: compterParStatut("acceptee"),
      refusee: compterParStatut("refusee"),
    },
    vue: "nouvelle",
  });
});

// ============================================================
// HISTORIQUE — demandes déjà traitées
// ============================================================
router.get("/historique", exigerGestionnaire, (req, res) => {
  const acceptees = listerDemandesParStatut("acceptee");
  const refusees = listerDemandesParStatut("refusee");
  const demandes = [...acceptees, ...refusees].sort(
    (a, b) => new Date(b.date_traitement) - new Date(a.date_traitement)
  );
  res.render("gestionnaire_tableau_bord", {
    titre: "Historique des décisions — Espace gestionnaire",
    gestionnaireNom: req.session.gestionnaireNom,
    demandes,
    compteurs: {
      nouvelle: compterParStatut("nouvelle"),
      acceptee: compterParStatut("acceptee"),
      refusee: compterParStatut("refusee"),
    },
    vue: "historique",
  });
});

// ============================================================
// DÉTAIL D'UNE DEMANDE
// ============================================================
router.get("/demande/:id", exigerGestionnaire, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/gestionnaire/tableau-bord");
  res.render("gestionnaire_demande", {
    titre: `Demande ${demande.reference} — Espace gestionnaire`,
    demande,
    erreur: null,
  });
});

// ============================================================
// CONSULTATION SÉCURISÉE D'UN DOCUMENT (réservée aux gestionnaires connectés)
// ============================================================
router.get("/documents/:id/:cle", exigerGestionnaire, (req, res) => {
  const demande = trouverParId(req.params.id);
  const doc = demande && demande.documents && demande.documents[req.params.cle];
  if (!doc) return res.status(404).send("Document introuvable.");

  const chemin = path.join(__dirname, "..", "uploads", doc.chemin);
  if (!fs.existsSync(chemin)) {
    return res.status(404).send("Ce document n'est plus disponible sur le serveur (fichier expiré après un redémarrage).");
  }
  res.sendFile(chemin);
});

// ============================================================
// DÉCISION — accepter / refuser (commentaire obligatoire)
// ============================================================
router.post("/demande/:id/decider", exigerGestionnaire, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/gestionnaire/tableau-bord");

  const { decision, commentaire } = req.body;
  const texte = (commentaire || "").trim();

  if (!texte || texte.length < 15) {
    return res.render("gestionnaire_demande", {
      titre: `Demande ${demande.reference} — Espace gestionnaire`,
      demande,
      erreur: texte
        ? "La justification est trop courte. Expliquez clairement le motif de votre décision (15 caractères minimum)."
        : "Une justification écrite est obligatoire, que vous acceptiez ou refusiez cette demande.",
    });
  }
  if (demande.statut !== "nouvelle") {
    return res.redirect("/gestionnaire/tableau-bord");
  }

  const statutFinal = decision === "accepter" ? "acceptee" : "refusee";
  enregistrerDecision(req.params.id, {
    statut: statutFinal,
    commentaire: texte,
    gestionnaireNom: req.session.gestionnaireNom,
  });

  res.redirect("/gestionnaire/tableau-bord");
});

module.exports = router;
module.exports.exigerGestionnaire = exigerGestionnaire;
