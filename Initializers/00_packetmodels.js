// create Parser from a package that includes Parser (require?)

const { connect } = require('mongoose');

// parser is the thing that receives a command from connection,
var Parser = require('binary-parser').Parser;
var StringOptions = {length: 99, zeroTerminated:true};

// the module exoprts is called "PacketModels" and is being a package of data
module.exports = PacketModels = {

    // a mandatory part of each package is the header, which is telling the kind of the command.
    header: new Parser().skip(1)
        .string("command", StringOptions),

    // the login request information.
    login: new Parser().skip(1)
        .string("command", StringOptions)
        .string("username", StringOptions)
        .string("password", StringOptions),

    // the registration request information.
    register: new Parser().skip(1)
        .string("command", StringOptions)
        .string("username", StringOptions)
        .string("password", StringOptions),

    // the player position and appearance update.
    pos: new Parser().skip(1)
        .string("command", StringOptions)
        .int32le("target_x", StringOptions)
        .int32le("target_y", StringOptions)
        .string("animation", StringOptions)
        .string("direction", StringOptions),

    // update about the player attack status.
    attack: new Parser().skip(1)
        .string("command", StringOptions)
        .int32le("damage", StringOptions)
        .int32le("face", StringOptions)
        .string("target_name", StringOptions)
        .string("source_name", StringOptions),
        
    dmg: new Parser().skip(1)
        .string("command", StringOptions)
        .string("damage", StringOptions)
        .string("target_name", StringOptions)
        .string("hp_percentage", StringOptions), 

    ranger: new Parser().skip(1)
        .string("command", StringOptions)
        .string("name", StringOptions)
        .int32le("damage", StringOptions)
        .int32le("startpoint_x", StringOptions)
        .int32le("startpoint_y", StringOptions)
        .int32le("goalpoint_x", StringOptions)
        .int32le("goalpoint_y", StringOptions)
        .int32le("speed", StringOptions)
        .string("arrow", StringOptions),

    // the player sending of chat request.
    chat: new Parser().skip(1)
        .string("command", StringOptions)
        .string("chatMessage", StringOptions),

    // the npc's information about its location and status.
    npc: new Parser().skip(1)
        .string("command", StringOptions)
        .string("object", StringOptions)
        .string("name", StringOptions)
        .int32le("target_x", StringOptions)
        .int32le("target_y", StringOptions)
        .string("status", StringOptions)
        .string("player_name", StringOptions),

    // a players request to change one of its variables
    change: new Parser().skip(1)
        .string("command", StringOptions)
        .string("name", StringOptions)
        .string("variable", StringOptions)
        .string("value", StringOptions)
        .string("amount", StringOptions)
        .string("action", StringOptions),

    //  an update from the player that its change has passed and it has to be saved on the database.
    accept: new Parser().skip(1)
        .string("command", StringOptions)
        .string("name", StringOptions)
        .string("variable", StringOptions)
        .string("value", StringOptions),

    // dropping an item
    drop: new Parser().skip(1)
        .string("command", StringOptions)
        .string("name", StringOptions)
        .int32le("target_x", StringOptions)
        .int32le("target_y", StringOptions)
        .string("item", StringOptions)
        .string("action", StringOptions)
        .string("user_name", StringOptions),
        
    // handle crops
    crop: new Parser().skip(1)
        .string("command", StringOptions)
        .string("type1", StringOptions)
        .string("name2", StringOptions)
        .string("stage3", StringOptions)
        .string("action4", StringOptions)
        .string("user_name5", StringOptions)
        .string("target_x6", StringOptions)
        .string("target_y7", StringOptions),

    // request connect
    bind: new Parser().skip(1)
    .string("command", StringOptions)
    .string("target_name", StringOptions)
    .string("target_npc", StringOptions)
    .string("action", StringOptions),

     // request info
    shop: new Parser().skip(1)
     .string("command", StringOptions)
     .string("target_name", StringOptions)
     .string("target_npc", StringOptions)
     .string("item", StringOptions)
     .string("amount", StringOptions)
     .string("price", StringOptions)
     .string("action", StringOptions),
}