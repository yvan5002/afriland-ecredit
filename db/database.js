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

db.defaults({ demandes: [], brouillons: [], gestionnaires: [] }).write();

// Crée un premier gestionnaire par défaut au tout premier démarrage, pour ne pas
// casser l'accès si aucun gestionnaire n'a encore été créé depuis l'espace directeur d'agence.
if (db.get("gestionnaires").value().length === 0) {
  db.get("gestionnaires").push({
    id: 1,
    identifiant: "gestionnaire",
    mdp_hash: bcrypt.hashSync("afriland2026", 10),
    nom: "Gestionnaire Afriland",
    actif: true,
    date_creation: new Date().toISOString(),
  }).write();
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
function listerDemandesParStatut(statut) {
  return db.get("demandes")
    .filter({ statut })
    .sortBy("date_soumission")
    .reverse()
    .value();
}

function compterParStatut(statut) {
  return db.get("demandes").filter({ statut }).size().value();
}

function enregistrerDecision(id, { statut, commentaire, gestionnaireNom }) {
  return db.get("demandes")
    .find({ id: parseInt(id) })
    .assign({
      statut,
      commentaire_gestionnaire: commentaire,
      gestionnaire_nom: gestionnaireNom,
      date_traitement: new Date().toISOString(),
    })
    .write();
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
// demandes tous statuts confondus, plus quelques agrégats utiles
// pour le pilotage (volume traité, taux d'acceptation, montants).
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

  const parGestionnaire = {};
  toutes.forEach(d => {
    if (!d.gestionnaire_nom) return;
    if (!parGestionnaire[d.gestionnaire_nom]) parGestionnaire[d.gestionnaire_nom] = { gestionnaire_nom: d.gestionnaire_nom, acceptee: 0, refusee: 0 };
    if (d.statut === "acceptee") parGestionnaire[d.gestionnaire_nom].acceptee += 1;
    if (d.statut === "refusee") parGestionnaire[d.gestionnaire_nom].refusee += 1;
  });

  return {
    total, nouvelle, acceptee, refusee, traitees, tauxAcceptation,
    montantTotalDemande, montantAccorde,
    parGestionnaire: Object.values(parGestionnaire),
  };
}

// ------------------------------------------------------------
// Gestion des gestionnaires — créés et désactivés ("déconnectés") depuis
// l'espace directeur d'agence. Le mot de passe n'est jamais stocké en
// clair (bcrypt), et un gestionnaire désactivé est bloqué à sa toute
// prochaine requête, même s'il était déjà connecté.
// ------------------------------------------------------------
function genererIdGestionnaire() {
  const gestionnaires = db.get("gestionnaires").value();
  return gestionnaires.length ? Math.max(...gestionnaires.map(a => a.id)) + 1 : 1;
}

function listerGestionnaires() {
  return db.get("gestionnaires").sortBy("date_creation").value();
}

function creerGestionnaire({ identifiant, mdp, nom }) {
  const gestionnaire = {
    id: genererIdGestionnaire(),
    identifiant,
    mdp_hash: bcrypt.hashSync(mdp, 10),
    nom,
    actif: true,
    date_creation: new Date().toISOString(),
  };
  db.get("gestionnaires").push(gestionnaire).write();
  return gestionnaire;
}

function trouverGestionnaireParIdentifiant(identifiant) {
  return db.get("gestionnaires").find({ identifiant }).value();
}

function trouverGestionnaireParId(id) {
  return db.get("gestionnaires").find({ id: parseInt(id) }).value();
}

function definirActifGestionnaire(id, actif) {
  db.get("gestionnaires").find({ id: parseInt(id) }).assign({ actif }).write();
}

function verifierMdpGestionnaire(identifiant, mdp) {
  const gestionnaire = trouverGestionnaireParIdentifiant(identifiant);
  if (!gestionnaire || !gestionnaire.actif) return null;
  return bcrypt.compareSync(mdp, gestionnaire.mdp_hash) ? gestionnaire : null;
}

module.exports = {
  db, creerDemande, trouverParReference, trouverParId,
  listerDemandesParStatut, compterParStatut, enregistrerDecision,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
  listerToutesDemandes, statistiquesGlobales,
  listerGestionnaires, creerGestionnaire, trouverGestionnaireParIdentifiant, trouverGestionnaireParId,
  definirActifGestionnaire, verifierMdpGestionnaire,
};
