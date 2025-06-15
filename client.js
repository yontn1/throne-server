// Import required modules
var now = require('performance-now');
var _ = require('underscore');

// Export the client module
module.exports = function() {
    var client = this;

    // These objects will be added at runtime
    // this.socket = {}
    // this.user = {}

    // Initialization method
    this.initiate = function() {
        // Send the connection handshake packet to the client in binary format
        const handshakePacket = packet.build(["HELLO", now().toString()]);
        client.socket.send(handshakePacket);  // No JSON, send raw binary data
        console.log('Client initiated');
    };

    // Method to handle room entry
    this.enterroom = function (selected_room) {
    

        if (maps[selected_room] && maps[selected_room].clients) {
                 

            console.log(`Client ${client.user.username} is entering room: ${selected_room}`);
            
            // Notify the new client about all existing users in the room
            maps[selected_room].clients.forEach(function (otherClient) {
                const enterPacket = packet.build([
                    "ENTER",
                    otherClient.user.username,
                    otherClient.user.pos_x,
                    otherClient.user.pos_y,
                    otherClient.user.weapon,
                    otherClient.user.trousers_colour,
                    otherClient.user.top_colour,
                    otherClient.user.skin_colour,
                    otherClient.user.hair_colour,
                    otherClient.user.hair,
                    otherClient.user.hp,
                    otherClient.user.hpExperience,
                    otherClient.user.meleeExperience,
                    otherClient.user.defenceExperience,
                ]);
                client.socket.send(enterPacket); // Send raw binary packet
                console.log(`Sent ENTER packet to ${client.user.username} for existing user: ${otherClient.user.username}`);
            });
    
            // Notify existing clients in the room  about the new client
            const newClientPacket = packet.build(["ENTER", client.user.username, client.user.pos_x, client.user.pos_y, client.user.weapon, client.user.trousers_colour, client.user.top_colour, client.user.skin_colour, client.user.hair_colour, client.user.hair]);
            maps[selected_room].clients.forEach(function (otherClient) {
                otherClient.socket.send(newClientPacket); // Send raw binary packet
                console.log(`Notified ${otherClient.user.username} about new user: ${client.user.username}`);
            });
    
            // Add the new client to the room
            maps[selected_room].clients.push(client);
            console.log(`Added ${client.user.username} to room: ${selected_room}`);
        } else {
            console.log(`Room ${selected_room} does not exist or has no clients.`);
        }
    };
    

    // Method to broadcast data to all clients in the same room
    this.broadcastroom = function(packetData) {
        maps[client.user.current_room].clients.forEach(function(otherClient) {
            if (otherClient.user.username !== client.user.username) {
                otherClient.socket.send(packetData);  // Broadcast binary data as-is
            }
        });
    };

    // Method to broadcast data to a client in the same room
    this.broadcastuser = function(username, packetData) {
        maps[client.user.current_room].clients.forEach(function(otherClient) {
            if (otherClient.user.username == username) {
                otherClient.socket.send(packetData);  // Broadcast binary data as-is
            }
        });
    };

    // Method to handle incoming binary data messages from GML
    this.data = function(message) {
        try {
            if (Buffer.isBuffer(message)) {
                // Handle binary data (from GML)

                // Read the packet size (first byte)
                const packetSize = message.readUInt8(0);

                // Extract the actual data based on the packet size
                const dataBuffer = message.slice(0, packetSize + 1);

                // Parse the data buffer (you will need to adjust the parsing logic based on the actual format)
                packet.parse(client, dataBuffer);

                console.log("Received binary data of size:", packetSize);
            } else {
                console.error("Received non-binary data, expected buffer.");
            }
        } catch (e) {
            console.error("Error parsing message", e);
        }
    };  

    // Error handling method
    this.error = function(err) {
        console.log("Client error:", err);
    };

    // Method to handle client disconnection
    this.end = function() {
        console.log("Client closed");
        if (client.user && client.user.current_room && maps[client.user.current_room]) {
            const disconnectMessage = packet.build(["LEAVE", client.user.username]);
            maps[client.user.current_room].clients.forEach(function(otherClient) {
                if (otherClient.user.username !== client.user.username) {
                    otherClient.socket.send(disconnectMessage);  // Send raw binary packet
                }
            });

            // Remove the client from the room's client list
            maps[client.user.current_room].clients = _.filter(maps[client.user.current_room].clients, function(otherClient) {
                return otherClient.user.username !== client.user.username;
            });
        }
    };
};
