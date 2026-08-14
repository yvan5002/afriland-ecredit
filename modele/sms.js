// ============================================================
// Vérification par SMS — via l'API Twilio Verify.
// ------------------------------------------------------------
// Contrairement à l'email (où on génère et vérifie nous-mêmes le
// code), Twilio Verify gère tout de son côté : on lui demande
// d'envoyer un code à un numéro, puis on lui demande de vérifier
// le code saisi par le client. On n'a donc jamais besoin de
// stocker le code nous-mêmes pour la vérification par SMS.
//
// Variables d'environnement nécessaires :
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_VERIFY_SERVICE_SID
// Si elles ne sont pas configurées, la vérification par SMS est
// simplement indisponible (le client garde l'email comme méthode).
// ============================================================

const SMS_ACTIF = !!process.env.TWILIO_ACCOUNT_SID
  && !!process.env.TWILIO_AUTH_TOKEN
  && !!process.env.TWILIO_VERIFY_SERVICE_SID;

function authHeader() {
  const identifiants = `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`;
  return "Basic " + Buffer.from(identifiants).toString("base64");
}

function normaliserNumeroCameroun(numero) {
  const chiffres = (numero || "").replace(/\D/g, "");
  // Accepte "6XXXXXXXX" (9 chiffres) ou déjà au format international.
  if (/^6\d{8}$/.test(chiffres)) return "+237" + chiffres;
  if (/^2376\d{8}$/.test(chiffres)) return "+" + chiffres;
  if (numero && numero.startsWith("+")) return numero;
  return null;
}

async function envoyerCodeParSMS(numero) {
  if (!SMS_ACTIF) throw new Error("La vérification par SMS n'est pas configurée sur ce serveur.");
  const numeroInternational = normaliserNumeroCameroun(numero);
  if (!numeroInternational) throw new Error("Numéro de téléphone invalide.");

  const url = `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
  const reponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: numeroInternational, Channel: "sms" }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Twilio a refusé l'envoi (HTTP ${reponse.status}) : ${detail}`);
  }
  return numeroInternational;
}

async function verifierCodeSMS(numeroInternational, code) {
  if (!SMS_ACTIF) return false;
  const url = `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
  const reponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: numeroInternational, Code: code }),
  });
  if (!reponse.ok) return false;
  const data = await reponse.json();
  return data.status === "approved";
}

module.exports = { SMS_ACTIF, envoyerCodeParSMS, verifierCodeSMS, normaliserNumeroCameroun };
