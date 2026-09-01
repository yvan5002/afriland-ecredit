// ============================================================
// Fabrique d'espace "chef" (chef GFC, chef des PME, chef Corporate).
// Chaque chef :
//   - reçoit les dossiers déjà recommandés par un agent de SON domaine
//     et rend la décision réellement définitive (le client ne voit
//     "accepté"/"refusé" qu'à ce moment-là) ;
//   - gère (crée, désactive, réactive, supprime) les comptes agents de
//     son domaine uniquement — il n'y a plus de directeur d'agence
//     centralisé, chaque chef est autonome sur sa propre équipe.
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  trouverParId, listerDemandesEnAttenteChef, listerDemandesTraiteesParChef,
  enregistrerValidationChef, verifierMdpCompte, trouverCompteParIdentifiant,
  listerComptesParRole, creerCompte, trouverCompteParId, definirActifCompte, supprimerCompte,
} = require("../db/database");

/**
 * @param {object} config
 * @param {string} config.role       rôle en base du chef ("chef_gfc" | "chef_pme" | "chef_corporate")
 * @param {string} config.type       type de demande traité ("particulier" | "pme" | "corporate")
 * @param {string} config.roleAgent  rôle des agents que ce chef supervise ("gestionnairegfc" | "pme" | "corporate")
 * @param {string} config.basePath   préfixe des routes (ex: "/chef-pme")
 * @param {string} config.nomEspace  libellé affiché (ex: "Chef des PME")
 */
