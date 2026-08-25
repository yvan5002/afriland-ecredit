const express = require("express");
const router = express.Router();
const {
  listerToutesDemandes, statistiquesGlobales, trouverParId,
  listerGestionnaires, creerGestionnaire, trouverGestionnaireParId, definirActifGestionnaire, trouverGestionnaireParIdentifiant,
} = require("../db/database");

// ------------------------------------------------------------
// Compte directeur de démonstration.
// Cet espace n'est lié depuis aucune page publique : on y accède
// uniquement en connaissant directement l'adresse /directeur/connexion.
// ------------------------------------------------------------
const DIRECTEUR_IDENTIFIANT = "directeur";
const DIRECTEUR_MDP = "directeur2026";
const DIRECTEUR_NOM = "Directeur Afriland";

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
// GESTION DES GESTIONNAIRES — créer un compte gestionnaire, le désactiver
// ("déconnecter") ou le réactiver.
// ============================================================
router.get("/gestionnaires", exigerDirecteur, (req, res) => {
  res.render("directeur_gestionnaires", {
    titre: "Gestion des gestionnaires — Espace directeur d'agence",
    gestionnaires: listerGestionnaires(),
    erreur: null,
    succes: null,
  });
});

router.post("/gestionnaires", exigerDirecteur, (req, res) => {
  const { identifiant, mdp, nom } = req.body;
  const rendre = (erreur, succes) => res.render("directeur_gestionnaires", {
    titre: "Gestion des gestionnaires — Espace directeur d'agence",
    gestionnaires: listerGestionnaires(), erreur, succes,
  });

  const idPropre = (identifiant || "").trim();
  const nomPropre = (nom || "").trim();

  if (!idPropre || !mdp || !nomPropre) {
    return rendre("Merci de compléter l'identifiant, le mot de passe et le nom complet.", null);
  }
  if (mdp.length < 6) {
    return rendre("Le mot de passe doit contenir au moins 6 caractères.", null);
  }
  if (trouverGestionnaireParIdentifiant(idPropre)) {
    return rendre("Cet identifiant est déjà utilisé par un autre gestionnaire.", null);
  }

  creerGestionnaire({ identifiant: idPropre, mdp, nom: nomPropre });
  rendre(null, `Le compte gestionnaire « ${idPropre} » a bien été créé.`);
});

router.post("/gestionnaires/:id/desactiver", exigerDirecteur, (req, res) => {
  const gestionnaire = trouverGestionnaireParId(req.params.id);
  if (gestionnaire) definirActifGestionnaire(gestionnaire.id, false);
  res.redirect("/directeur/gestionnaires");
});

router.post("/gestionnaires/:id/reactiver", exigerDirecteur, (req, res) => {
  const gestionnaire = trouverGestionnaireParId(req.params.id);
  if (gestionnaire) definirActifGestionnaire(gestionnaire.id, true);
  res.redirect("/directeur/gestionnaires");
});

module.exports = router;
module.exports.DIRECTEUR_IDENTIFIANT = DIRECTEUR_IDENTIFIANT;
module.exports.DIRECTEUR_MDP = DIRECTEUR_MDP;
module.exports.DIRECTEUR_NOM = DIRECTEUR_NOM;
