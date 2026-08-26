const { creerRouteurEspace } = require("./espace-fabrique");

module.exports = creerRouteurEspace({
  role: "pme",
  type: "pme",
  basePath: "/pme",
  nomEspace: "PME",
  assignationParAgent: true, // le client choisit son agent PME nommé
  deuxEtapes: true,          // la décision de l'agent est une recommandation, validée ensuite par le chef des PME
});
