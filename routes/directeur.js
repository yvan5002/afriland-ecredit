const express = require("express");
const router = express.Router();
const {
  listerToutesDemandes, statistiquesGlobales, trouverParId,
  listerComptes, creerCompte, trouverCompteParId, definirActifCompte, trouverCompteParIdentifiant,
} = require("../db/database");

// ------------------------------------------------------------
// Compte directeur de démonstration.
// Cet espace n'est lié depuis aucune page publique : on y accède
// uniquement en connaissant directement l'adresse /directeur/connexion.
// ------------------------------------------------------------
const DIRECTEUR_IDENTIFIANT = "directeur";
const DIRECTEUR_MDP = "directeur2026";
const DIRECTEUR_NOM = "Directeur Afriland";

const ROLES_VALIDES = ["gestionnairegfc", "pme", "corporate", "chef_pme"];
const LABEL_ROLE = { gestionnairegfc: "Gestionnaire GFC (particuliers)", pme: "PME", corporate: "Corporate", chef_pme: "Chef des PME" };

function exigerDirecteur(req, res, next) {
  if (req.session.directeurConnecte) return next();
  return res.redirect("/directeur/connexion");
}

router.get("/connexion", (req, res) => {
  if (req.session.directeurConnecte) return res.redirect("/directeur/tableau-bord");
  res.render("directeur_connexion", { titre: "Espace directeur d'agence — Afriland E-Crédit", erreur: null });
});

router.post("/connexion", (req, res) => {
  const { identifiant, mdp } = req.body;
  if (identifiant === DIRECTEUR_IDENTIFIANT && mdp === DIRECTEUR_MDP) {
    req.session.directeurConnecte = true;
    req.session.directeurNom = DIRECTEUR_NOM;
    return res.redirect("/directeur/tableau-bord");
  }
  res.render("directeur_connexion", {
    titre: "Espace directeur d'agence — Afriland E-Crédit",
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

router.post("/deconnexion", (req, res) => {
  req.session.directeurConnecte = null;
  res.redirect("/directeur/connexion");
});

router.get("/tableau-bord", exigerDirecteur, (req, res) => {
  res.render("directeur_tableau_bord", {
    titre: "Vue d'ensemble — Espace directeur d'agence",
    directeurNom: req.session.directeurNom,
    demandes: listerToutesDemandes(),
    stats: statistiquesGlobales(),
  });
});

router.get("/demande/:id", exigerDirecteur, (req, res) => {
  const demande = trouverParId(req.params.id);
  if (!demande) return res.redirect("/directeur/tableau-bord");
  res.render("directeur_demande", {
    titre: `Demande ${demande.reference} — Espace directeur d'agence`,
    demande,
  });
});

// ============================================================
// GESTION DES COMPTES — gestionnaire GFC, PME, corporate : créer,
// désactiver ("déconnecter") ou réactiver un compte de n'importe
// lequel des 3 espaces de traitement.
// ============================================================
router.get("/gestionnaires", exigerDirecteur, (req, res) => {
  res.render("directeur_gestionnaires", {
    titre: "Gestion des comptes — Espace directeur d'agence",
    comptes: listerComptes(),
    labelRole: LABEL_ROLE,
    erreur: null,
    succes: null,
  });
});

router.post("/gestionnaires", exigerDirecteur, (req, res) => {
  const { identifiant, mdp, nom, role } = req.body;
  const rendre = (erreur, succes) => res.render("directeur_gestionnaires", {
    titre: "Gestion des comptes — Espace directeur d'agence",
    comptes: listerComptes(), labelRole: LABEL_ROLE, erreur, succes,
  });

  const idPropre = (identifiant || "").trim();
  const nomPropre = (nom || "").trim();

  if (!idPropre || !mdp || !nomPropre || !role) {
    return rendre("Merci de compléter l'identifiant, le mot de passe, le nom complet et l'espace concerné.", null);
  }
  if (!ROLES_VALIDES.includes(role)) {
    return rendre("Espace invalide.", null);
  }
  if (mdp.length < 6) {
    return rendre("Le mot de passe doit contenir au moins 6 caractères.", null);
  }
  if (trouverCompteParIdentifiant(idPropre)) {
    return rendre("Cet identifiant est déjà utilisé par un autre compte.", null);
  }

  creerCompte({ identifiant: idPropre, mdp, nom: nomPropre, role });
  rendre(null, `Le compte « ${idPropre} » (${LABEL_ROLE[role]}) a bien été créé.`);
});

router.post("/gestionnaires/:id/desactiver", exigerDirecteur, (req, res) => {
  const compte = trouverCompteParId(req.params.id);
  if (compte) definirActifCompte(compte.id, false);
  res.redirect("/directeur/gestionnaires");
});

router.post("/gestionnaires/:id/reactiver", exigerDirecteur, (req, res) => {
  const compte = trouverCompteParId(req.params.id);
  if (compte) definirActifCompte(compte.id, true);
  res.redirect("/directeur/gestionnaires");
});

module.exports = router;
module.exports.DIRECTEUR_IDENTIFIANT = DIRECTEUR_IDENTIFIANT;
module.exports.DIRECTEUR_MDP = DIRECTEUR_MDP;
module.exports.DIRECTEUR_NOM = DIRECTEUR_NOM;
