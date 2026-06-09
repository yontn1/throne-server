// Updated packet.js to work with modern Node.js Buffer API and WebSocket communications
let requestGraph = null;
try {
    requestGraph = require('./requestGraph.js');
} catch (error) {
    requestGraph = null;
}

const BANK_SLOT_LIMIT = 50;
const BANK_STACK_LIMIT = 2000000;
const INVENTORY_SLOT_COUNT = 12;
const BANK_DEBUG = false;
const NON_STACKABLE_ITEMS = new Set([
    "11112", // Sword
    "11119", // Axe
    "11122", // Shield
    "11129", // Mithril sword
    "11132", // Mithril spear
    "11143", // Adamant sword
    "11144", // Adamant spear
    "11145", // Fishing rod
    "11152", // Pickaxe
    "11155", // Hammer
    "11157", // Iron helmet
    "11158", // Iron platebody
    "11159"  // Iron platelegs
]);
const sessionFishSpotsByRoom = {};

function clampInt(value, min, max) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return min;
    return Math.max(min, Math.min(max, parsed));
}

function isStackableItem(item) {
    return !NON_STACKABLE_ITEMS.has(String(item));
}

function decodeInventoryValue(rawValue) {
    const raw = Math.floor(Number(rawValue || 0));
    if (!Number.isFinite(raw) || raw <= 0) return { item: "0", amount: 0 };

    if (raw > 99999) {
        const amount = raw % 100;
        const item = Math.floor(raw / 100);
        return amount > 0 ? { item: String(item), amount } : { item: "0", amount: 0 };
    }

    return { item: String(raw), amount: 1 };
}

function packInventoryValue(item, amount) {
    const itemId = String(item || "0");
    const itemAmount = clampInt(amount, 0, 99);
    if (itemId === "0" || itemAmount <= 0) return "0";
    const amountText = itemAmount < 10 ? `0${itemAmount}` : String(itemAmount);
    return `${itemId}${amountText}`;
}

function readInventory(user) {
    const inventory = [];
    for (let i = 1; i <= INVENTORY_SLOT_COUNT; i++) {
        inventory.push(decodeInventoryValue(user[`item${i}`]));
    }
    return inventory;
}

function writeInventory(user, inventory) {
    for (let i = 1; i <= INVENTORY_SLOT_COUNT; i++) {
        const slot = inventory[i - 1] || { item: "0", amount: 0 };
        user[`item${i}`] = packInventoryValue(slot.item, slot.amount);
    }
}

function countInventoryItem(inventory, item) {
    return inventory.reduce((total, slot) => {
        return slot.item === String(item) ? total + slot.amount : total;
    }, 0);
}

function removeFromInventory(inventory, item, amount) {
    let remaining = clampInt(amount, 0, BANK_STACK_LIMIT);
    let removed = 0;

    for (const slot of inventory) {
        if (remaining <= 0) break;
        if (slot.item !== String(item) || slot.amount <= 0) continue;

        const take = Math.min(slot.amount, remaining);
        slot.amount -= take;
        removed += take;
        remaining -= take;
        if (slot.amount <= 0) {
            slot.item = "0";
            slot.amount = 0;
        }
    }

    return removed;
}

function inventoryCapacityForItem(inventory, item) {
    const itemId = String(item);
    const stackable = isStackableItem(itemId);
    let capacity = 0;

    for (const slot of inventory) {
        if (slot.amount <= 0 || slot.item === "0") {
            capacity += stackable ? 99 : 1;
        } else if (stackable && slot.item === itemId) {
            capacity += Math.max(0, 99 - slot.amount);
        }
    }

    return capacity;
}