function creerRouteurChef({ role, type, roleAgent, basePath, nomEspace }) {
  const router = express.Router();
  const cleSession = `connecte_${role}`;
  const cleIdentifiant = `identifiant_${role}`;
  const cleNom = `nom_${role}`;

  function exigerConnexion(req, res, next) {
    if (!req.session[cleSession]) return res.redirect(`${basePath}/connexion`);
    const compte = trouverCompteParIdentifiant(req.session[cleIdentifiant]);
    if (!compte || !compte.actif || compte.role !== role) {
      req.session[cleSession] = null;
      return res.redirect(`${basePath}/connexion?deconnecte=1`);
    }
    next();
  }

  router.get("/connexion", (req, res) => {
    if (req.session[cleSession]) return res.redirect(`${basePath}/tableau-bord`);
    res.render("espace_connexion", {
      titre: `Espace ${nomEspace} — Afriland E-Crédit`,
      basePath, nomEspace,
      erreur: req.query.deconnecte ? "Votre accès a été désactivé." : null,
    });
  });

  router.post("/connexion", (req, res) => {
    const { identifiant, mdp } = req.body;
    const compte = verifierMdpCompte(identifiant, mdp, role);
    if (compte) {
      req.session[cleSession] = true;
      req.session[cleIdentifiant] = compte.identifiant;
      req.session[cleNom] = compte.nom;
      return res.redirect(`${basePath}/tableau-bord`);
    }
    res.render("espace_connexion", {
      titre: `Espace ${nomEspace} — Afriland E-Crédit`,
      basePath, nomEspace, erreur: "Identifiant ou mot de passe incorrect.",
    });
  });

  router.post("/deconnexion", (req, res) => {
    req.session[cleSession] = null;
    res.redirect(`${basePath}/connexion`);
  });

  router.get("/tableau-bord", exigerConnexion, (req, res) => {
    const enAttente = listerDemandesEnAttenteChef(type);
    const traitees = listerDemandesTraiteesParChef(type);
    res.render("chef_tableau_bord", {
      titre: `Dossiers à valider — Espace ${nomEspace}`,
      basePath, nomEspace, nomConnecte: req.session[cleNom],
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
    const traitees = listerDemandesTraiteesParChef(type);
    const enAttente = listerDemandesEnAttenteChef(type);
    res.render("chef_tableau_bord", {
      titre: `Historique — Espace ${nomEspace}`,
      basePath, nomEspace, nomConnecte: req.session[cleNom],
      demandes: traitees,
      compteurs: {
        enAttente: enAttente.length,
        acceptee: traitees.filter(d => d.statut === "acceptee").length,
        refusee: traitees.filter(d => d.statut === "refusee").length,
      },
      vue: "historique",
    });
  });

  function trouverDossierDuBonType(req) {
    const demande = trouverParId(req.params.id);
    if (!demande || demande.type !== type) return null;
    return demande;
  }

  router.get("/demande/:id", exigerConnexion, (req, res) => {
    const demande = trouverDossierDuBonType(req);
    if (!demande) return res.redirect(`${basePath}/tableau-bord`);
    res.render("chef_demande", {
      titre: `Demande ${demande.reference} — Espace ${nomEspace}`,
      basePath, nomEspace, demande, erreur: null,
    });
  });

  router.get("/documents/:id/:cle", exigerConnexion, (req, res) => {
    const demande = trouverDossierDuBonType(req);
    const doc = demande && demande.documents && demande.documents[req.params.cle];
    if (!doc) return res.status(404).send("Document introuvable.");
    const chemin = path.join(__dirname, "..", "uploads", doc.chemin);
    if (!fs.existsSync(chemin)) {
      return res.status(404).send("Ce document n'est plus disponible sur le serveur (fichier expiré après un redémarrage).");
    }
    res.sendFile(chemin);
  });

  router.post("/demande/:id/valider", exigerConnexion, (req, res) => {
    const demande = trouverDossierDuBonType(req);
    if (!demande) return res.redirect(`${basePath}/tableau-bord`);
    if (demande.statut !== "recommandee_acceptee" && demande.statut !== "recommandee_refusee") {
      return res.redirect(`${basePath}/tableau-bord`);
    }

    const { decision, commentaire } = req.body;
    const texte = (commentaire || "").trim();
    if (!texte || texte.length < 15) {
      return res.render("chef_demande", {
        titre: `Demande ${demande.reference} — Espace ${nomEspace}`,
        basePath, nomEspace, demande,
        erreur: texte
          ? "La justification est trop courte (15 caractères minimum)."
          : "Une justification écrite est obligatoire pour la validation définitive.",
      });
    }

    enregistrerValidationChef(req.params.id, { decision, commentaire: texte, nomChef: req.session[cleNom] });
    res.redirect(`${basePath}/tableau-bord`);
  });

  // ============================================================
  // GESTION DES AGENTS DE SON PROPRE DOMAINE (créer / désactiver /
  // réactiver / supprimer) — remplace l'ancien espace directeur
  // centralisé : chaque chef gère uniquement sa propre équipe.
  // ============================================================
  router.get("/agents", exigerConnexion, (req, res) => {
    res.render("chef_agents", {
      titre: `Mes agents — Espace ${nomEspace}`,
      basePath, nomEspace,
      agents: listerComptesParRole(roleAgent), erreur: null, succes: null,
    });
  });

  router.post("/agents", exigerConnexion, (req, res) => {
    const { identifiant, mdp, nom } = req.body;
    const rendre = (erreur, succes) => res.render("chef_agents", {
      titre: `Mes agents — Espace ${nomEspace}`,
      basePath, nomEspace, agents: listerComptesParRole(roleAgent), erreur, succes,
    });

    const idPropre = (identifiant || "").trim();
    const nomPropre = (nom || "").trim();
    if (!idPropre || !mdp || !nomPropre) {
      return rendre("Merci de compléter l'identifiant, le mot de passe et le nom complet.", null);
    }
    if (mdp.length < 6) {
      return rendre("Le mot de passe doit contenir au moins 6 caractères.", null);
    }
    if (trouverCompteParIdentifiant(idPropre)) {
      return rendre("Cet identifiant est déjà utilisé par un autre compte.", null);
    }

    creerCompte({ identifiant: idPropre, mdp, nom: nomPropre, role: roleAgent });
    rendre(null, `L'agent « ${nomPropre} » (${idPropre}) a bien été créé.`);
  });

  router.post("/agents/:id/desactiver", exigerConnexion, (req, res) => {
    const compte = trouverCompteParId(req.params.id);
    if (compte && compte.role === roleAgent) definirActifCompte(compte.id, false);
    res.redirect(`${basePath}/agents`);
  });

  router.post("/agents/:id/reactiver", exigerConnexion, (req, res) => {
    const compte = trouverCompteParId(req.params.id);
    if (compte && compte.role === roleAgent) definirActifCompte(compte.id, true);
    res.redirect(`${basePath}/agents`);
  });

  router.post("/agents/:id/supprimer", exigerConnexion, (req, res) => {
    const compte = trouverCompteParId(req.params.id);
    if (compte && compte.role === roleAgent) supprimerCompte(compte.id);
    res.redirect(`${basePath}/agents`);
  });

  return router;
}

module.exports = { creerRouteurChef };
