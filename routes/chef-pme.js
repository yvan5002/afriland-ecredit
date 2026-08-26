// ============================================================
// Espace du CHEF DES PME — Mr Serge Chouala.
// Reçoit les dossiers déjà recommandés (acceptés ou refusés) par un
// agent PME, et rend la décision réellement définitive : c'est
// seulement à ce moment que le client voit son dossier "accepté" ou
// "refusé" sur la page de suivi.
// ============================================================
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const {
  trouverParId, listerDemandesEnAttenteChef, listerDemandesTraiteesParChef,
  enregistrerValidationChef, verifierMdpCompte, trouverCompteParIdentifiant,
} = require("../db/database");

const ROLE = "chef_pme";
const BASE_PATH = "/chef-pme";
const NOM_ESPACE = "Chef des PME";

function exigerConnexion(req, res, next) {
  if (!req.session.connecte_chef_pme) return res.redirect(`${BASE_PATH}/connexion`);
  const compte = trouverCompteParIdentifiant(req.session.identifiant_chef_pme);
  if (!compte || !compte.actif || compte.role !== ROLE) {
    req.session.connecte_chef_pme = null;
    return res.redirect(`${BASE_PATH}/connexion?deconnecte=1`);
  }
  next();
}

router.get("/connexion", (req, res) => {
  if (req.session.connecte_chef_pme) return res.redirect(`${BASE_PATH}/tableau-bord`);
  res.render("espace_connexion", {
    titre: `Espace ${NOM_ESPACE} — Afriland E-Crédit`,
    basePath: BASE_PATH, nomEspace: NOM_ESPACE,
    erreur: req.query.deconnecte ? "Votre accès a été désactivé par un directeur." : null,
  });
});

router.post("/connexion", (req, res) => {
  const { identifiant, mdp } = req.body;
  const compte = verifierMdpCompte(identifiant, mdp, ROLE);
  if (compte) {
    req.session.connecte_chef_pme = true;
    req.session.identifiant_chef_pme = compte.identifiant;
    req.session.nom_chef_pme = compte.nom;
    return res.redirect(`${BASE_PATH}/tableau-bord`);
  }
  res.render("espace_connexion", {
    titre: `Espace ${NOM_ESPACE} — Afriland E-Crédit`,
    basePath: BASE_PATH, nomEspace: NOM_ESPACE,
    erreur: "Identifiant ou mot de passe incorrect.",
  });
});

router.post("/deconnexion", (req, res) => {
  req.session.connecte_chef_pme = null;
  res.redirect(`${BASE_PATH}/connexion`);
});

router.get("/tableau-bord", exigerConnexion, (req, res) => {
  const enAttente = listerDemandesEnAttenteChef();
  const traitees = listerDemandesTraiteesParChef();
  res.render("chef_pme_tableau_bord", {
    titre: `Dossiers à valider — Espace ${NOM_ESPACE}`,
    nomConnecte: req.session.nom_chef_pme,
    demandes: enAttente,
    compteurs: {
      enAttente: enAttente.length,
      acceptee: traitees.filter(d => d.statut === "acceptee").length,
      refusee: traitees.filter(d => d.statut === "refusee").length,
    },
    vue: "attente",
  });
});

router.get("/historique", exigerConnexion, (req, res) => {
  const traitees = listerDemandesTraiteesParChef();
  const enAttente = listerDemandesEnAttenteChef();
  res.render("chef_pme_tableau_bord", {
    titre: `Historique — Espace ${NOM_ESPACE}`,
    nomConnecte: req.session.nom_chef_pme,
    demandes: traitees,
    compteurs: {
      enAttente: enAttente.length,
      acceptee: traitees.filter(d => d.statut === "acceptee").length,
      refusee: traitees.filter(d => d.statut === "refusee").length,
    },
    vue: "historique",
  });
});

function trouverDossierPME(req) {
  const demande = trouverParId(req.params.id);
  if (!demande || demande.type !== "pme") return null;
  return demande;
}

router.get("/demande/:id", exigerConnexion, (req, res) => {
  const demande = trouverDossierPME(req);
  if (!demande) return res.redirect(`${BASE_PATH}/tableau-bord`);
  res.render("chef_pme_demande", {
    titre: `Demande ${demande.reference} — Espace ${NOM_ESPACE}`,
    demande, erreur: null,
  });
});

router.get("/documents/:id/:cle", exigerConnexion, (req, res) => {
  const demande = trouverDossierPME(req);
  const doc = demande && demande.documents && demande.documents[req.params.cle];
  if (!doc) return res.status(404).send("Document introuvable.");

  const chemin = path.join(__dirname, "..", "uploads", doc.chemin);
  if (!fs.existsSync(chemin)) {
    return res.status(404).send("Ce document n'est plus disponible sur le serveur (fichier expiré après un redémarrage).");
  }
  res.sendFile(chemin);
});

router.post("/demande/:id/valider", exigerConnexion, (req, res) => {
  const demande = trouverDossierPME(req);
  if (!demande) return res.redirect(`${BASE_PATH}/tableau-bord`);
  if (demande.statut !== "recommandee_acceptee" && demande.statut !== "recommandee_refusee") {
    return res.redirect(`${BASE_PATH}/tableau-bord`);
  }

  const { decision, commentaire } = req.body;
  const texte = (commentaire || "").trim();

  if (!texte || texte.length < 15) {
    return res.render("chef_pme_demande", {
      titre: `Demande ${demande.reference} — Espace ${NOM_ESPACE}`,
      demande,
      erreur: texte
        ? "La justification est trop courte (15 caractères minimum)."
        : "Une justification écrite est obligatoire pour la validation définitive.",
    });
  }

  enregistrerValidationChef(req.params.id, {
    decision, commentaire: texte, nomChef: req.session.nom_chef_pme,
  });

  res.redirect(`${BASE_PATH}/tableau-bord`);
});

module.exports = router;
