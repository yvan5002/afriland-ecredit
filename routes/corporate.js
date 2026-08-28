const { creerRouteurEspace } = require("./espace-fabrique");

module.exports = creerRouteurEspace({
  role: "corporate",
  type: "corporate",
  basePath: "/corporate",
  nomEspace: "Corporate",
  assignationParAgent: true, // le client choisit son agent Corporate (voir routes/entreprise.js)
});
