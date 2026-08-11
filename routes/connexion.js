const express = require("express");
const router = express.Router();
const superviseurRoutes = require("./superviseur");
const { verifierMdpAgent } = require("../db/database");

const { SUPERVISEUR_IDENTIFIANT, SUPERVISEUR_MDP, SUPERVISEUR_NOM } = superviseurRoutes;

// ------------------------------------------------------------
// Formulaire de connexion unique, visible dans le menu.
// Selon les identifiants saisis, la personne est redirigée vers
// l'espace agent OU l'espace superviseur — sans qu'aucun des deux
// ne soit jamais mentionné avant la connexion.
// ------------------------------------------------------------
router.get("/", (req, res) => {
  if (req.session.agentConnecte) return res.redirect("/agent/tableau-bord");
  if (req.session.superviseurConnecte) return res.redirect("/superviseur/tableau-bord");
  res.render("connexion", { titre: "Connexion — Afriland E-Crédit", erreur: null });
});

router.post("/", (req, res) => {
  const { identifiant, mdp } = req.body;

  const agent = verifierMdpAgent(identifiant, mdp);
  if (agent) {
    req.session.agentConnecte = true;
    req.session.agentIdentifiant = agent.identifiant;
    req.session.agentNom = agent.nom;
    return res.redirect("/agent/tableau-bord");
  }

  if (identifiant === SUPERVISEUR_IDENTIFIANT && mdp === SUPERVISEUR_MDP) {
    req.session.superviseurConnecte = true;
    req.session.superviseurNom = SUPERVISEUR_NOM;
    return res.redirect("/superviseur/tableau-bord");
  }

  res.render("connexion", {
    titre: "Connexion — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

module.exports = router;
