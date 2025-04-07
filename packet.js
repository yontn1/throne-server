// Updated packet.js to work with modern Node.js Buffer API and WebSocket communications

module.exports = packet = {
    // Build a packet from an array of JavaScript objects (strings, numbers)
    build: function (params) {
        var packetParts = [];
        var packetSize = 0;

        params.forEach(function (param) {
            var buffer;

           
            console.log(param);
              if (typeof param === 'string') {
                buffer = Buffer.from(param, 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string
            } else if (typeof param === 'number') {
                buffer = Buffer.alloc(2);
                buffer.writeUInt16LE(param, 0); // Write the number as a 16-bit integer
            } else {
                buffer = Buffer.from("0", 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string

                console.log("WARNING: Unknown data type in packet builder!");
            }

            packetSize += buffer.length;
            packetParts.push(buffer);
        });

        var dataBuffer = Buffer.concat(packetParts, packetSize);
        var size = Buffer.alloc(1);
        size.writeUInt8(dataBuffer.length + 1, 0); // Packet size

        var finalPacket = Buffer.concat([size, dataBuffer], size.length + dataBuffer.length);
        console.log(finalPacket);
        return finalPacket;
    },

    // Parse a packet to be handled for a client
    parse: function (c, data) {
        var idx = 0;

        while (idx < data.length) {
            var packetSize = data.readUInt8(idx); // Read the size of the packet
            var extractedPacket = Buffer.alloc(packetSize);
            data.copy(extractedPacket, 0, idx, idx + packetSize); // Copy the packet data

            this.interpret(c, extractedPacket); // Interpret the packet

            idx += packetSize;
        }
    },

    // Interpret what to do with a parsed packet
    interpret: function (c, datapacket) {
        var header = PacketModels.header.parse(datapacket); // Parse header
        console.log("Interpret: " + header.command);

        switch (header.command.toUpperCase()) {
            case "LOGIN":
                var data = PacketModels.login.parse(datapacket);
                User.login(data.username, data.password, function (result, user) {
                    if (result) {
                        c.user = user;
                        c.enterroom(c.user.current_room);
                        console.log("Interpret: enterroom should have been called" );

                    /*     if (c.user && c.user.current_room) {
                            c.broadcastroom(packet.build(["LEAVE", c.user.username]), c.user.current_room);
                        }; */
                        c.socket.send(packet.build(["LOGIN", "TRUE",
                            c.user.current_room, c.user.pos_x, c.user.pos_y, c.user.username, c.user.experience, c.user.hp, c.user.mana,
                            c.user.stanima, c.user.money, c.user.weapon, c.user.shield, c.user.hat, c.user.top, c.user.trousers, c.user.ring1, c.user.ring2, c.user.ring3,
                            c.user.ring4, c.user.amulet, c.user.shoes, c.user.gloves, c.user.cape,
                            c.user.item1, c.user.item2, c.user.item3, c.user.item4, c.user.item5, c.user.item6,
                            c.user.status, c.user.trousers_colour, c.user.top_colour, c.user.skin_colour, c.user.hair_colour, c.user.hair]));
                    } else {
                        c.socket.send(packet.build(["LOGIN", "FALSE"]));
                    }
                });
                break;
                
                case "LOGIN2":
                
   
                c.socket.send(packet.build(["LOGIN2",
                    c.user.item1, c.user.item2, c.user.item3, c.user.item4, c.user.item5, c.user.item6,
                    c.user.status, c.user.trousers_colour, c.user.top_colour, c.user.skin_colour, c.user.hair_colour, c.user.hair]));
                    
                break;

            case "REGISTER":
                var data = PacketModels.register.parse(datapacket);
                User.register(data.username, data.password, function (result) {
                    if (result) {
                        c.socket.send(packet.build(["REGISTER", "TRUE"]));
                    } else {
                        c.socket.send(packet.build(["REGISTER", "FALSE"]));
                    }
                });
                break;

            case "POS": // Player position and existence
                var data = PacketModels.pos.parse(datapacket);
                c.user.pos_x = data.target_x;
                c.user.pos_y = data.target_y;
                c.user.hat = data.hat;
                c.user.save();
                c.broadcastroom(packet.build(["POS", c.user.username, data.target_x, data.target_y, data.hat]));
                break;

            case "ATTACK": // Player attack
                var data = PacketModels.attack.parse(datapacket);
                c.broadcastroom(packet.build(["ATTACK", c.user.username, data.damage, data.face, data.target_name]));
                break;

            case "DMG": // Player attack
                var data = PacketModels.dmg.parse(datapacket);
                c.broadcastroom(packet.build(["DMG", c.user.username, data.damage, data.target_name, data.hp_percentage]));
                break;

            case "RANGER": // Shoot
                var data = PacketModels.ranger.parse(datapacket);
                c.broadcastroom(packet.build(["RANGER", c.user.username, data.name, data.damage, data.startpoint_x, data.startpoint_y, data.goalpoint_x, data.goalpoint_y, data.speed, data.arrow]));
                break;

            case "CHAT": // Send and receive chat
                var data = PacketModels.chat.parse(datapacket);
                c.broadcastroom(packet.build(["CHAT", c.user.username, data.chatMessage]));
                break;

            case "NPC": // NPC location and status
                var data = PacketModels.npc.parse(datapacket);
                c.broadcastroom(packet.build(["NPC", data.object, data.name, data.target_x, data.target_y, data.status, data.player_name]));
                break;

            case "CHANGE": // Request a change
                var data = PacketModels.change.parse(datapacket);
                c.broadcastroom(packet.build(["CHANGE", data.name, data.variable, data.value, data.amount, data.action]));
                break;

            case "ACCEPT": // Save changes to the database
                var data = PacketModels.accept.parse(datapacket);
                c.broadcastroom(packet.build(["ACCEPT", data.name, data.variable, data.value]));
                switch (data.variable) {
                    case "experience":
                        c.user.experience = data.value;
                        break;
                    case "money":
                        c.user.money = data.value;
                        break;
                    case "hat":
                        c.user.hat = data.value;
                        break;
                    case "item1":
                        c.user.item1 = data.value;
                        break;
                    case "item2":
                        c.user.item2 = data.value;
                        break;
                    case "item3":
                        c.user.item3 = data.value;
                        break;
                    case "item4":
                        c.user.item4 = data.value;
                        break;
                    case "item5":
                        c.user.item5 = data.value;
                        break;
                    case "item6":
                        c.user.item6 = data.value;
                        break;
                    case "weapon":
                        c.user.weapon = data.value;
                        break;
                    case "trousers_colour":
                        c.user.trousers_colour = data.value;
                        break;
                    case "top_colour":
                        c.user.top_colour = data.value;
                        break;
                    case "skin_colour":
                        c.user.skin_colour = data.value;
                        break;
                    case "hair_colour":
                        c.user.hair_colour = data.value;
                        break;
                    case "hair":
                        c.user.hair = data.value;
                        break;
                }
                break;

            case "DROP": // Drop item
                var data = PacketModels.drop.parse(datapacket);
                c.broadcastroom(packet.build(["DROP", data.name, data.target_x, data.target_y, data.item, data.action, data.user_name]));
                break;

            case "CROP": 
                var data = PacketModels.crop.parse(datapacket);
                c.broadcastroom(packet.build(["CROP", data.type1, data.name2, data.stage3, data.action4, data.user_name5, data.target_x6, data.target_y7]));
                break;

            default:
                console.log("Unknown command: " + header.command);
        }
    }
};
