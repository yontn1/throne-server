var mongoose = require('mongoose');

var servantChestSlotSchema = new mongoose.Schema({
    item: String,
    amount: Number
}, { _id: false });

var houseServantSchema = new mongoose.Schema({
    unlocked: { type: Boolean, default: false },
    collectEnabled: { type: Boolean, default: true },
    cx: Number,
    cy: Number,
    halfW: Number,
    halfH: Number,
    chestPlaced: { type: Boolean, default: false },
    chestX: Number,
    chestY: Number,
    chest: { type: [servantChestSlotSchema], default: [] },
    xpDateKey: { type: String, default: "" },
    xpToday: { type: Number, default: 0 }
}, { _id: false });

var furnitureChestSlotSchema = new mongoose.Schema({
    item: String,
    amount: Number
}, { _id: false });

var houseFurnitureSchema = new mongoose.Schema({
    id: { type: String, index: true },
    type: String,
    x: Number,
    y: Number,
    mirrored: { type: Boolean, default: false },
    chest: { type: [furnitureChestSlotSchema], default: [] }
}, { _id: false });

var houseSchema = new mongoose.Schema({
    placeId: { type: String, unique: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    ownerUsername: { type: String, index: true },
    room: { type: String, index: true },
    x: Number,
    y: Number,
    config: String,
    locked: { type: Boolean, default: false },
    servant: { type: houseServantSchema, default: null },
    furniture: { type: [houseFurnitureSchema], default: [] }
}, { timestamps: true });

module.exports = House = gamedb.model('House', houseSchema);