function addToInventory(inventory, item, amount) {
    const itemId = String(item);
    const stackable = isStackableItem(itemId);
    let remaining = clampInt(amount, 0, BANK_STACK_LIMIT);
    let added = 0;

    if (stackable) {
        for (const slot of inventory) {
            if (remaining <= 0) break;
            if (slot.item !== itemId || slot.amount <= 0) continue;
            const add = Math.min(99 - slot.amount, remaining);
            if (add <= 0) continue;
            slot.amount += add;
            added += add;
            remaining -= add;
        }
    }

    for (const slot of inventory) {
        if (remaining <= 0) break;
        if (slot.amount > 0 && slot.item !== "0") continue;
        const add = stackable ? Math.min(99, remaining) : 1;
        slot.item = itemId;
        slot.amount = add;
        added += add;
        remaining -= add;
    }

    return added;
}

function normalizeBank(user) {
    const source = Array.isArray(user.bank) ? user.bank : [];
    const merged = [];

    for (const slot of source) {
        const item = String(slot && slot.item ? slot.item : "0");
        const amount = clampInt(slot && slot.amount, 0, BANK_STACK_LIMIT);
        if (item === "0" || amount <= 0) continue;

        const existing = merged.find(entry => entry.item === item);
        if (existing) {
            existing.amount = Math.min(BANK_STACK_LIMIT, existing.amount + amount);
        } else if (merged.length < BANK_SLOT_LIMIT) {
            merged.push({ item, amount });
        }
    }

    user.bank = merged;
    if (typeof user.markModified === "function") user.markModified("bank");
    return user.bank;
}

function sendInventorySnapshot(c, inventory) {
    for (let i = 1; i <= INVENTORY_SLOT_COUNT; i++) {
        const slot = inventory[i - 1] || { item: "0", amount: 0 };
        c.socket.send(packet.build(["BANK", "INV", String(i), packInventoryValue(slot.item, slot.amount)]));
    }
}

function sendBankSnapshot(c, status = "OK", message = "") {
    const bank = normalizeBank(c.user);
    c.socket.send(packet.build(["BANK", "START", status, message]));
    for (let i = 0; i < bank.length; i++) {
        c.socket.send(packet.build(["BANK", "SLOT", String(i + 1), String(bank[i].item), String(bank[i].amount)]));
    }
    c.socket.send(packet.build(["BANK", "END"]));
}

function sendBankError(c, message) {
    c.socket.send(packet.build(["BANK", "ERROR", String(message || "Bank action failed")]));
}

function getSessionFishSpots(room) {
    const roomKey = String(room || "");
    if (!sessionFishSpotsByRoom[roomKey]) sessionFishSpotsByRoom[roomKey] = [];
    return sessionFishSpotsByRoom[roomKey];
}

function clampFishSpotRemaining(value) {
    return clampInt(value, 0, 150);
}

function broadcastRoomIncluding(room, packetData) {
    if (typeof maps === "undefined" || !maps[room] || !Array.isArray(maps[room].clients)) return;
    maps[room].clients.forEach(function(otherClient) {
        if (otherClient && otherClient.socket) {
            otherClient.socket.send(packetData);
        }
    });
}

function sendFishSpotSnapshot(c, room) {
    const spots = getSessionFishSpots(room);
    spots.forEach(function(spot) {
        c.socket.send(packet.build([
            "FISHSPOT",
            "SYNC",
            String(spot.id),
            String(spot.x),
            String(spot.y),
            String(spot.remaining)
        ]));
    });
}

