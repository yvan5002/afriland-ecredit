const express = require("express");
const router = express.Router();
const {
  listerToutesDemandes, statistiquesGlobales, trouverParId,
  listerAgents, creerAgent, trouverAgentParId, definirActifAgent, trouverAgentParIdentifiant,
} = require("../db/database");

// ------------------------------------------------------------
// Compte superviseur de démonstration.
// Cet espace n'est lié depuis aucune page publique : on y accède
// uniquement en connaissant directement l'adresse /superviseur/connexion.
// ------------------------------------------------------------
const SUPERVISEUR_IDENTIFIANT = "superviseur";
const SUPERVISEUR_MDP = "superviseur2026";
const SUPERVISEUR_NOM = "Superviseur Afriland";

function exigerSuperviseur(req, res, next) {
  if (req.session.superviseurConnecte) return next();
  return res.redirect("/superviseur/connexion");
}

router.get("/connexion", (req, res) => {
  if (req.session.superviseurConnecte) return res.redirect("/superviseur/tableau-bord");
  res.render("superviseur_connexion", { titre: "Espace superviseur — Afriland E-Crédit", erreur: null });
});

router.post("/connexion", (req, res) => {
  const { identifiant, mdp } = req.body;
  if (identifiant === SUPERVISEUR_IDENTIFIANT && mdp === SUPERVISEUR_MDP) {
    req.session.superviseurConnecte = true;
    req.session.superviseurNom = SUPERVISEUR_NOM;
    return res.redirect("/superviseur/tableau-bord");
  }
  res.render("superviseur_connexion", {
    titre: "Espace superviseur — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

router.post("/deconnexion", (req, res) => {
  req.session.superviseurConnecte = null;
  res.redirect("/superviseur/connexion");
});

router.get("/tableau-bord", exigerSuperviseur, (req, res) => {
  res.render("superviseur_tableau_bord", {
    titre: "Vue d'ensemble — Espace superviseur",
    superviseurNom: req.session.superviseurNom,
    demandes: listerToutesDemandes(),
    stats: statistiquesGlobales(),
  });
});

router.get("/demande/:id", exigerSuperviseur, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/superviseur/tableau-bord");
  res.render("superviseur_demande", {
    titre: `Demande ${demande.reference} — Espace superviseur`,
    demande,
  });
});

// ============================================================
// GESTION DES AGENTS — créer un compte agent, le désactiver
// ("déconnecter") ou le réactiver.
// ============================================================
router.get("/agents", exigerSuperviseur, (req, res) => {
  res.render("superviseur_agents", {
    titre: "Gestion des agents — Espace superviseur",
    agents: listerAgents(),
    erreur: null,
    succes: null,
  });
});

router.post("/agents", exigerSuperviseur, (req, res) => {
  const { identifiant, mdp, nom } = req.body;
  const rendre = (erreur, succes) => res.render("superviseur_agents", {
    titre: "Gestion des agents — Espace superviseur",
    agents: listerAgents(), erreur, succes,
  });

  const idPropre = (identifiant || "").trim();
  const nomPropre = (nom || "").trim();

  if (!idPropre || !mdp || !nomPropre) {
    return rendre("Merci de compléter l'identifiant, le mot de passe et le nom complet.", null);
  }
  if (mdp.length < 6) {
    return rendre("Le mot de passe doit contenir au moins 6 caractères.", null);
  }
  if (trouverAgentParIdentifiant(idPropre)) {
    return rendre("Cet identifiant est déjà utilisé par un autre agent.", null);
  }

  creerAgent({ identifiant: idPropre, mdp, nom: nomPropre });
  rendre(null, `Le compte agent « ${idPropre} » a bien été créé.`);
});

router.post("/agents/:id/desactiver", exigerSuperviseur, (req, res) => {
  const agent = trouverAgentParId(req.params.id);
  if (agent) definirActifAgent(agent.id, false);
  res.redirect("/superviseur/agents");
});

router.post("/agents/:id/reactiver", exigerSuperviseur, (req, res) => {
  const agent = trouverAgentParId(req.params.id);
  if (agent) definirActifAgent(agent.id, true);
  res.redirect("/superviseur/agents");
});

module.exports = router;
module.exports.SUPERVISEUR_IDENTIFIANT = SUPERVISEUR_IDENTIFIANT;
module.exports.SUPERVISEUR_MDP = SUPERVISEUR_MDP;
module.exports.SUPERVISEUR_NOM = SUPERVISEUR_NOM;
