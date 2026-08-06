const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const {
  trouverParId, listerDemandesParStatut, compterParStatut, enregistrerDecision,
} = require("../db/database");

// ------------------------------------------------------------
// Compte agent de démonstration (identique à la version Flask)
// ------------------------------------------------------------
const AGENT_IDENTIFIANT = "agent";
const AGENT_MDP = "afriland2026";
const AGENT_NOM = "Agent Afriland";

function exigerAgent(req, res, next) {
  if (req.session.agentConnecte) return next();
  return res.redirect("/agent/connexion");
}

// ============================================================
// CONNEXION
// ============================================================
router.get("/connexion", (req, res) => {
  if (req.session.agentConnecte) return res.redirect("/agent/tableau-bord");
  res.render("agent_connexion", { titre: "Espace agent — Afriland E-Crédit", erreur: null });
});

router.post("/connexion", (req, res) => {
  const { identifiant, mdp } = req.body;
  if (identifiant === AGENT_IDENTIFIANT && mdp === AGENT_MDP) {
    req.session.agentConnecte = true;
    req.session.agentNom = AGENT_NOM;
    return res.redirect("/agent/tableau-bord");
  }
  res.render("agent_connexion", {
    titre: "Espace agent — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

router.post("/deconnexion", (req, res) => {
  req.session.agentConnecte = null;
  res.redirect("/agent/connexion");
});

// ============================================================
// TABLEAU DE BORD — demandes en attente (statut = nouvelle)
// ============================================================
router.get("/tableau-bord", exigerAgent, (req, res) => {
  const demandes = listerDemandesParStatut("nouvelle");
  res.render("agent_tableau_bord", {
    titre: "Demandes à traiter — Espace agent",
    agentNom: req.session.agentNom,
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
router.get("/historique", exigerAgent, (req, res) => {
  const acceptees = listerDemandesParStatut("acceptee");
  const refusees = listerDemandesParStatut("refusee");
  const demandes = [...acceptees, ...refusees].sort(
    (a, b) => new Date(b.date_traitement) - new Date(a.date_traitement)
  );
  res.render("agent_tableau_bord", {
    titre: "Historique des décisions — Espace agent",
    agentNom: req.session.agentNom,
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
router.get("/demande/:id", exigerAgent, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/agent/tableau-bord");
  res.render("agent_demande", {
    titre: `Demande ${demande.reference} — Espace agent`,
    demande,
    erreur: null,
  });
});

// ============================================================
// CONSULTATION SÉCURISÉE D'UN DOCUMENT (réservée aux agents connectés)
// ============================================================
router.get("/documents/:id/:cle", exigerAgent, (req, res) => {
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
router.post("/demande/:id/decider", exigerAgent, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/agent/tableau-bord");

  const { decision, commentaire } = req.body;
  const texte = (commentaire || "").trim();

  if (!texte || texte.length < 15) {
    return res.render("agent_demande", {
      titre: `Demande ${demande.reference} — Espace agent`,
      demande,
      erreur: texte
        ? "La justification est trop courte. Expliquez clairement le motif de votre décision (15 caractères minimum)."
        : "Une justification écrite est obligatoire, que vous acceptiez ou refusiez cette demande.",
    });
  }
  if (demande.statut !== "nouvelle") {
    return res.redirect("/agent/tableau-bord");
  }

  const statutFinal = decision === "accepter" ? "acceptee" : "refusee";
  enregistrerDecision(req.params.id, {
    statut: statutFinal,
    commentaire: texte,
    agentNom: req.session.agentNom,
  });

  res.redirect("/agent/tableau-bord");
});

module.exports = router;
