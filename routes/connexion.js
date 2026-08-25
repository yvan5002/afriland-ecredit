const express = require("express");
const router = express.Router();
const directeurRoutes = require("./directeur");
const { verifierMdpGestionnaire } = require("../db/database");

const { DIRECTEUR_IDENTIFIANT, DIRECTEUR_MDP, DIRECTEUR_NOM } = directeurRoutes;

// ------------------------------------------------------------
// Formulaire de connexion unique, visible dans le menu.
// Selon les identifiants saisis, la personne est redirigée vers
// l'espace gestionnaire OU l'espace directeur d'agence — sans qu'aucun des deux
// ne soit jamais mentionné avant la connexion.
// ------------------------------------------------------------
router.get("/", (req, res) => {
  if (req.session.gestionnaireConnecte) return res.redirect("/gestionnaire/tableau-bord");
  if (req.session.directeurConnecte) return res.redirect("/directeur/tableau-bord");
  res.render("connexion", { titre: "Connexion — Afriland E-Crédit", erreur: null });
});

router.post("/", (req, res) => {
  const { identifiant, mdp } = req.body;

  const gestionnaire = verifierMdpGestionnaire(identifiant, mdp);
  if (gestionnaire) {
    req.session.gestionnaireConnecte = true;
    req.session.gestionnaireIdentifiant = gestionnaire.identifiant;
    req.session.gestionnaireNom = gestionnaire.nom;
    return res.redirect("/gestionnaire/tableau-bord");
  }

  if (identifiant === DIRECTEUR_IDENTIFIANT && mdp === DIRECTEUR_MDP) {
    req.session.directeurConnecte = true;
    req.session.directeurNom = DIRECTEUR_NOM;
    return res.redirect("/directeur/tableau-bord");
  }

  res.render("connexion", {
    titre: "Connexion — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

module.exports = router;
