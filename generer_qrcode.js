// Génère le QR code pointant vers le portail Afriland E-Crédit.
// Usage : node generer_qrcode.js https://ton-url-de-deploiement.onrender.com
const QRCode = require("qrcode");
const path = require("path");

const url = process.argv[2] || "https://afriland-ecredit.exemple.com";

QRCode.toFile(
  path.join(__dirname, "public", "img", "qrcode.png"),
  url,
  { width: 500, margin: 2, color: { dark: "#7C0A1E", light: "#FFFFFF" } },
  (err) => {
    if (err) return console.error("Erreur génération QR code :", err);
    console.log(`>>> QR code généré pour : ${url}`);
    console.log(`>>> Fichier : public/img/qrcode.png`);
  }
);
