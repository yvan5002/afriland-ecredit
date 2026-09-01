// ============================================================
// AFRILAND E-CRÉDIT — Portail de demande de crédit à distance
// Serveur Express (Node.js)
// ============================================================

const express = require("express");
const path = require("path");
const session = require("express-session");
const cookieParser = require("cookie-parser");

const app = express();

// Port fourni par Render en production
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  if (!req.cookies) req.cookies = {};
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Les documents clients ne sont plus servis publiquement.
// Voir les routes sécurisées prévues à cet effet.

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "cle_secrete_afriland_ecredit_2026",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// ============================================================
// ROUTES
// ============================================================

app.use(
  "/gestionnairegfc",
  require("./routes/gestionnairegfc")
);

app.use(
  "/pme",
  require("./routes/pme")
);

app.use(
  "/corporate",
  require("./routes/corporate")
);

app.use(
  "/chef-gfc",
  require("./routes/chef-gfc")
);

app.use(
  "/chef-pme",
  require("./routes/chef-pme")
);

app.use(
  "/chef-corporate",
  require("./routes/chef-corporate")
);

app.use(
  "/demande-entreprise",
  require("./routes/entreprise")
);

app.use(
  "/connexion",
  require("./routes/connexion")
);

app.use(
  "/",
  require("./routes/portail")
);

// ============================================================
// PAGE 404
// ============================================================

app.use((req, res) => {
  res.status(404).render("404", {
    titre: "Page introuvable",
  });
});

// ============================================================
// DÉMARRAGE DU SERVEUR
// ============================================================

// IMPORTANT POUR RENDER : écouter sur 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `>>> Afriland E-Crédit — serveur démarré sur le port ${PORT}`
  );
});