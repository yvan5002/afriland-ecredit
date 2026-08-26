// ============================================================
// Base de données — Afriland E-Crédit (portail distant)
// Stockage en fichier JSON via lowdb : AUCUNE compilation native
// requise (contrairement à better-sqlite3/sqlite3), donc aucun
// risque d'échec d'installation sur Windows (pas besoin de
// Visual Studio Build Tools ni de Python).
// ============================================================
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const path = require("path");

const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "ecredit.json");
const adapter = new FileSync(DB_PATH);
const db = low(adapter);

db.defaults({ demandes: [], brouillons: [], comptes: [] }).write();

// Crée un premier compte par défaut pour chaque espace de traitement au tout
// premier démarrage, pour ne pas casser l'accès si le directeur d'agence n'a
// encore rien créé lui-même.
const COMPTES_PAR_DEFAUT = [
  // Gestionnaires "particulier" nommés — le client choisit lui-même l'un
  // d'eux au dépôt de ses documents ; chacun ne voit que ses propres
  // dossiers assignés (voir routes/espace-fabrique.js).
  { identifiant: "abomo", mdp: "abomo123", nom: "Mme Abomo", role: "gestionnairegfc" },
  { identifiant: "mabou", mdp: "mabou123", nom: "Mme Mabou", role: "gestionnairegfc" },
  { identifiant: "ngo", mdp: "ngo123", nom: "Mme Ngo", role: "gestionnairegfc" },
  { identifiant: "emile", mdp: "emile123", nom: "Mr Emile", role: "gestionnairegfc" },
  // Compte générique conservé pour la démo/tests (n'apparaît pas dans la
  // liste de choix du client, donc ne reçoit aucun dossier automatiquement).
  { identifiant: "gestionnairegfc", mdp: "afriland2026", nom: "Gestionnaire GFC Afriland", role: "gestionnairegfc" },

  // Agents PME nommés — le client en choisit un après avoir rempli les
  // informations de son entreprise.
  { identifiant: "eyoum", mdp: "eyoum123", nom: "Mme Eyoum", role: "pme" },
  { identifiant: "dim", mdp: "dim123", nom: "Mr Dim", role: "pme" },
  { identifiant: "pidjou", mdp: "pidjou123", nom: "Mr Pidjou", role: "pme" },
  { identifiant: "ibrahima", mdp: "ibrahima123", nom: "Mr Ibrahima", role: "pme" },
  { identifiant: "guypabdo", mdp: "guypabdo123", nom: "Mr Guy Pabdo", role: "pme" },
  { identifiant: "nnengue", mdp: "nnengue123", nom: "Mme Nnengue", role: "pme" },
  { identifiant: "nanfack", mdp: "nanfack123", nom: "Mr Nanfack", role: "pme" },
  { identifiant: "noudjeu", mdp: "noudjeu123", nom: "Mme Noudjeu", role: "pme" },

  // Chef des PME — valide définitivement les dossiers PME après la
  // recommandation d'un agent (double validation, voir routes/chef-pme.js).
  { identifiant: "schouala", mdp: "schouala123", nom: "Mr Serge Chouala", role: "chef_pme" },

  { identifiant: "corporate", mdp: "corporate2026", nom: "Gestionnaire Corporate Afriland", role: "corporate" },
];
if (db.get("comptes").value().length === 0) {
  COMPTES_PAR_DEFAUT.forEach((c, i) => {
    db.get("comptes").push({
      id: i + 1,
      identifiant: c.identifiant,
      mdp_hash: bcrypt.hashSync(c.mdp, 10),
      nom: c.nom,
      role: c.role,
      actif: true,
      date_creation: new Date().toISOString(),
    }).write();
  });
}

console.log(">>> Base de données Afriland E-Crédit prête :", DB_PATH);

function genererId() {
  const demandes = db.get("demandes").value();
  return demandes.length ? Math.max(...demandes.map(d => d.id)) + 1 : 1;
}

function creerDemande(donnees) {
  const demande = { id: genererId(), ...donnees };
  db.get("demandes").push(demande).write();
  return demande;
}

function trouverParReference(reference) {
  return db.get("demandes").find({ reference }).value();
}

