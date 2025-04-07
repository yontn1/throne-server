// Import Required Libraries
const fs = require('fs');
const https = require('https');
const http = require('http'); // Use http instead of https

const WebSocket = require('ws');
require(__dirname + '/Resources/config.js');
require('./packet.js');

/* const serverOptions = {
    cert: fs.readFileSync('C:\\Users\\yivol\\Desktop\\cert.pem'),
    key: fs.readFileSync('C:\\Users\\yivol\\Desktop\\key.pem')
};
 

*/

const serverOptions = {
    key: fs.readFileSync('C:/Users/yivol/Desktop/privkey.pem'),
    cert: fs.readFileSync('C:/Users/yivol/Desktop/fullchain.pem')
};

// Load the initializers
const init_files = fs.readdirSync(__dirname + "/Initializers");
init_files.forEach(function(initFile) {
    console.log('Loading Initializer: ' + initFile);
    require(__dirname + "/Initializers/" + initFile);
});

// Load the models
const model_files = fs.readdirSync(__dirname + "/Models");
model_files.forEach(function(modelFile) {
    console.log('Loading Model: ' + modelFile);
    require(__dirname + "/Models/" + modelFile);
});

// Load map files
maps = {};
var map_files = fs.readdirSync(config.data_paths.maps);
map_files.forEach(function(mapFile){
    console.log('Loading Map: ' + mapFile);
    var map = require(config.data_paths.maps + mapFile);
    maps[map.room] = map
});
// Create a WebSocket server
const server = https.createServer(serverOptions);
const server2 = http.createServer();

const wss = new WebSocket.Server({ server: server });
server.listen({ port: config.port });
//const wss = new WebSocket.Server({ port: config.port });

wss.on('connection', function(socket) {
    console.log("WebSocket connected");

    // Load the client class for handling individual connections
    const Client = require('./client.js');
    const thisClient = new Client();

    thisClient.socket = socket;
    thisClient.initiate();

    // Handle messages from clients
    socket.on('message', function(message) {
        if (Buffer.isBuffer(message)) {
            // Handle binary data (if your client sends binary data in buffers)
            thisClient.data(message);  // Passing binary data directly
        } else {
            // Handle text data
            thisClient.data(message);  // Pass string data to the existing data handler
        }
    });

    // Handle client disconnection
    socket.on('close', function() {
        console.log("WebSocket client disconnected");
        thisClient.end();
    });

    // Handle WebSocket errors
    socket.on('error', function(error) {
        console.error("WebSocket error: ", error);
        thisClient.error(error);
    });
});

console.log("Initialize Completed, WebSocket Server running on port: " + config.port + " for environment: " + config.environment);
