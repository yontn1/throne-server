// use the mongoose database package
var mongoose = require('mongoose');
//use the database schema for the player in a form of JSON data structure
var userSchema;
userSchema = new mongoose.Schema({

    username: {type: String, unique: true},
    password: String,
    status: String,
    sprite: String,

    current_room: String,
    pos_x: Number,
    pos_y: Number,
    experience: String,
    hp: Number,
    mana: Number,
    stanima: Number,
    money: Number,
    weapon: Number,
    shield: Number,
    hat: Number,
    top: Number,
    trousers: Number,
    trousers_colour: String,
    top_colour: String,
    skin_colour: String,
    hair_colour: String,
    hair: String,
    ring1: Number,
    ring2: Number,
    ring3: Number,
    ring4: Number,
    amulet: Number,
    shoes: Number,
    gloves: Number,
    cape: Number,
    item1: String,
    item2: String,
    item3: String,
    item4: String,
    item5: String,
    item6: String

});
// how to create a new user through registration process.
userSchema.statics.register = function(username, password, cb){

    var new_user = new User({
        username: username,
        password: password,
        status: "player",
        sprite: "spr_Hero",

        current_room: maps[config.starting_zone].room,
        pos_x: maps[config.starting_zone].start_x,
        pos_y: maps[config.starting_zone].start_y,
        experience: 0,
        hp: 30,
        mana: 10,
        stanima: 20,
        money: 0,
        weapon: "11112",
        shield: "0",
        hat: "0",
        top: "0",
        trousers: "0",
        trousers_colour: "0",
        top_colour: "0",
        skin_colour: "0",
        hair: "0",
        hair_colour: "0",
        ring1: "0",
        ring2: "0",
        ring3: "0",
        ring4: "0",
        amulet: "0",
        shoes: "0",
        gloves: "0",
        cape: "0",
        item1: "0",
        item2: "0",
        item3: "0",
        item4: "0",
        item5: "0",
        item6: "0"
    });

    // throw an error if needed.
    new_user.save(function(err){
        if(!err){
            cb(true);
        }else{
            cb(false);
        }
    });

};

userSchema.statics.login = function(username, password, cb){

    User.findOne({username: username}, function(err, user){

        if(!err && user){
            if(user.password == password){
                cb(true, user);
            }else{
                cb(false, null);
            }
        }else{
            cb(false, null);
        }

    })

};
// send the user as a part of the 'Users' predefined folder in mongoose inside predefined 'gamedb' from our _mongodb.
module.exports = User = gamedb.model('User', userSchema);