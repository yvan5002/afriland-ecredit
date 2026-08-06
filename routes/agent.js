const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
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
    resultatCode: null,
  });
});

// ============================================================
// VÉRIFICATION DU CODE CLIENT (identité du titulaire du compte)
// ============================================================
router.post("/demande/:id/verifier-code", exigerAgent, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/agent/tableau-bord");

  const codeSaisi = (req.body.code_saisi || "").trim();
  let resultatCode = "vide";
  if (demande.code_verification_hash && codeSaisi) {
    resultatCode = bcrypt.compareSync(codeSaisi, demande.code_verification_hash) ? "correct" : "incorrect";
  }

  res.render("agent_demande", {
    titre: `Demande ${demande.reference} — Espace agent`,
    demande,
    erreur: null,
    resultatCode,
  });
});

// ============================================================
// DÉCISION — accepter / refuser (commentaire obligatoire)
// ============================================================
router.post("/demande/:id/decider", exigerAgent, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/agent/tableau-bord");

  const { decision, commentaire } = req.body;
  const texte = (commentaire || "").trim();

  if (!texte) {
    return res.render("agent_demande", {
      titre: `Demande ${demande.reference} — Espace agent`,
      demande,
      erreur: "Un commentaire justificatif est obligatoire pour toute décision.",
      resultatCode: null,
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
