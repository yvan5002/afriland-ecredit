const express = require("express");
const router = express.Router();
const directeurRoutes = require("./directeur");
const { verifierMdpCompte } = require("../db/database");

const { DIRECTEUR_IDENTIFIANT, DIRECTEUR_MDP, DIRECTEUR_NOM } = directeurRoutes;

// Fait le lien entre le rôle stocké en base et l'espace (préfixe de route) correspondant.
const BASE_PATH_PAR_ROLE = {
  gestionnairegfc: "/gestionnairegfc",
  pme: "/pme",
  corporate: "/corporate",
  chef_pme: "/chef-pme",
};

// ------------------------------------------------------------
// Formulaire de connexion unique, visible dans le menu.
// Selon les identifiants saisis, la personne est redirigée vers le bon
// espace (gestionnaire GFC, PME, corporate ou directeur d'agence) — sans
// qu'aucun ne soit jamais mentionné avant la connexion.
// ------------------------------------------------------------
router.get("/", (req, res) => {
  if (req.session.directeurConnecte) return res.redirect("/directeur/tableau-bord");
  for (const role of Object.keys(BASE_PATH_PAR_ROLE)) {
    if (req.session[`connecte_${role}`]) return res.redirect(`${BASE_PATH_PAR_ROLE[role]}/tableau-bord`);
  }
  res.render("connexion", { titre: "Connexion — Afriland E-Crédit", erreur: null });
});

router.post("/", (req, res) => {
  const { identifiant, mdp } = req.body;

  if (identifiant === DIRECTEUR_IDENTIFIANT && mdp === DIRECTEUR_MDP) {
    req.session.directeurConnecte = true;
    req.session.directeurNom = DIRECTEUR_NOM;
    return res.redirect("/directeur/tableau-bord");
  }

  const compte = verifierMdpCompte(identifiant, mdp);
  if (compte && BASE_PATH_PAR_ROLE[compte.role]) {
    req.session[`connecte_${compte.role}`] = true;
    req.session[`identifiant_${compte.role}`] = compte.identifiant;
    req.session[`nom_${compte.role}`] = compte.nom;
    return res.redirect(`${BASE_PATH_PAR_ROLE[compte.role]}/tableau-bord`);
  }

  res.render("connexion", {
    titre: "Connexion — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

module.exports = router;
