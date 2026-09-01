const { creerRouteurChef } = require("./chef-fabrique");

module.exports = creerRouteurChef({
  role: "chef_gfc",
  type: "particulier",
  roleAgent: "gestionnairegfc",
  basePath: "/chef-gfc",
  nomEspace: "Chef GFC",
});