function handleFishSpotPacket(c, datapacket) {
    if (!c.user) return;
    const data = PacketModels.fishspot.parse(datapacket);
    const room = c.user.current_room;
    const spots = getSessionFishSpots(room);
    const action = String(data.action || "").toUpperCase();
    const spotId = String(data.spot_id || "");
    const x = clampInt(data.target_x, 0, 65535);
    const y = clampInt(data.target_y, 0, 65535);
    const remaining = clampFishSpotRemaining(data.remaining);

    if (!spotId) return;

    const existingIndex = spots.findIndex(spot => spot.id === spotId);

    if (action === "CREATE" || action === "SYNC") {
        const spot = { id: spotId, x, y, remaining: remaining || 150 };
        if (existingIndex >= 0) {
            spots[existingIndex] = spot;
        } else {
            spots.push(spot);
        }
        broadcastRoomIncluding(room, packet.build(["FISHSPOT", "CREATE", spot.id, String(spot.x), String(spot.y), String(spot.remaining)]));
        return;
    }

    if (action === "UPDATE") {
        if (existingIndex >= 0) {
            spots[existingIndex].remaining = remaining;
            broadcastRoomIncluding(room, packet.build(["FISHSPOT", "UPDATE", spotId, String(x), String(y), String(remaining)]));
        }
        return;
    }

    if (action === "DESTROY") {
        if (existingIndex >= 0) spots.splice(existingIndex, 1);
        broadcastRoomIncluding(room, packet.build(["FISHSPOT", "DESTROY", spotId, String(x), String(y), "0"]));
    }
}

function bankLog(...args) {
    // if (BANK_DEBUG) console.log("[BANK]", ...args);
}

function saveUserAndSyncBank(c, inventory, status, message) {
    writeInventory(c.user, inventory);
    if (typeof c.user.markModified === "function") c.user.markModified("bank");

    const afterSave = () => {
        sendInventorySnapshot(c, inventory);
        sendBankSnapshot(c, status, message);
    };

    const attemptSave = () => {
        if (c.user._savePromise) {
            setTimeout(attemptSave, 100);
            return;
        }

        const savePromise = c.user.save();
        if (savePromise && typeof savePromise.then === "function") {
            c.user._savePromise = savePromise
                .then(afterSave)
                .catch(error => {
                    // console.error("Failed to save bank transaction:", error);
                    sendBankError(c, "Bank save failed");
                })
                .finally(() => {
                    c.user._savePromise = null;
                });
        } else {
            afterSave();
        }
    };

    attemptSave();
}

function handleBankPacket(c, datapacket) {
    try {
        if (!c.user) {
            sendBankError(c, "Not logged in");
            return;
        }

        const data = PacketModels.bank.parse(datapacket);
        const action = String(data.action || "").toUpperCase();
        const item = String(clampInt(data.item || 0, 0, BANK_STACK_LIMIT));
        const amount = clampInt(data.amount || 1, 1, BANK_STACK_LIMIT);
        const inventory = readInventory(c.user);
        const bank = normalizeBank(c.user);
        bankLog(c.user.username, action, item, amount);

        if (action === "OPEN") {
            sendBankSnapshot(c, "OK", "");
            return;
        }

        if (action === "CLOSE") {
            return;
        }

        if (action === "DEPOSIT_ALL") {
            let deposited = 0;

            for (const inventorySlot of inventory) {
                if (inventorySlot.item === "0" || inventorySlot.amount <= 0) continue;

                let bankSlot = bank.find(slot => slot.item === inventorySlot.item);
                if (!bankSlot) {
                    if (bank.length >= BANK_SLOT_LIMIT) continue;
                    bank.push({ item: inventorySlot.item, amount: 0 });
                    bankSlot = bank[bank.length - 1];
                }

                const moved = Math.min(inventorySlot.amount, BANK_STACK_LIMIT - bankSlot.amount);
                if (moved <= 0) continue;

                bankSlot.amount += moved;
                inventorySlot.amount -= moved;
                deposited += moved;
                if (inventorySlot.amount <= 0) {
                    inventorySlot.item = "0";
                    inventorySlot.amount = 0;
                }
            }

            if (deposited <= 0) {
                sendBankError(c, "Nothing can be deposited");
                return;
            }

            saveUserAndSyncBank(c, inventory, "OK", "");
            return;
        }

        if (item === "0") {
            sendBankError(c, "No item selected");
            return;
        }

        if (action === "DEPOSIT") {
            const held = countInventoryItem(inventory, item);
            const existing = bank.find(slot => slot.item === item);

            if (held <= 0) {
                sendBankError(c, "You do not have that item");
                return;
            }
            if (!existing && bank.length >= BANK_SLOT_LIMIT) {
                sendBankError(c, "Bank is full");
                return;
            }

            const bankSpace = existing ? (BANK_STACK_LIMIT - existing.amount) : BANK_STACK_LIMIT;
            const actual = Math.min(amount, held, bankSpace);
            if (actual <= 0) {
                sendBankError(c, "Bank stack is full");
                return;
            }

            const removed = removeFromInventory(inventory, item, actual);
            if (removed <= 0) {
                sendBankError(c, "Could not remove item");
                return;
            }

            if (existing) {
                existing.amount = Math.min(BANK_STACK_LIMIT, existing.amount + removed);
            } else {
                bank.push({ item, amount: removed });
            }

            saveUserAndSyncBank(c, inventory, "OK", "");
            return;
        }

        if (action === "WITHDRAW") {
            const bankSlot = bank.find(slot => slot.item === item);
            if (!bankSlot || bankSlot.amount <= 0) {
                sendBankError(c, "That item is not in your bank");
                return;
            }

            const capacity = inventoryCapacityForItem(inventory, item);
            const actual = Math.min(amount, bankSlot.amount, capacity);
            if (actual <= 0) {
                sendBankError(c, "Inventory is full");
                return;
            }

            const added = addToInventory(inventory, item, actual);
            if (added <= 0) {
                sendBankError(c, "Could not add item");
                return;
            }

            bankSlot.amount -= added;
            if (bankSlot.amount <= 0) {
                const index = bank.indexOf(bankSlot);
                if (index >= 0) bank.splice(index, 1);
            }

            saveUserAndSyncBank(c, inventory, "OK", "");
            return;
        }

        sendBankError(c, "Unknown bank action");
    } catch (error) {
        // console.error("Failed to handle bank packet:", error);
        sendBankError(c, "Bank request failed");
    }
}

