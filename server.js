const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
require(__dirname + '/Resources/config.js');
require('./packet.js');

// Boolean flag to toggle between ws:// (localhost) and wss:// (secure)
const useSecure = false; // Set to true for wss://, false for ws:// on localhost

// SSL certificate options for wss://
const serverOptions = useSecure ? {
    key: fs.readFileSync('C:/Users/Main/Desktop/privkey.pem'),
    cert: fs.readFileSync('C:/Users/Main/Desktop/fullchain.pem')
} : {};

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
map_files.forEach(function(mapFile) {
    console.log('Loading Map: ' + mapFile);
    var map = require(config.data_paths.maps + mapFile);
    maps[map.room] = map;
});

// Create the server based on useSecure flag
const server = useSecure
    ? https.createServer(serverOptions)
    : http.createServer();

// Create a WebSocket server
const wss = new WebSocket.Server({ server: server });

// Listen on the specified port, bind to localhost for ws://
server.listen({
    port: config.port,
    host: useSecure ? undefined : 'localhost' // Bind to localhost for ws://, all interfaces for wss://
});

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
            // Handle binary data
            thisClient.data(message);
        } else {
            // Handle text data
            thisClient.data(message);
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

console.log(`Initialize Completed, WebSocket Server running on port: ${config.port} for environment: ${config.environment} using ${useSecure ? 'wss://' : 'ws://'}`);