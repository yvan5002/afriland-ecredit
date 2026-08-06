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
  if (!req.cookies) req.cookies = {};
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(session({
  secret: process.env.SESSION_SECRET || "cle_secrete_afriland_ecredit_2026",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 1000 * 60 * 60 * 24 },
}));

app.use("/agent", require("./routes/agent"));
app.use("/", require("./routes/portail"));

app.use((req, res) => {
  res.status(404).render("404", { titre: "Page introuvable" });
});

app.listen(PORT, () => {
  console.log(`>>> Afriland E-Credit - serveur demarre sur http://localhost:${PORT}`);
});
