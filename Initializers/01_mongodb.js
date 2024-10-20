// use the mongoose database package
var mongoose = require('mongoose');

// use "gamedb" as a mongoose database
module.exports = gamedb = mongoose.createConnection(config.database);