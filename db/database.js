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

db.defaults({ demandes: [] }).write();

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

module.exports = { db, creerDemande, trouverParReference };
