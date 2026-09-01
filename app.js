// ============================================================
// AFRILAND E-CRÉDIT — Portail de demande de crédit à distance
// Serveur Express (Node.js)
// ============================================================
const express = require("express");
const path = require("path");
const session = require("express-session");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  if (!req.cookies) req.cookies = {}; // filet de sécurité si cookie-parser ne s'exécute pas comme attendu
  next();
});
app.use(express.static(path.join(__dirname, "public")));
// Les documents clients ne sont plus servis publiquement : voir la route
// sécurisée /<espace>/documents/:id/:cle (réservée aux comptes connectés).

app.use(session({
  secret: process.env.SESSION_SECRET || "cle_secrete_afriland_ecredit_2026",
  resave: false,
  saveUninitialized: false,
  rolling: true, // prolonge la session tant que le client est actif
  cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 24h — la reprise réelle passe par le brouillon persistant, pas la session
}));

// Routes
app.use("/gestionnairegfc", require("./routes/gestionnairegfc"));
app.use("/pme", require("./routes/pme"));
app.use("/corporate", require("./routes/corporate"));
app.use("/chef-gfc", require("./routes/chef-gfc"));
app.use("/chef-pme", require("./routes/chef-pme"));
app.use("/chef-corporate", require("./routes/chef-corporate"));
app.use("/demande-entreprise", require("./routes/entreprise"));
app.use("/connexion", require("./routes/connexion"));
app.use("/", require("./routes/portail"));

app.use((req, res) => {
  res.status(404).render("404", { titre: "Page introuvable" });
});

app.listen(PORT, () => {
  console.log(`>>> Afriland E-Crédit — serveur démarré sur http://localhost:${PORT}`);
});
