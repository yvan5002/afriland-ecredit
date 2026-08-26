const { creerRouteurEspace } = require("./espace-fabrique");

module.exports = creerRouteurEspace({
  role: "corporate",
  type: "corporate",
  basePath: "/corporate",
  nomEspace: "Corporate",
});
