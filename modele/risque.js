// ============================================================
// MODÈLE DE RISQUE DE CRÉDIT — portage JavaScript
// ------------------------------------------------------------
// Ce module réimplémente, en JS pur, le calcul exact d'un modèle
// scikit-learn (régression logistique) entraîné à l'origine dans
// la version Python/Flask du projet (dossier modele/ du script
// 02_entrainer_modele.py), sur le jeu de données "German Credit
// Data" (Statlog), avec noms de colonnes traduits en français.
//
// Comme une régression logistique n'est, une fois entraînée,
// qu'une formule mathématique (standardisation + encodage one-hot
// + combinaison linéaire + sigmoïde), elle peut être recalculée
// fidèlement sans avoir besoin de Python ni de scikit-learn en
// production — d'où ce portage, qui tourne nativement dans
// l'application Node.js.
//
// Les coefficients, moyennes/écarts-types de standardisation et
// catégories exactes ont été extraits du fichier
// modele_risque_credit.pkl d'origine (voir modele_risque.json).
//
// IMPORTANT — conversion FCFA : le modèle a été entraîné sur des
// montants en Deutsche Mark (moyenne ~3189, écart-type ~2671).
// Comme dans la version Flask d'origine, on applique le même
// facteur de conversion approximatif : 1 "unité modèle" = 200 FCFA.
// ============================================================

const donnees = require("./modele_risque.json");

const CONVERSION_FCFA_VERS_DM = 200;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Construit, dans le même ordre que scikit-learn (ColumnTransformer
// "num" puis "cat", catégories dans l'ordre alphabétique de
// categories_), la liste des noms de variables encodées, associée
// à leur coefficient.
const NOMS_FEATURES = [];
donnees.colonnes_numeriques.forEach(col => NOMS_FEATURES.push({ type: "num", col }));
donnees.colonnes_categorielles.forEach(col => {
  (donnees.categories[col] || []).forEach(val => {
    NOMS_FEATURES.push({ type: "cat", col, val });
  });
});

/**
 * Calcule le pourcentage de risque de défaut de paiement d'un profil,
 * ainsi que les 4 facteurs qui pèsent le plus dans le calcul.
 *
 * @param {object} profil - doit contenir toutes les clés listées dans
 *   donnees.colonnes_numeriques (valeurs numériques) et
 *   donnees.colonnes_categorielles (valeurs texte, exactement parmi
 *   les catégories connues — une valeur inconnue est simplement
 *   ignorée par l'encodage, comme le fait handle_unknown="ignore").
 * @returns {{ pourcentage: number, facteurs: {nom: string, poids: number}[] }}
 */
function evaluerRisque(profil) {
  const contributions = [];

  NOMS_FEATURES.forEach((f, i) => {
    const coef = donnees.coef[i];
    let valeurEncodee = 0;
    let nomLisible;

    if (f.type === "num") {
      let brut = Number(profil[f.col]) || 0;
      if (f.col === "montant_credit") brut = brut / CONVERSION_FCFA_VERS_DM;
      const idxNum = donnees.colonnes_numeriques.indexOf(f.col);
      const moyenne = donnees.scaler_mean[idxNum];
      const ecartType = donnees.scaler_scale[idxNum];
      valeurEncodee = (brut - moyenne) / ecartType;
      nomLisible = f.col.replace(/_/g, " ");
    } else {
      valeurEncodee = profil[f.col] === f.val ? 1 : 0;
      nomLisible = `${f.col.replace(/_/g, " ")} : ${f.val}`;
    }

    const poids = valeurEncodee * coef;
    if (valeurEncodee !== 0) {
      contributions.push({ nom: nomLisible, poids });
    }
  });

  const sommeLineaire =
    donnees.intercept +
    NOMS_FEATURES.reduce((somme, f, i) => {
      const coef = donnees.coef[i];
      if (f.type === "num") {
        let brut = Number(profil[f.col]) || 0;
        if (f.col === "montant_credit") brut = brut / CONVERSION_FCFA_VERS_DM;
        const idxNum = donnees.colonnes_numeriques.indexOf(f.col);
        const z = (brut - donnees.scaler_mean[idxNum]) / donnees.scaler_scale[idxNum];
        return somme + z * coef;
      }
      const actif = profil[f.col] === f.val ? 1 : 0;
      return somme + actif * coef;
    }, 0);

  const proba = sigmoid(sommeLineaire);
  const pourcentage = Math.round(proba * 100);

  // Même logique que la version Flask : on garde les 8 facteurs les
  // plus influents (en valeur absolue), puis parmi eux les 4 qui
  // poussent le plus le risque à la hausse.
  contributions.sort((a, b) => Math.abs(b.poids) - Math.abs(a.poids));
  const top8 = contributions.slice(0, 8);
  top8.sort((a, b) => b.poids - a.poids);
  const facteurs = top8.slice(0, 4);

  return { pourcentage, facteurs };
}

module.exports = { evaluerRisque, NOMS_FEATURES, donnees };

// ============================================================
// SCORE DE RISQUE — PME (heuristique simplifiée)
// ------------------------------------------------------------
// Contrairement au modèle "particulier" ci-dessus (portage fidèle
// d'un modèle scikit-learn réellement entraîné), aucune donnée
// d'entraînement n'existe pour les dossiers PME : ceci est donc une
// heuristique indicative simple, basée sur le ratio entre le montant
// demandé et la surface financière déclarée par l'entreprise
// (chiffre d'affaires, à défaut total du bilan). À affiner/remplacer
// dès qu'un vrai modèle PME sera disponible.
// ============================================================
function nombreOuNull(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function evaluerRisquePME({ montant, chiffre_affaires, total_bilan, capital }) {
  const m = nombreOuNull(montant);
  const surface = nombreOuNull(chiffre_affaires) || nombreOuNull(total_bilan) || nombreOuNull(capital);

  const facteurs = [];

  if (!m || !surface) {
    // Trop d'informations manquantes pour un ratio fiable — score neutre.
    facteurs.push({ nom: "Informations financières incomplètes", poids: 0 });
    return { pourcentage: 50, facteurs };
  }

  const ratio = m / surface;
  // Barème indicatif : plus le montant demandé est élevé par rapport à la
  // surface financière déclarée, plus le risque estimé augmente.
  let pourcentage;
  if (ratio <= 0.1) pourcentage = 10;
  else if (ratio <= 0.25) pourcentage = 20;
  else if (ratio <= 0.5) pourcentage = 35;
  else if (ratio <= 1) pourcentage = 55;
  else if (ratio <= 2) pourcentage = 75;
  else pourcentage = 90;

  facteurs.push({
    nom: `Montant demandé / surface financière déclarée (ratio ${ratio.toFixed(2)})`,
    poids: ratio,
  });
  if (!nombreOuNull(chiffre_affaires) && nombreOuNull(total_bilan)) {
    facteurs.push({ nom: "Chiffre d'affaires non renseigné — estimation basée sur le total du bilan", poids: 0 });
  }

  return { pourcentage, facteurs };
}

module.exports.evaluerRisquePME = evaluerRisquePME;
