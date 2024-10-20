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
    this.enterroom = function(selected_room) {
        if (maps[selected_room] && maps[selected_room].clients) {
            maps[selected_room].clients.forEach(function(otherClient) {
                const enterPacket = packet.build(["ENTER", client.user.username, client.user.pos_x, client.user.pos_y]);
                otherClient.socket.send(enterPacket);  // Send raw binary packet
            });
            maps[selected_room].clients.push(client);
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
