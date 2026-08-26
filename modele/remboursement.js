// ============================================================
// CALCUL DE REMBOURSEMENT — mensualité et pourcentage total du
// crédit, adaptés au montant emprunté et à la durée choisie.
//
// Barème indicatif (à ajuster librement selon la politique tarifaire
// réelle d'Afriland First Bank) : taux annuel dégressif selon la
// durée — plus le remboursement s'étale, plus le taux annuel est
// légèrement réduit, ce qui est une pratique bancaire courante.
// ============================================================
function tauxAnnuelIndicatif(dureeMois) {
  if (dureeMois <= 6) return 0.14;   // 14%/an sur courte durée
  if (dureeMois <= 12) return 0.13;  // 13%/an
  if (dureeMois <= 24) return 0.12;  // 12%/an
  if (dureeMois <= 36) return 0.11;  // 11%/an
  return 0.10;                       // 10%/an au-delà de 3 ans
}

/**
 * @param montant  montant emprunté (FCFA)
 * @param dureeMois durée de remboursement (mois)
 * @returns { tauxAnnuel, mensualite, coutTotalCredit, montantTotalRembourse, pourcentageCout }
 */
function calculerRemboursement(montant, dureeMois) {
  const m = Number(montant) || 0;
  const d = Math.max(1, parseInt(dureeMois) || 1);
  const tauxAnnuel = tauxAnnuelIndicatif(d);
  const tauxMensuel = tauxAnnuel / 12;

  const mensualite = tauxMensuel === 0
    ? m / d
    : (m * tauxMensuel) / (1 - Math.pow(1 + tauxMensuel, -d));

  const montantTotalRembourse = mensualite * d;
  const coutTotalCredit = montantTotalRembourse - m;
  const pourcentageCout = m > 0 ? (coutTotalCredit / m) * 100 : 0;

  return {
    tauxAnnuel: Math.round(tauxAnnuel * 1000) / 10, // en %, ex: 12.0
    mensualite: Math.round(mensualite),
    coutTotalCredit: Math.round(coutTotalCredit),
    montantTotalRembourse: Math.round(montantTotalRembourse),
    pourcentageCout: Math.round(pourcentageCout * 10) / 10,
  };
}

module.exports = { calculerRemboursement };
