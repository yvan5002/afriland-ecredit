// ============================================================
// Fabrique d'espace de traitement (gestionnaire GFC, PME, corporate).
// Les 3 espaces ont la même fonction de base — recevoir les demandes
// de leur type, consulter les pièces, décider avec justification
// obligatoire — seuls le rôle, le type de demande traité et les
// libellés changent. Deux options permettent d'adapter le
// comportement sans dupliquer le code :
//
//   - assignationParAgent : le client choisit lui-même un agent
//     nommé (particulier, PME) — chaque agent ne voit alors que
//     les dossiers qui LUI ont été assignés, pas toute la file.
//
//   - deuxEtapes : la décision de l'agent n'est qu'une RECOMMANDATION
//     (statut "recommandee_acceptee"/"recommandee_refusee") — la
//     validation définitive revient à un rôle supérieur (le chef des
//     PME, voir routes/chef-pme.js), qui seul rend le dossier visible
//     comme "accepté"/"refusé" pour le client.
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  trouverParId, listerDemandesParStatut, compterParStatut,
  enregistrerDecision, enregistrerRecommandationAgent,
  verifierMdpCompte, trouverCompteParIdentifiant,
} = require("../db/database");

/**
 * @param {object} config
 * @param {string} config.role      rôle en base ("gestionnairegfc" | "pme" | "corporate")
 * @param {string} config.type      type de demande traité ("particulier" | "pme" | "corporate")
 * @param {string} config.basePath  préfixe des routes (ex: "/gestionnairegfc")
 * @param {string} config.nomEspace libellé affiché (ex: "Gestionnaire GFC", "PME", "Corporate")
 * @param {boolean} [config.assignationParAgent] filtre la file par agent connecté
 * @param {boolean} [config.deuxEtapes] la décision de l'agent devient une recommandation, pas un statut final
 */
function creerRouteurEspace({ role, type, basePath, nomEspace, assignationParAgent, deuxEtapes }) {
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
      basePath, nomEspace,
      erreur: "Identifiant ou mot de passe incorrect.",
    });
  });

  router.post("/deconnexion", (req, res) => {
    req.session[cleSession] = null;
    res.redirect(`${basePath}/connexion`);
  });

  function agentDuConnecte(req) {
    return assignationParAgent ? req.session[cleIdentifiant] : undefined;
  }

  router.get("/tableau-bord", exigerConnexion, (req, res) => {
    const agentAssigne = agentDuConnecte(req);
    const demandes = listerDemandesParStatut("nouvelle", type, agentAssigne);
    res.render("espace_tableau_bord", {
      titre: `Demandes à traiter — Espace ${nomEspace}`,
      basePath, nomEspace,
      nomConnecte: req.session[cleNom],
      demandes,
      compteurs: {
        nouvelle: compterParStatut("nouvelle", type, agentAssigne),
        acceptee: compterParStatut("acceptee", type, agentAssigne),
        refusee: compterParStatut("refusee", type, agentAssigne),
      },
      vue: "nouvelle",
    });
  });

  router.get("/historique", exigerConnexion, (req, res) => {
    const agentAssigne = agentDuConnecte(req);
    const acceptees = listerDemandesParStatut("acceptee", type, agentAssigne);
    const refusees = listerDemandesParStatut("refusee", type, agentAssigne);
    let demandes = [...acceptees, ...refusees];
    if (deuxEtapes) {
      // Les dossiers déjà recommandés mais pas encore validés par le chef
      // restent visibles dans l'historique de l'agent, pour suivi.
      const enAttente = [
        ...listerDemandesParStatut("recommandee_acceptee", type, agentAssigne),
        ...listerDemandesParStatut("recommandee_refusee", type, agentAssigne),
      ];
      demandes = [...enAttente, ...demandes];
    }
    demandes.sort((a, b) => new Date(b.date_traitement || b.recommandation_date) - new Date(a.date_traitement || a.recommandation_date));
    res.render("espace_tableau_bord", {
      titre: `Historique des décisions — Espace ${nomEspace}`,
      basePath, nomEspace,
      nomConnecte: req.session[cleNom],
      demandes,
      compteurs: {
        nouvelle: compterParStatut("nouvelle", type, agentAssigne),
        acceptee: compterParStatut("acceptee", type, agentAssigne),
        refusee: compterParStatut("refusee", type, agentAssigne),
      },
      vue: "historique",
    });
  });

  // La demande doit exister ET appartenir au bon type — empêche un
  // compte PME d'ouvrir une demande Corporate en devinant son id.
  // Si l'espace assigne par agent, la demande doit aussi LUI être assignée.
  function trouverDemandeDuBonType(req) {
    const demande = trouverParId(req.params.id);
    if (!demande || demande.type !== type) return null;
    if (assignationParAgent && demande.agent_assigne !== req.session[cleIdentifiant]) return null;
    return demande;
  }

  router.get("/demande/:id", exigerConnexion, (req, res) => {
    const demande = trouverDemandeDuBonType(req);
    if (!demande) return res.redirect(`${basePath}/tableau-bord`);
    res.render("espace_demande", {
      titre: `Demande ${demande.reference} — Espace ${nomEspace}`,
      basePath, nomEspace,
      demande, erreur: null,
    });
  });

  router.get("/documents/:id/:cle", exigerConnexion, (req, res) => {
    const demande = trouverDemandeDuBonType(req);
    const doc = demande && demande.documents && demande.documents[req.params.cle];
    if (!doc) return res.status(404).send("Document introuvable.");

    const chemin = path.join(__dirname, "..", "uploads", doc.chemin);
    if (!fs.existsSync(chemin)) {
      return res.status(404).send("Ce document n'est plus disponible sur le serveur (fichier expiré après un redémarrage).");
    }
    res.sendFile(chemin);
  });

  router.post("/demande/:id/decider", exigerConnexion, (req, res) => {
    const demande = trouverDemandeDuBonType(req);
    if (!demande) return res.redirect(`${basePath}/tableau-bord`);

    const { decision, commentaire } = req.body;
    const texte = (commentaire || "").trim();

    if (!texte || texte.length < 15) {
      return res.render("espace_demande", {
        titre: `Demande ${demande.reference} — Espace ${nomEspace}`,
        basePath, nomEspace, demande,
        erreur: texte
          ? "La justification est trop courte. Expliquez clairement le motif de votre décision (15 caractères minimum)."
          : "Une justification écrite est obligatoire, que vous acceptiez ou refusiez cette demande.",
      });
    }
    if (demande.statut !== "nouvelle") {
      return res.redirect(`${basePath}/tableau-bord`);
    }

    if (deuxEtapes) {
      // L'agent ne fait que RECOMMANDER — le dossier part ensuite chez le
      // chef des PME pour validation définitive (voir routes/chef-pme.js).
      enregistrerRecommandationAgent(req.params.id, {
        decision, commentaire: texte, nomAgent: req.session[cleNom],
      });
    } else {
      const statutFinal = decision === "accepter" ? "acceptee" : "refusee";
      enregistrerDecision(req.params.id, {
        statut: statutFinal, commentaire: texte, nomIntervenant: req.session[cleNom],
      });
    }

    res.redirect(`${basePath}/tableau-bord`);
  });

  return router;
}

module.exports = { creerRouteurEspace };
