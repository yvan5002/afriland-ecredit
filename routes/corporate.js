const { creerRouteurEspace } = require("./espace-fabrique");

module.exports = creerRouteurEspace({
  role: "corporate",
  type: "corporate",
  basePath: "/corporate",
  nomEspace: "Corporate",
  assignationParAgent: true, // le client choisit son agent Corporate (voir routes/entreprise.js)
  deuxEtapes: true,          // la décision de l'agent est une recommandation, validée ensuite par le chef Corporate
});
