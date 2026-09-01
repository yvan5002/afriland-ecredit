const { creerRouteurChef } = require("./chef-fabrique");

module.exports = creerRouteurChef({
  role: "chef_pme",
  type: "pme",
  roleAgent: "pme",
  basePath: "/chef-pme",
  nomEspace: "Chef des PME",
});