module.exports = packet = {
    sendFishSpotSnapshot: sendFishSpotSnapshot,

    // Build a packet from an array of JavaScript objects (strings, numbers)
    build: function (params) {
        var packetParts = [];
        var packetSize = 0;
        this.showlogs = false;
        params.forEach(function (param) {
            var buffer;


            // if (this.showlogs) console.log(param);
            if (typeof param === 'string') {
                buffer = Buffer.from(param, 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string
            } else if (typeof param === 'number') {
                buffer = Buffer.alloc(2);
                if (param < 0) {
                    buffer.writeInt16LE(param, 0);
                } else {
                    buffer.writeUInt16LE(param, 0);
                }
            } else {
                buffer = Buffer.from("0", 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string

                // if (this.showlogs) console.log("WARNING: Unknown data type in packet builder!");
            }

            packetSize += buffer.length;
            packetParts.push(buffer);
        });

        var dataBuffer = Buffer.concat(packetParts, packetSize);
        var size = Buffer.alloc(1);
        size.writeUInt8(dataBuffer.length + 1, 0); // Packet size

        var finalPacket = Buffer.concat([size, dataBuffer], size.length + dataBuffer.length);
        // if (this.showlogs) console.log(finalPacket);
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
        // if (this.showlogs) console.log("Interpret: " + header.command);
        if (requestGraph && typeof requestGraph.record === "function") {
            requestGraph.record(header.command);
        }

        switch (header.command.toUpperCase()) {
            case "LOGIN":
                var data = PacketModels.login.parse(datapacket);
                User.login(data.username, data.password, function (result, user) {
                    if (result) {
                        c.user = user;
                        c.enterroom(c.user.current_room);
                        // if (this.showlogs)console.log("Interpret: enterroom should have been called");

                        /*     if (c.user && c.user.current_room) {
                                c.broadcastroom(packet.build(["LEAVE", c.user.username]), c.user.current_room);
                            }; */
                            if (c.user.hp < 0) {
                                c.user.hp = 0; // Ensure HP is not negative
                            }
                            c.socket.send(packet.build([
                                "LOGIN", "TRUE",
                                c.user.current_room,
                                c.user.pos_x,
                                c.user.pos_y,
                                c.user.username,
                                c.user.experience,
                                c.user.hp,
                                c.user.mana,
                                c.user.stanima,
                                c.user.money,
                                c.user.weapon,
                                Number(c.user.shield) || 0,
                                c.user.hat,
                                c.user.top,
                                c.user.trousers,
                                c.user.ring1,
                                c.user.ring2,
                                c.user.ring3,
                                c.user.ring4,
                                c.user.amulet,
                                c.user.shoes,
                                c.user.gloves,
                                c.user.cape,
                                c.user.item1,
                                c.user.item2,
                                c.user.item3,
                                c.user.item4,
                                c.user.item5,
                                c.user.item6,
                                c.user.item7,
                                c.user.item8,
                                c.user.item9,
                                c.user.item10,
                                c.user.item11,
                                c.user.item12,

                                c.user.status,
                                c.user.trousers_colour,
                                c.user.top_colour,
                                c.user.skin_colour,
                                c.user.hair_colour,
                                c.user.hair,
                                c.user.hpExperience,
                                c.user.meleeExperience,
                                c.user.defenceExperience,
                                c.user.farmingExperience,
                                c.user.cookingExperience,
                                c.user.miningExperience,
                                c.user.choppingExperience,
                                c.user.smithingExperience || "0",
                                c.user.fishingExperience || "0"

                            ]));

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

            case "POS":
                var data = PacketModels.pos.parse(datapacket);

                var exactX = Number(data.exact_x);
                var exactY = Number(data.exact_y);
                var projectedX = Number(data.projected_x);
                var projectedY = Number(data.projected_y);
                if (!Number.isFinite(exactX)) exactX = 0;
                if (!Number.isFinite(exactY)) exactY = 0;
                if (!Number.isFinite(projectedX)) projectedX = exactX;
                if (!Number.isFinite(projectedY)) projectedY = exactY;

                // ----- 1. Update user position -----
                c.user.pos_x = exactX;
                c.user.pos_y = exactY;

                // ----- 2. Reset / start the 5-second inactivity timer -----
                // Clear any previous timer for this user
                if (c.user.positionTimeout) {
                    clearTimeout(c.user.positionTimeout);
                }

                // Create a new 5-second timer
                if (c.user.username !="AAA") {// Exclude admin user from timeout
                    c.user.positionTimeout = setTimeout(() => {
                    //    console.log(`[POS TIMEOUT] No position update from ${c.user.username} for 5 seconds â€“ closing connection`);
                        c.socket.close();          // Force-close the WebSocket
                        c.end();                   // Run your existing disconnect logic (LEAVE broadcast, room cleanup)
                    }, 15000);                      // 15 seconds
                }
                // ----- 3. Save position (debounced) -----
                if (!c.user._savePromise) {
                    c.user._savePromise = c.user.save()
                        .catch(err => {
                            // console.error("Failed to save user position:", err);
                        })
                        .finally(() => {
                            c.user._savePromise = null;
                        });
                } else {
                    // console.warn("Skipped save: already saving", c.user.username);
                }

                // ----- 4. Broadcast to other clients -----
                c.broadcastroom(packet.build([
                    "POS",
                    c.user.username,
                    projectedX,
                    projectedY,
                    data.animation,
                    data.direction
                ]));
                break;

            case "ATTACK": // Player attack
                var data = PacketModels.attack.parse(datapacket);
                c.broadcastroom(packet.build(["ATTACK", c.user.username, data.damage, data.face, data.target_name, data.source_name, data.style, data.attack_target_x, data.attack_target_y]));
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

            case "PFX":
                var data = PacketModels.pfx.parse(datapacket);
                c.broadcastroom(packet.build(["PFX", data.user, data.kind, data.target_x, data.target_y, data.item]));
                break;

            case "NPC": // NPC location and status
                var data = PacketModels.npc.parse(datapacket);
                c.broadcastroom(packet.build(["NPC", data.object, data.name, data.target_x, data.target_y, data.status, data.player_name]));
                break;

            case "NPCX":
                // if (this.showlogs) console.log("Processing NPCX packet");
                var npcData = PacketModels.npcx.parse(datapacket);
                var npcs = [];
                var NPCX_COUNT = 8; // Number of NPCs in NPCX packet

                for (let i = 1; i <= NPCX_COUNT; i++) {
                    npcs.push({
                        name: npcData[`name${i}`],
                        target_x: npcData[`target_x${i}`],
                        target_y: npcData[`target_y${i}`]
                    });
                }
                // if (this.showlogs) console.log("NPCX NPCs: ", JSON.stringify(npcs, null, 2));
                npcs.forEach((npc, index) => {
                if (npc.name !== "" && npc.name !== "skip") {
                    const targetX = npc.target_x < 0 ? 0 : npc.target_x;
                    const targetY = npc.target_y < 0 ? 0 : npc.target_y;

                    setTimeout(() => {
                        c.broadcastroom(packet.build([
                            "NPC",
                            npcData.object,
                            npc.name,
                            targetX,
                            targetY,
                            "alive",
                            "non"
                        ]));
                    }, index * 1000/ NPCX_COUNT); // Spread out updates
                }
            });

                break;

            case "CHANGE": // Request a change
                var data = PacketModels.change.parse(datapacket);
                c.broadcastroom(packet.build(["CHANGE", data.name, data.variable, data.value, data.amount, data.action]));
                break;

            case "FISHING":
                var data = PacketModels.fishing.parse(datapacket);
                c.broadcastroom(packet.build(["FISHING", data.name, data.target_x, data.target_y, data.direction, data.action]));
                break;

            case "FISHSPOT":
                handleFishSpotPacket(c, datapacket);
                break;

            case "ACCEPT": // Save changes to the database
                try {
                    var data = PacketModels.accept.parse(datapacket);
                    c.broadcastroom(packet.build(["ACCEPT", data.name, data.variable, data.value]));

                    // Dynamically set the user property
                    if (data.variable in c.user) {
                        c.user[data.variable] = data.value;

                        const attemptSave = () => {
                            if (!c.user._savePromise) {
                                c.user._savePromise = c.user.save()
                                    .catch(err => {
                                        // console.error("Failed to save user data:", err);
                                    })
                                    .finally(() => {
                                        c.user._savePromise = null;
                                    });
                            } else {
                                // console.warn("Save already in progress, retrying in 0.5s for user:", c.user.username);
                                setTimeout(attemptSave, 500); // Retry after 0.5 sec
                            }
                        };

                        attemptSave(); // Start the first attempt

                    } else {
                        // console.warn("Unknown user property received in ACCEPT:", data.variable);
                    }
                } catch (error) {
                    // console.error("Error processing ACCEPT packet:", error);
                    // Optionally notify client of failure
                    // c.send(packet.build(["ERROR", "Failed to process ACCEPT"]));
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

            case "HOUSE":
                var data = PacketModels.house.parse(datapacket);
                c.broadcastroom(packet.build(["HOUSE", data.target_x, data.target_y, data.config, data.user_name]));
                break;

            case "BIND":
                var data = PacketModels.bind.parse(datapacket);
                c.broadcastuser(data.target_name, packet.build(["BIND", c.user.username, data.target_npc, data.action]));
                break;

            case "SHOP":
                var data = PacketModels.shop.parse(datapacket);
                c.broadcastuser(data.target_name, packet.build(["SHOP", c.user.username, data.target_npc, data.item, data.amount, data.price, data.action]));
                break;

            case "BANK":
                handleBankPacket(c, datapacket);
                break;

            default:
                // console.log("Unknown command: " + header.command);
        }
    }
};
