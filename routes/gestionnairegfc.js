const { creerRouteurEspace } = require("./espace-fabrique");

module.exports = creerRouteurEspace({
  role: "gestionnairegfc",
  type: "particulier",
  basePath: "/gestionnairegfc",
  nomEspace: "Gestionnaire GFC",
  assignationParAgent: true, // le client choisit son gestionnaire (Abomo, Mabou, Ngo, Emile)
  deuxEtapes: true,          // la décision de l'agent est une recommandation, validée ensuite par le chef GFC
});