function trouverParId(id) {
  return db.get("demandes").find({ id: parseInt(id) }).value();
}

// statut = "nouvelle" (par défaut) | "acceptee" | "refusee"
// type (optionnel) = "particulier" | "pme" | "corporate" — filtre par espace de traitement
// agentAssigne (optionnel) = identifiant d'un compte — ne renvoie que les
// dossiers qui lui ont été explicitement assignés (choix fait par le client)
function listerDemandesParStatut(statut, type, agentAssigne) {
  const critere = { statut };
  if (type) critere.type = type;
  if (agentAssigne) critere.agent_assigne = agentAssigne;
  return db.get("demandes")
    .filter(critere)
    .sortBy("date_soumission")
    .reverse()
    .value();
}

function compterParStatut(statut, type, agentAssigne) {
  const critere = { statut };
  if (type) critere.type = type;
  if (agentAssigne) critere.agent_assigne = agentAssigne;
  return db.get("demandes").filter(critere).size().value();
}

function enregistrerDecision(id, { statut, commentaire, nomIntervenant }) {
  return db.get("demandes")
    .find({ id: parseInt(id) })
    .assign({
      statut,
      commentaire_decision: commentaire,
      traite_par_nom: nomIntervenant,
      date_traitement: new Date().toISOString(),
    })
    .write();
}

// ------------------------------------------------------------
// Validation PME à DEUX niveaux : un agent PME nommé donne d'abord
// une recommandation, puis le chef des PME valide définitivement
// (ou non) avant que le client ne voie un statut final.
// ------------------------------------------------------------
function enregistrerRecommandationAgent(id, { decision, commentaire, nomAgent }) {
  return db.get("demandes")
    .find({ id: parseInt(id) })
    .assign({
      statut: decision === "accepter" ? "recommandee_acceptee" : "recommandee_refusee",
      recommandation_decision: decision,
      recommandation_commentaire: commentaire,
      recommandation_agent_nom: nomAgent,
      recommandation_date: new Date().toISOString(),
    })
    .write();
}

function enregistrerValidationChef(id, { decision, commentaire, nomChef }) {
  return db.get("demandes")
    .find({ id: parseInt(id) })
    .assign({
      statut: decision === "accepter" ? "acceptee" : "refusee",
      commentaire_decision: commentaire,
      traite_par_nom: nomChef,
      date_traitement: new Date().toISOString(),
    })
    .write();
}

function listerDemandesEnAttenteChef() {
  return db.get("demandes")
    .filter(d => d.statut === "recommandee_acceptee" || d.statut === "recommandee_refusee")
    .sortBy("recommandation_date")
    .reverse()
    .value();
}

function listerDemandesTraiteesParChef() {
  return db.get("demandes")
    .filter(d => (d.statut === "acceptee" || d.statut === "refusee") && d.type === "pme" && d.traite_par_nom)
    .sortBy("date_traitement")
    .reverse()
    .value();
}

// ------------------------------------------------------------
// Brouillons — permet à un client de reprendre une demande
// commencée, même après avoir fermé son navigateur ou après un
// redémarrage du serveur (contrairement à la session seule).
// ------------------------------------------------------------
function sauvegarderBrouillon(id, donnees) {
  const existant = db.get("brouillons").find({ id }).value();
  const enregistrement = {
    id, donnees, termine: false,
    date_maj: new Date().toISOString(),
    date_creation: existant ? existant.date_creation : new Date().toISOString(),
  };
  if (existant) {
    db.get("brouillons").find({ id }).assign(enregistrement).write();
  } else {
    db.get("brouillons").push(enregistrement).write();
  }
}

function trouverBrouillon(id) {
  if (!id) return null;
  return db.get("brouillons").find({ id }).value();
}

function supprimerBrouillon(id) {
  if (!id) return;
  db.get("brouillons").remove({ id }).write();
}

// ------------------------------------------------------------
// Vue d'ensemble — réservée à l'espace directeur d'agence : toutes les
// demandes tous statuts (et tous types) confondus, plus quelques agrégats
// utiles pour le pilotage (volume traité, taux d'acceptation, montants).
// ------------------------------------------------------------
function listerToutesDemandes() {
  return db.get("demandes").sortBy("date_soumission").reverse().value();
}

