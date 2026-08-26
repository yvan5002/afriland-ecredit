// ============================================================
// Envoi d'email — deux méthodes possibles, choisies automatiquement
// selon les variables d'environnement présentes :
//
//   1) BREVO (recommandé) : API HTTP, pas de connexion SMTP directe,
//      donc pas bloquée par Gmail sur les IP des serveurs cloud
//      (Render, Railway, etc.). Variables : BREVO_API_KEY,
//      BREVO_SENDER_EMAIL (et BREVO_SENDER_NOM en option).
//
//   2) GMAIL SMTP (repli) : nécessite un mot de passe d'application
//      Gmail. Variables : EMAIL_USER, EMAIL_PASS.
//
// Si aucune des deux n'est configurée, on reste en mode test
// (le code s'affiche uniquement dans les logs).
// ============================================================
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const BREVO_ACTIF = !!process.env.BREVO_API_KEY && !!process.env.BREVO_SENDER_EMAIL;

const transporteurEmail = (!BREVO_ACTIF && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

function genererCodeOTP() {
  return String(crypto.randomInt(100000, 1000000)); // 6 chiffres
}

function gabaritEmailCode(prenom, code) {
  return `
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:auto;">
      <h2 style="color:#7C0A1E;">Afriland E-Crédit</h2>
      <p>Bonjour ${prenom},</p>
      <p>Voici votre code de vérification pour confirmer votre identité et continuer votre demande de crédit :</p>
      <p style="font-size:28px; font-weight:bold; letter-spacing:6px; color:#7C0A1E;">${code}</p>
      <p style="font-size:13px; color:#666;">Ce code est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    </div>`;
}

async function envoyerViaBrevo(destinataire, prenom, code) {
  const reponse = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NOM || "Afriland E-Crédit",
      },
      to: [{ email: destinataire, name: prenom || destinataire }],
      subject: "Votre code de vérification — Afriland E-Crédit",
      htmlContent: gabaritEmailCode(prenom, code),
    }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Brevo a refusé l'envoi (HTTP ${reponse.status}) : ${detail}`);
  }
}

async function envoyerCodeParEmail(destinataire, prenom, code) {
  if (BREVO_ACTIF) {
    await envoyerViaBrevo(destinataire, prenom, code);
    return;
  }
  if (transporteurEmail) {
    await transporteurEmail.sendMail({
      from: `"Afriland E-Crédit" <${process.env.EMAIL_USER}>`,
      to: destinataire,
      subject: "Votre code de vérification — Afriland E-Crédit",
      html: gabaritEmailCode(prenom, code),
    });
    return;
  }
  // Mode local / demo sans identifiants email configurés : le code est
  // simplement affiché dans la console pour permettre de tester le parcours.
  console.log(`>>> [MODE TEST — pas d'email configuré] Code pour ${destinataire} : ${code}`);
}

function masquerEmail(email) {
  const [u, d] = (email || "").split("@");
  if (!u || !d) return email;
  return u.slice(0, 2) + "***@" + d;
}

module.exports = { genererCodeOTP, envoyerCodeParEmail, masquerEmail };
