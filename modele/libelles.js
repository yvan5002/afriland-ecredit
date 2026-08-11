// ============================================================
// Libellés lisibles pour les valeurs catégorielles du modèle de
// risque. Les "valeur" ci-dessous doivent rester identiques aux
// catégories connues par le modèle (modele_risque.json) — seul
// le "libelle" affiché au client peut être adapté.
// ============================================================

const LIBELLES = {
  statut_compte_courant: {
    "< 0 DM": "Compte à découvert",
    "0-200 DM": "Solde faible sur le compte courant",
    ">= 200 DM": "Solde confortable sur le compte courant",
    "pas de compte": "Pas de compte courant chez nous",
  },
  historique_credit: {
    "aucun credit pris": "Aucun crédit pris jusqu'ici",
    "credits payes (autre banque)": "Crédits déjà remboursés (autre banque)",
    "credits en cours payes normalement": "Crédit(s) en cours, remboursés normalement",
    "retard de paiement passe": "A eu un retard de paiement par le passé",
    "compte critique / autres credits existants": "Situation de crédit délicate / autres crédits en cours",
  },
  objet_credit: {
    autres: "Autres",
    business: "Activité professionnelle / business",
    education: "Éducation",
    electromenager: "Électroménager",
    formation: "Formation professionnelle",
    "mobilier/equipement": "Mobilier / équipement",
    "radio/television": "Radio / télévision",
    reparations: "Réparations",
    "voiture neuve": "Achat véhicule neuf",
    "voiture occasion": "Achat véhicule d'occasion",
  },
  epargne: {
    "< 100 DM": "Épargne faible",
    "100-500 DM": "Épargne modérée",
    "500-1000 DM": "Épargne correcte",
    ">= 1000 DM": "Épargne importante",
    "inconnu/aucune epargne": "Pas d'épargne / non communiqué",
  },
  anciennete_emploi: {
    "sans emploi": "Sans emploi",
    "< 1 an": "Moins d'1 an dans l'emploi actuel",
    "1-4 ans": "1 à 4 ans dans l'emploi actuel",
    "4-7 ans": "4 à 7 ans dans l'emploi actuel",
    ">= 7 ans": "7 ans ou plus dans l'emploi actuel",
  },
  situation_personnelle_sexe: {
    "femme div/sep/mariee": "Femme divorcée / séparée / mariée",
    "homme celibataire": "Homme célibataire",
    "homme divorce/separe": "Homme divorcé / séparé",
    "homme marie/veuf": "Homme marié / veuf",
  },
  autres_debiteurs_garants: {
    aucun: "Aucun",
    "co-demandeur": "Co-demandeur associé au dossier",
    garant: "Garant tiers",
  },
  patrimoine: {
    "epargne/assurance-vie": "Épargne / assurance-vie",
    immobilier: "Bien immobilier",
    "inconnu/aucun patrimoine": "Aucun patrimoine déclaré",
    "voiture/autre": "Véhicule ou autre bien",
  },
  autres_plans_credit: {
    aucun: "Aucun autre crédit en cours ailleurs",
    banque: "Crédit en cours dans une autre banque",
    magasins: "Crédit à la consommation (magasin)",
  },
  logement: {
    locataire: "Locataire",
    "loge gratuitement": "Logé(e) gratuitement",
    proprietaire: "Propriétaire",
  },
  profession: {
    "cadre/independant/hautement qualifie": "Cadre / indépendant / hautement qualifié",
    "employe qualifie": "Employé qualifié",
    "non-qualifie resident": "Non qualifié (résident)",
    "sans emploi/non-qualifie": "Sans emploi / non qualifié",
  },
};

/**
 * Construit, pour un ensemble de champs catégoriels, la liste
 * { valeur, libelle }[] triée par libellé, prête pour un <select>.
 */
function construireCategories(donneesModele) {
  const resultat = {};
  donneesModele.colonnes_categorielles.forEach(col => {
    const valeurs = donneesModele.categories[col] || [];
    const libellesCol = LIBELLES[col] || {};
    resultat[col] = valeurs
      .map(v => ({ valeur: v, libelle: libellesCol[v] || v }))
      .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
  });
  return resultat;
}

module.exports = { LIBELLES, construireCategories };
