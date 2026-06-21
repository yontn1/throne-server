var mongoose = require('mongoose');

var houseSchema = new mongoose.Schema({
    placeId: { type: String, unique: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    ownerUsername: { type: String, index: true },
    room: { type: String, index: true },
    x: Number,
    y: Number,
    config: String
}, { timestamps: true });

module.exports = House = gamedb.model('House', houseSchema);
