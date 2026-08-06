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

const DB_PATH = path.join(__dirname, "ecredit.json");
const adapter = new FileSync(DB_PATH);
const db = low(adapter);

db.defaults({ demandes: [], brouillons: [] }).write();

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

function enregistrerDecision(id, { statut, commentaire, agentNom }) {
  return db.get("demandes")
    .find({ id: parseInt(id) })
    .assign({
      statut,
      commentaire_agent: commentaire,
      agent_nom: agentNom,
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

module.exports = {
  db, creerDemande, trouverParReference, trouverParId,
  listerDemandesParStatut, compterParStatut, enregistrerDecision,
  sauvegarderBrouillon, trouverBrouillon, supprimerBrouillon,
};
