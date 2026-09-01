const { creerRouteurChef } = require("./chef-fabrique");

module.exports = creerRouteurChef({
  role: "chef_corporate",
  type: "corporate",
  roleAgent: "corporate",
  basePath: "/chef-corporate",
  nomEspace: "Chef Corporate",
});