function statistiquesGlobales() {
  const toutes = db.get("demandes").value();
  const total = toutes.length;
  const nouvelle = toutes.filter(d => d.statut === "nouvelle").length;
  const acceptee = toutes.filter(d => d.statut === "acceptee").length;
  const refusee = toutes.filter(d => d.statut === "refusee").length;
  const traitees = acceptee + refusee;
  const tauxAcceptation = traitees ? Math.round((acceptee / traitees) * 100) : 0;
  const montantTotalDemande = toutes.reduce((s, d) => s + (Number(d.montant) || 0), 0);
  const montantAccorde = toutes
    .filter(d => d.statut === "acceptee")
    .reduce((s, d) => s + (Number(d.montant) || 0), 0);

  const parIntervenant = {};
  toutes.forEach(d => {
    if (!d.traite_par_nom) return;
    if (!parIntervenant[d.traite_par_nom]) parIntervenant[d.traite_par_nom] = { traite_par_nom: d.traite_par_nom, acceptee: 0, refusee: 0 };
    if (d.statut === "acceptee") parIntervenant[d.traite_par_nom].acceptee += 1;
    if (d.statut === "refusee") parIntervenant[d.traite_par_nom].refusee += 1;
  });

  const parType = {
    particulier: toutes.filter(d => d.type === "particulier").length,
    pme: toutes.filter(d => d.type === "pme").length,
    corporate: toutes.filter(d => d.type === "corporate").length,
  };

  return {
    total, nouvelle, acceptee, refusee, traitees, tauxAcceptation,
    montantTotalDemande, montantAccorde,
    parGestionnaire: Object.values(parIntervenant),
    parType,
  };
}

// ------------------------------------------------------------
// Gestion des comptes (gestionnaire GFC, PME, corporate) — créés et
// désactivés ("déconnectés") depuis l'espace directeur d'agence. Le mot
// de passe n'est jamais stocké en clair (bcrypt), et un compte désactivé
// est bloqué dès sa prochaine requête, même s'il était déjà connecté.
// ------------------------------------------------------------
function genererIdCompte() {
  const comptes = db.get("comptes").value();
  return comptes.length ? Math.max(...comptes.map(c => c.id)) + 1 : 1;
}

function listerComptes() {
  return db.get("comptes").sortBy("date_creation").value();
}

function listerComptesParRole(role) {
  return db.get("comptes").filter({ role }).sortBy("date_creation").value();
}

function creerCompte({ identifiant, mdp, nom, role }) {
  const compte = {
    id: genererIdCompte(),
    identifiant,
    mdp_hash: bcrypt.hashSync(mdp, 10),
    nom,
    role,
    actif: true,
    date_creation: new Date().toISOString(),
  };
  db.get("comptes").push(compte).write();
  return compte;
}

function trouverCompteParIdentifiant(identifiant) {
  return db.get("comptes").find({ identifiant }).value();
}

function trouverCompteParId(id) {
  return db.get("comptes").find({ id: parseInt(id) }).value();
}

function definirActifCompte(id, actif) {
  db.get("comptes").find({ id: parseInt(id) }).assign({ actif }).write();
}

// roleAttendu : si fourni, le compte doit avoir exactement ce rôle pour être validé
// (empêche un identifiant PME de se connecter sur l'espace Corporate, par exemple).
function verifierMdpCompte(identifiant, mdp, roleAttendu) {
  const compte = trouverCompteParIdentifiant(identifiant);
  if (!compte || !compte.actif) return null;
  if (roleAttendu && compte.role !== roleAttendu) return null;
  return bcrypt.compareSync(mdp, compte.mdp_hash) ? compte : null;
}

module.exports = {
  db, creerDemande, trouverParReference, trouverParId,
  listerDemandesParStatut, compterParStatut, enregistrerDecision,
  enregistrerRecommandationAgent, enregistrerValidationChef,
  listerDemandesEnAttenteChef, listerDemandesTraiteesParChef,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
  listerToutesDemandes, statistiquesGlobales,
  listerComptes, listerComptesParRole, creerCompte,
  trouverCompteParIdentifiant, trouverCompteParId,
  definirActifCompte, verifierMdpCompte,
};
