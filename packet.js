// Updated packet.js to work with modern Node.js Buffer API and WebSocket communications
let requestGraph = null;
let packet;
try {
    requestGraph = require('./requestGraph.js');
} catch (error) {
    requestGraph = null;
}

const townJobConfig = require('./Resources/townJobs.js');

const BANK_SLOT_LIMIT = 50;
const BANK_STACK_LIMIT = 2000000;
const INVENTORY_SLOT_COUNT = 12;
const TRADE_DISTANCE_LIMIT = 96;
const TRADE_TIMEOUT_MS = 120000;
const PACKET_LENGTH_BYTES = 2;
const MAX_PACKET_SIZE = 65535;
const BANK_DEBUG = false;
const TOWN_JOB_COUNTS = { low: 3, mid: 2, high: 1 };
const WHISTLE_ITEM = "11179";
const WHISTLE_PRICE = 100;
const PET_HORSE_REPUTATION = 25;
const PET_DOG_REPUTATION = 50;
const PET_SPAWN_DISTANCE = 400;
const OBJ_HORSE = "19";
const OBJ_DOG = "20";
const PET_FOOD_RESTORE = 25;
const PET_REVIVE_FOOD_COST = 5;
const PET_HORSE_SKIN_COUNT = 8;
const PET_HORSE_FOODS = new Set(["11123", "11131", "11169"]); // wheat, corn, carrot
const PET_DOG_FOODS = new Set([
    "11126", "11127", "11139", "11140", "11148", "11149",
    "11171", "11172", "11174", "11175"
]);
const NON_STACKABLE_ITEMS = new Set([
    "11112", // Sword
    "11160", // Long sword
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
    "11159", // Iron platelegs
    "11161", // Mithril helmet
    "11162", // Mithril platebody
    "11163", // Mithril platelegs
    "11164", // Mithril shield
    "11165", // Adamant helmet
    "11166", // Adamant platebody
    "11167", // Adamant platelegs
    "11168", // Adamant shield
    "11179"  // Whistle
]);
const ADMIN_BOOTSTRAP_USERNAME = "AAA";
const HOUSE_MASTER_USERNAME = ADMIN_BOOTSTRAP_USERNAME;
const ADMIN_MAX_GRANT_AMOUNT = BANK_STACK_LIMIT;
const ADMIN_SKILL_FIELDS = new Set([
    "experience",
    "hpExperience",
    "meleeExperience",
    "defenceExperience",
    "farmingExperience",
    "cookingExperience",
    "miningExperience",
    "choppingExperience",
    "fishingExperience",
    "buildingExperience",
    "smithingExperience"
]);
const sessionFishSpotsByRoom = {};

function clampInt(value, min, max) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return min;
    return Math.max(min, Math.min(max, parsed));
}

function packetLog(message) {
    console.warn(`[packet] ${message}`);
}

function writePacketLength(totalLength) {
    const size = Buffer.alloc(PACKET_LENGTH_BYTES);
    size.writeUInt16LE(totalLength, 0);
    return size;
}

function buildPacketErrorBuffer(message) {
    const parts = [
        Buffer.from("ERROR\0", "utf8"),
        Buffer.from(String(message || "Packet build failed") + "\0", "utf8")
    ];
    const payloadSize = parts.reduce((total, part) => total + part.length, 0);
    const totalLength = payloadSize + PACKET_LENGTH_BYTES;
    return Buffer.concat([writePacketLength(totalLength)].concat(parts), totalLength);
}

function buildPacketFromParts(command, packetParts, packetSize) {
    const totalLength = packetSize + PACKET_LENGTH_BYTES;
    if (totalLength > MAX_PACKET_SIZE) {
        packetLog(`Dropping ${command} packet: ${totalLength} bytes exceeds ${MAX_PACKET_SIZE}`);
        return buildPacketErrorBuffer(`${command} packet too large`);
    }

    const dataBuffer = Buffer.concat(packetParts, packetSize);
    return Buffer.concat([writePacketLength(totalLength), dataBuffer], totalLength);
}

function writePacketNumber(command, index, param) {
    const parsed = Math.floor(Number(param));
    const buffer = Buffer.alloc(2);

    if (!Number.isFinite(parsed)) {
        packetLog(`Clamped non-finite numeric param ${index} in ${command} to 0`);
        buffer.writeUInt16LE(0, 0);
        return buffer;
    }

    if (parsed < 0) {
        const value = clampInt(parsed, -32768, -1);
        if (value !== parsed) packetLog(`Clamped signed numeric param ${index} in ${command} from ${parsed} to ${value}`);
        buffer.writeInt16LE(value, 0);
        return buffer;
    }

    const value = clampInt(parsed, 0, 65535);
    if (value !== parsed) packetLog(`Clamped unsigned numeric param ${index} in ${command} from ${parsed} to ${value}`);
    buffer.writeUInt16LE(value, 0);
    return buffer;
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

function countAnyInventoryItem(inventory, allowedItems) {
    return inventory.reduce((total, slot) => {
        return allowedItems.has(String(slot.item)) ? total + clampInt(slot.amount, 0, BANK_STACK_LIMIT) : total;
    }, 0);
}

function removeAnyInventoryItems(inventory, allowedItems, amount) {
    let remaining = clampInt(amount, 0, BANK_STACK_LIMIT);
    let removed = 0;

    for (const slot of inventory) {
        if (remaining <= 0) break;
        if (!allowedItems.has(String(slot.item)) || slot.amount <= 0) continue;
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

function isAdminUser(user) {
    return !!(user && (user.isAdmin || user.username === ADMIN_BOOTSTRAP_USERNAME));
}

function futureDateFromHours(hours) {
    const parsed = Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return new Date(Date.now() + Math.floor(parsed * 60 * 60 * 1000));
}

function parseAdminPositiveInt(value, max) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(max, parsed);
}

function isRestrictionActive(user, prefix, now = new Date()) {
    if (!user) return false;
    if (user[`${prefix}Permanent`]) return true;
    const expiresAt = user[`${prefix}ExpiresAt`];
    if (!expiresAt) return false;
    const expiry = new Date(expiresAt);
    if (Number.isNaN(expiry.getTime())) return false;
    if (expiry > now) return true;

    user[`${prefix}ExpiresAt`] = null;
    return false;
}

function restrictionText(user, prefix) {
    if (!user) return "0";
    if (user[`${prefix}Permanent`]) return "permanent";
    const expiresAt = user[`${prefix}ExpiresAt`];
    if (!expiresAt) return "0";
    const expiry = new Date(expiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) return "0";
    return expiry.toISOString();
}

function getAllOnlineClients() {
    const clients = [];
    const seen = new Set();
    Object.keys(maps || {}).forEach(roomName => {
        const room = maps[roomName];
        if (!room || !Array.isArray(room.clients)) return;
        room.clients.forEach(client => {
            if (!client || !client.user || !client.user.username) return;
            if (seen.has(client.user.username)) return;
            seen.add(client.user.username);
            clients.push(client);
        });
    });
    return clients;
}

function findOnlineClientByUsername(username) {
    const targetName = String(username || "").toLowerCase();
    if (!targetName) return null;
    return getAllOnlineClients().find(client => String(client.user.username || "").toLowerCase() === targetName) || null;
}

function sendAdminPacket(c, params) {
    if (!c || !c.socket) return;
    c.socket.send(packet.build(["ADMIN"].concat(params.map(value => String(value)))));
}

function sendAdminError(c, message) {
    sendAdminPacket(c, ["ERROR", String(message || "Admin action failed")]);
}

function sendAdminOk(c, message) {
    sendAdminPacket(c, ["OK", String(message || "Done")]);
}

function sendAdminList(c) {
    sendAdminPacket(c, ["START"]);
    getAllOnlineClients()
        .sort((a, b) => String(a.user.username).localeCompare(String(b.user.username)))
        .forEach(client => {
            const user = client.user;
            sendAdminPacket(c, [
                "USER",
                user.username,
                user.current_room || "",
                isAdminUser(user) ? "1" : "0",
                isRestrictionActive(user, "mute") ? restrictionText(user, "mute") : "0",
                isRestrictionActive(user, "ban") ? restrictionText(user, "ban") : "0"
            ]);
        });
    sendAdminPacket(c, ["END"]);
}

function cloneNormalizedBank(user) {
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
    return merged;
}

function bankCapacityForItem(bank, item) {
    const itemId = String(item);
    let capacity = 0;
    for (const slot of bank) {
        if (slot.item === itemId) capacity += Math.max(0, BANK_STACK_LIMIT - clampInt(slot.amount, 0, BANK_STACK_LIMIT));
    }
    capacity += Math.max(0, BANK_SLOT_LIMIT - bank.length) * BANK_STACK_LIMIT;
    return capacity;
}

function addToBankClone(bank, item, amount) {
    const itemId = String(item);
    let remaining = clampInt(amount, 0, BANK_STACK_LIMIT);
    let added = 0;
    for (const slot of bank) {
        if (remaining <= 0) break;
        if (slot.item !== itemId) continue;
        const add = Math.min(BANK_STACK_LIMIT - clampInt(slot.amount, 0, BANK_STACK_LIMIT), remaining);
        if (add <= 0) continue;
        slot.amount += add;
        added += add;
        remaining -= add;
    }
    while (remaining > 0 && bank.length < BANK_SLOT_LIMIT) {
        const add = Math.min(BANK_STACK_LIMIT, remaining);
        bank.push({ item: itemId, amount: add });
        added += add;
        remaining -= add;
    }
    return added;
}

function applyItemGrantToUser(user, item, amount) {
    const itemId = String(item || "0");
    const grantAmount = clampInt(amount, 1, ADMIN_MAX_GRANT_AMOUNT);
    if (itemId === "0" || grantAmount <= 0) return { ok: false, message: "Invalid item grant" };

    const inventory = readInventory(user).map(slot => ({ item: slot.item, amount: slot.amount }));
    const bank = cloneNormalizedBank(user);
    const inventoryCapacity = inventoryCapacityForItem(inventory, itemId);
    const bankCapacity = bankCapacityForItem(bank, itemId);
    if (inventoryCapacity + bankCapacity < grantAmount) {
        return { ok: false, message: "Target does not have enough inventory or bank space" };
    }

    const addedToInventory = addToInventory(inventory, itemId, grantAmount);
    const remaining = grantAmount - addedToInventory;
    const addedToBank = remaining > 0 ? addToBankClone(bank, itemId, remaining) : 0;
    if (addedToInventory + addedToBank !== grantAmount) {
        return { ok: false, message: "Could not apply full item grant" };
    }

    writeInventory(user, inventory);
    user.bank = bank;
    if (typeof user.markModified === "function") user.markModified("bank");
    return { ok: true, inventory, bankChanged: addedToBank > 0 };
}

function syncGrantedItemToOnlineClient(targetClient, grantResult) {
    if (!targetClient || !targetClient.socket || !targetClient.user || !grantResult || !grantResult.ok) return;
    sendInventorySnapshot(targetClient, grantResult.inventory || readInventory(targetClient.user));
    if (grantResult.bankChanged) sendBankSnapshot(targetClient, "OK", "Admin grant added items to your bank");
}

function syncGrantedExpToOnlineClient(targetClient, skill, value) {
    if (!targetClient || !targetClient.socket || !targetClient.user) return;
    targetClient.socket.send(packet.build(["ACCEPT", targetClient.user.username, String(skill), String(value)]));
}

function normalizeAdminSkillField(skill) {
    const value = String(skill || "");
    if (ADMIN_SKILL_FIELDS.has(value)) return value;
    const candidate = `${value}Experience`;
    return ADMIN_SKILL_FIELDS.has(candidate) ? candidate : "";
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

function sendMoneySnapshot(c) {
    if (!c || !c.socket || !c.user) return;
    c.socket.send(packet.build(["TRADE", "MONEY_SELF", String(clampInt(c.user.money || 0, 0, BANK_STACK_LIMIT))]));
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

function townJobDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function townJobHash(text) {
    let hash = 2166136261;
    const value = String(text || "");
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function townJobRandom(seedState) {
    seedState.value = (Math.imul(seedState.value, 1664525) + 1013904223) >>> 0;
    return seedState.value / 4294967296;
}

function normalizeTownJobOffer(job, tier) {
    return {
        id: String(job.id),
        tier: String(tier),
        item: String(job.item),
        amount: clampInt(job.amount, 1, BANK_STACK_LIMIT),
        money: clampInt(job.money, 0, BANK_STACK_LIMIT),
        reputation: clampInt(job.reputation, 0, BANK_STACK_LIMIT),
        requiredChariotLevel: clampInt(job.requiredChariotLevel || 0, 0, BANK_STACK_LIMIT)
    };
}

function pickTownJobsForTier(username, dateKey, tier, count) {
    const source = Array.isArray(townJobConfig[tier]) ? townJobConfig[tier] : [];
    const jobs = source.map(job => normalizeTownJobOffer(job, tier));
    const seedState = { value: townJobHash(`${username}|${dateKey}|${tier}`) };

    for (let i = jobs.length - 1; i > 0; i--) {
        const j = Math.floor(townJobRandom(seedState) * (i + 1));
        const tmp = jobs[i];
        jobs[i] = jobs[j];
        jobs[j] = tmp;
    }

    return jobs.slice(0, Math.min(count, jobs.length));
}

function generateTownJobOffers(username, dateKey) {
    return []
        .concat(pickTownJobsForTier(username, dateKey, "low", TOWN_JOB_COUNTS.low))
        .concat(pickTownJobsForTier(username, dateKey, "mid", TOWN_JOB_COUNTS.mid))
        .concat(pickTownJobsForTier(username, dateKey, "high", TOWN_JOB_COUNTS.high));
}

function pickReplacementTownJob(username, townJobs, completedOffer) {
    const tier = String(completedOffer.tier || "low");
    const source = Array.isArray(townJobConfig[tier]) ? townJobConfig[tier] : [];
    const activeIds = new Set((townJobs.offers || [])
        .filter(offer => String(offer.id) !== String(completedOffer.id))
        .map(offer => String(offer.id)));
    const candidates = source
        .map(job => normalizeTownJobOffer(job, tier))
        .filter(job => !activeIds.has(String(job.id)) && String(job.id) !== String(completedOffer.id));

    if (candidates.length <= 0) return null;

    const seedState = {
        value: townJobHash(`${username}|${townJobs.dateKey}|${tier}|${completedOffer.id}|${Date.now()}`)
    };
    const index = Math.floor(townJobRandom(seedState) * candidates.length);
    return candidates[index];
}

function replaceCompletedTownJob(user, townJobs, completedOffer) {
    const index = townJobs.offers.findIndex(entry => String(entry.id) === String(completedOffer.id));
    if (index < 0) return false;

    const replacement = pickReplacementTownJob(user.username, townJobs, completedOffer);
    if (!replacement) return false;

    townJobs.offers[index] = replacement;
    townJobs.completed = Array.isArray(townJobs.completed)
        ? townJobs.completed.filter(id => String(id) !== String(completedOffer.id))
        : [];
    return true;
}

function normalizeTownReputation(user) {
    user.townReputation = clampInt(user.townReputation || 0, 0, BANK_STACK_LIMIT);
    return user.townReputation;
}

function normalizeTownJobPendingReward(pendingReward) {
    if (!pendingReward || typeof pendingReward !== "object" || !pendingReward.id) return null;
    return {
        id: String(pendingReward.id),
        tier: String(pendingReward.tier || "low"),
        item: String(pendingReward.item || "0"),
        amount: clampInt(pendingReward.amount, 1, BANK_STACK_LIMIT),
        money: clampInt(pendingReward.money, 0, BANK_STACK_LIMIT),
        reputation: clampInt(pendingReward.reputation, 0, BANK_STACK_LIMIT),
        requiredChariotLevel: clampInt(pendingReward.requiredChariotLevel || 0, 0, BANK_STACK_LIMIT),
        dateKey: String(pendingReward.dateKey || "")
    };
}

function ensureTownJobs(user) {
    const dateKey = townJobDateKey();
    let changed = false;
    const townJobs = user.townJobs && typeof user.townJobs === "object" ? user.townJobs : {};
    const completed = Array.isArray(townJobs.completed) ? townJobs.completed.map(String) : [];
    const offers = Array.isArray(townJobs.offers) ? townJobs.offers : [];
    const pendingReward = normalizeTownJobPendingReward(townJobs.pendingReward);

    if (townJobs.dateKey !== dateKey || offers.length !== 6) {
        user.townJobs = {
            dateKey,
            offers: generateTownJobOffers(user.username, dateKey),
            completed: [],
            pendingReward
        };
        changed = true;
    } else {
        user.townJobs = {
            dateKey,
            offers: offers.map(offer => normalizeTownJobOffer(offer, offer.tier || "low")),
            completed,
            pendingReward
        };
        changed = true;
    }

    normalizeTownReputation(user);
    if (changed && typeof user.markModified === "function") user.markModified("townJobs");
    return user.townJobs;
}

function sendTownJobError(c, message) {
    if (c && c.socket) c.socket.send(packet.build(["TOWNJOB", "ERROR", String(message || "Job board request failed")]));
}

function sendTownJobSnapshot(c) {
    const townJobs = ensureTownJobs(c.user);
    const completed = Array.isArray(townJobs.completed) ? townJobs.completed.map(String) : [];
    const pendingReward = normalizeTownJobPendingReward(townJobs.pendingReward);

    c.socket.send(packet.build(["TOWNJOB", "START", String(normalizeTownReputation(c.user)), String(townJobs.dateKey || "")]));
    townJobs.offers.forEach(function(offer) {
        c.socket.send(packet.build([
            "TOWNJOB",
            "OFFER",
            String(offer.id),
            String(offer.tier),
            String(offer.item),
            String(offer.amount),
            String(offer.money),
            String(offer.reputation),
            String(offer.requiredChariotLevel || 0),
            completed.indexOf(String(offer.id)) >= 0 ? "1" : "0"
        ]));
    });
    if (pendingReward) {
        c.socket.send(packet.build(["TOWNJOB", "PENDING", String(pendingReward.id), String(pendingReward.tier)]));
    }
    c.socket.send(packet.build(["TOWNJOB", "END"]));
}

function saveUserQueued(c, afterSave, onError) {
    const attemptSave = () => {
        if (c.user._savePromise) {
            setTimeout(attemptSave, 100);
            return;
        }

        const savePromise = c.user.save();
        if (savePromise && typeof savePromise.then === "function") {
            c.user._savePromise = savePromise
                .then(() => {
                    if (typeof afterSave === "function") afterSave();
                })
                .catch(error => {
                    if (typeof onError === "function") onError(error);
                })
                .finally(() => {
                    c.user._savePromise = null;
                });
        } else if (typeof afterSave === "function") {
            afterSave();
        }
    };

    attemptSave();
}

function townJobPendingFromOffer(offer, dateKey) {
    return {
        id: String(offer.id),
        tier: String(offer.tier || "low"),
        item: String(offer.item),
        amount: clampInt(offer.amount, 1, BANK_STACK_LIMIT),
        money: clampInt(offer.money, 0, BANK_STACK_LIMIT),
        reputation: clampInt(offer.reputation, 0, BANK_STACK_LIMIT),
        requiredChariotLevel: clampInt(offer.requiredChariotLevel || 0, 0, BANK_STACK_LIMIT),
        dateKey: String(dateKey || "")
    };
}

function handleTownJobPacket(c, datapacket) {
    try {
        if (!c.user) {
            sendTownJobError(c, "Not logged in");
            return;
        }

        const data = PacketModels.townjob.parse(datapacket);
        const action = String(data.action || "").toUpperCase();

        if (action === "OPEN") {
            ensureTownJobs(c.user);
            saveUserQueued(c, null, null);
            sendTownJobSnapshot(c);
            return;
        }

        const townJobs = ensureTownJobs(c.user);
        const jobId = String(data.job_id || "");

        if (action === "CLAIM") {
            const pendingReward = normalizeTownJobPendingReward(townJobs.pendingReward);
            if (!pendingReward) {
                sendTownJobError(c, "No reward chest is waiting");
                return;
            }
            if (jobId && jobId !== "0" && String(pendingReward.id) !== jobId) {
                sendTownJobError(c, "That reward chest is no longer waiting");
                return;
            }

            c.user.money = Math.min(BANK_STACK_LIMIT, clampInt(c.user.money || 0, 0, BANK_STACK_LIMIT) + clampInt(pendingReward.money, 0, BANK_STACK_LIMIT));
            c.user.townReputation = Math.min(BANK_STACK_LIMIT, normalizeTownReputation(c.user) + clampInt(pendingReward.reputation, 0, BANK_STACK_LIMIT));
            replaceCompletedTownJob(c.user, townJobs, pendingReward);
            townJobs.pendingReward = null;
            townJobs.completed = Array.isArray(townJobs.completed)
                ? townJobs.completed.filter(id => String(id) !== String(pendingReward.id))
                : [];
            c.user.townJobs = townJobs;
            if (typeof c.user.markModified === "function") c.user.markModified("townJobs");

            saveUserQueued(
                c,
                () => {
                    sendTownJobSnapshot(c);
                    c.socket.send(packet.build([
                        "TOWNJOB",
                        "DONE",
                        String(pendingReward.id),
                        String(pendingReward.money),
                        String(pendingReward.reputation),
                        String(c.user.money),
                        String(c.user.townReputation)
                    ]));
                },
                () => sendTownJobError(c, "Could not save job reward")
            );
            return;
        }

        if (action !== "PREPARE" && action !== "COMPLETE") {
            sendTownJobError(c, "Unknown job board action");
            return;
        }

        const existingPending = normalizeTownJobPendingReward(townJobs.pendingReward);
        if (existingPending) {
            if (!jobId || jobId === "0" || String(existingPending.id) === jobId) {
                c.socket.send(packet.build(["TOWNJOB", "READY", String(existingPending.id), String(existingPending.tier)]));
            } else {
                sendTownJobError(c, "Open your waiting reward chest first");
            }
            return;
        }

        const offer = townJobs.offers.find(entry => String(entry.id) === jobId);
        if (!offer) {
            sendTownJobError(c, "That job is no longer posted");
            return;
        }

        townJobs.completed = Array.isArray(townJobs.completed) ? townJobs.completed.map(String) : [];
        if (townJobs.completed.indexOf(jobId) >= 0) {
            sendTownJobError(c, "That job is already complete");
            return;
        }

        const chariotLevel = clampInt(data.chariot_level || 0, 0, BANK_STACK_LIMIT);
        const requiredChariotLevel = clampInt(offer.requiredChariotLevel || 0, 0, BANK_STACK_LIMIT);
        if (requiredChariotLevel > 0 && chariotLevel < requiredChariotLevel) {
            sendTownJobError(c, `You need a level ${requiredChariotLevel} chariot for that job`);
            return;
        }

        const inventory = readInventory(c.user);
        const requiredItem = String(offer.item);
        const requiredAmount = clampInt(offer.amount, 1, BANK_STACK_LIMIT);
        if (countInventoryItem(inventory, requiredItem) < requiredAmount) {
            sendTownJobError(c, "You do not have the requested goods");
            return;
        }

        const removed = removeFromInventory(inventory, requiredItem, requiredAmount);
        if (removed < requiredAmount) {
            sendTownJobError(c, "Could not collect the requested goods");
            return;
        }

        writeInventory(c.user, inventory);
        townJobs.pendingReward = townJobPendingFromOffer(offer, townJobs.dateKey);
        c.user.townJobs = townJobs;
        if (typeof c.user.markModified === "function") c.user.markModified("townJobs");

        saveUserQueued(
            c,
            () => {
                sendInventorySnapshot(c, inventory);
                sendTownJobSnapshot(c);
                c.socket.send(packet.build(["TOWNJOB", "READY", String(offer.id), String(offer.tier)]));
            },
            () => sendTownJobError(c, "Could not save reward chest")
        );
    } catch (error) {
        sendTownJobError(c, "Job board request failed");
    }
}

function getSessionFishSpots(room) {
    const roomKey = String(room || "");
    if (!sessionFishSpotsByRoom[roomKey]) sessionFishSpotsByRoom[roomKey] = [];
    return sessionFishSpotsByRoom[roomKey];
}

function clampFishSpotRemaining(value) {
    return clampInt(value, 0, 150);
}

function normalizeFishSpotType(value) {
    const fishType = String(value || "anchovy").toLowerCase();
    return fishType === "trout" || fishType === "salmon" ? fishType : "anchovy";
}

function readPacketStrings(buffer) {
    const fields = [];
    let start = PACKET_LENGTH_BYTES;
    for (let i = PACKET_LENGTH_BYTES; i < buffer.length; i++) {
        if (buffer[i] === 0) {
            fields.push(buffer.slice(start, i).toString("utf8"));
            start = i + 1;
        }
    }
    return fields;
}

function broadcastRoomIncluding(room, packetData) {
    if (typeof maps === "undefined" || !maps[room] || !Array.isArray(maps[room].clients)) return;
    maps[room].clients.forEach(function(otherClient) {
        if (otherClient && otherClient.socket) {
            otherClient.socket.send(packetData);
        }
    });
}

function parseHouseConfigPlaceId(configValue) {
    const configText = String(configValue || "");
    const separator = configText.indexOf("|");
    const placeId = separator >= 0 ? configText.slice(0, separator) : configText;
    return placeId && placeId !== "0" ? placeId : "";
}

function sendHouseError(c, message) {
    if (c && c.socket) c.socket.send(packet.build(["HOUSE", "ERROR", String(message || "House action failed")]));
}

function sendHouseDirty(room) {
    const master = findOnlineClientByUsername(HOUSE_MASTER_USERNAME);
    if (master && master.socket) {
        master.socket.send(packet.build(["HOUSE", "DIRTY", String(room || "")]));
    }
}

function sendHouseList(c, room) {
    if (!c || !c.socket) return;
    if (typeof House === "undefined") {
        sendHouseError(c, "House model is not loaded");
        return;
    }

    const roomName = String(room || (c.user && c.user.current_room) || "");
    House.find({ room: roomName }).sort({ createdAt: 1 }).exec(function(err, houses) {
        if (err) {
            sendHouseError(c, "Could not load houses");
            return;
        }
        (houses || []).forEach(function(house) {
            c.socket.send(packet.build([
                "HOUSE",
                "SYNC",
                String(Math.round(Number(house.x) || 0)),
                String(Math.round(Number(house.y) || 0)),
                String(house.config || ""),
                String(house.ownerUsername || ""),
                ""
            ]));
        });
        c.socket.send(packet.build(["HOUSE", "END", roomName]));
    });
}

function handleHousePacket(c, datapacket) {
    if (!c.user) return;
    const rawFields = readPacketStrings(datapacket);
    const action = String(rawFields[1] || "").toUpperCase();
    const room = String(c.user.current_room || "");

    if (action === "LIST") {
        if (String(c.user.username || "") !== HOUSE_MASTER_USERNAME && !isAdminUser(c.user)) {
            sendHouseError(c, "House list permission required");
            return;
        }
        sendHouseList(c, rawFields[2] && rawFields[2] !== "0" ? rawFields[2] : room);
        return;
    }

    if (action === "SYNC") {
        if (String(c.user.username || "") !== HOUSE_MASTER_USERNAME && !isAdminUser(c.user)) {
            sendHouseError(c, "House sync permission required");
            return;
        }
        const syncPacket = packet.build([
            "HOUSE",
            "SYNC",
            rawFields[2] || "0",
            rawFields[3] || "0",
            rawFields[4] || "",
            rawFields[5] || "",
            rawFields[6] || ""
        ]);
        broadcastRoomIncluding(room, syncPacket);
        return;
    }

    if (action === "DESTROY") {
        if (typeof House === "undefined") {
            sendHouseError(c, "House model is not loaded");
            return;
        }
        const placeId = String(rawFields[2] || "");
        if (!placeId || placeId === "0") {
            sendHouseError(c, "Missing house id");
            return;
        }
        House.findOne({ placeId: placeId }, function(err, house) {
            if (err || !house) {
                sendHouseError(c, "House not found");
                return;
            }
            const ownsHouse = house.owner && c.user._id && String(house.owner) === String(c.user._id);
            if (!ownsHouse && !isAdminUser(c.user)) {
                sendHouseError(c, "You do not own that house");
                return;
            }
            const houseRoom = String(house.room || room);
            House.deleteOne({ placeId: placeId }, function(deleteErr) {
                if (deleteErr) {
                    sendHouseError(c, "Could not destroy house");
                    return;
                }
                broadcastRoomIncluding(houseRoom, packet.build(["HOUSE", "DESTROY", placeId]));
                sendHouseDirty(houseRoom);
            });
        });
        return;
    }

    if (action === "ERROR" || action === "DIRTY" || action === "END") return;

    if (typeof House === "undefined") {
        sendHouseError(c, "House model is not loaded");
        return;
    }

    const x = clampInt(rawFields[1], 0, 65535);
    const y = clampInt(rawFields[2], 0, 65535);
    const config = String(rawFields[3] || "");
    const placeId = parseHouseConfigPlaceId(config);
    if (!placeId) {
        sendHouseError(c, "Invalid house config");
        return;
    }

    House.findOne({ placeId: placeId }, function(findErr, existingHouse) {
        if (findErr) {
            sendHouseError(c, "Could not save house");
            return;
        }

        const house = existingHouse || new House({
            placeId: placeId,
            owner: c.user._id,
            ownerUsername: String(c.user.username || "")
        });
        const ownsHouse = house.owner && c.user._id && String(house.owner) === String(c.user._id);
        if (existingHouse && !ownsHouse && !isAdminUser(c.user)) {
            sendHouseError(c, "That house belongs to another player");
            return;
        }

        house.room = room;
        house.x = x;
        house.y = y;
        house.config = config;
        if (!house.ownerUsername) house.ownerUsername = String(c.user.username || "");

        house.save(function(err) {
            if (err || !house) {
                sendHouseError(c, "Could not save house");
                return;
            }
            const ownerName = String(house.ownerUsername || c.user.username || "");
            broadcastRoomIncluding(room, packet.build(["HOUSE", String(x), String(y), config, ownerName]));
            sendHouseDirty(room);
        });
    });
}

function petThreshold(type) {
    return type === "dog" ? PET_DOG_REPUTATION : PET_HORSE_REPUTATION;
}

function petDisplayName(type) {
    return type === "dog" ? "Town Dog" : "Town Horse";
}

function petObjectId(type) {
    return type === "dog" ? OBJ_DOG : OBJ_HORSE;
}

function petAllowedFoods(type) {
    return type === "dog" ? PET_DOG_FOODS : PET_HORSE_FOODS;
}

function normalizePetType(type) {
    const value = String(type || "").toLowerCase();
    return value === "dog" ? "dog" : value === "horse" ? "horse" : "";
}

function companionIdFor(user, type) {
    return `pet_${String(user.username || "player")}_${type}`;
}

function validHorseSkinIndex(value) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 && parsed < PET_HORSE_SKIN_COUNT;
}

function randomHorseSkinIndex() {
    return Math.floor(Math.random() * PET_HORSE_SKIN_COUNT);
}

function normalizeCompanion(userCompanion, user) {
    const type = normalizePetType(userCompanion && userCompanion.type);
    if (!type) return null;
    const statusRaw = String(userCompanion.status || "home");
    const status = statusRaw === "summoned" || statusRaw === "inactive" ? statusRaw : "home";
    if (userCompanion.hunger == null) user._companionDataDirty = true;
    const hunger = clampInt(userCompanion.hunger == null ? 100 : userCompanion.hunger, 0, 100);
    const affectionDefault = type === "dog" ? 100 : 0;
    const affection = clampInt(userCompanion.affection == null ? affectionDefault : userCompanion.affection, 0, 100);
    var skinIndex = -1;
    if (type === "horse") {
        if (validHorseSkinIndex(userCompanion.skinIndex)) {
            skinIndex = Math.floor(Number(userCompanion.skinIndex));
        } else {
            skinIndex = randomHorseSkinIndex();
            user._companionDataDirty = true;
        }
    }
    return {
        id: String(userCompanion.id || companionIdFor(user, type)),
        type,
        name: String(userCompanion.name || petDisplayName(type)),
        status,
        hunger,
        affection,
        skinIndex,
        summoned: status === "summoned",
        inactiveReason: status === "inactive" ? String(userCompanion.inactiveReason || "hunger") : ""
    };
}

function normalizeCompanions(user) {
    user._companionDataDirty = false;
    const source = Array.isArray(user.companions) ? user.companions : [];
    const byType = {};
    source.forEach(entry => {
        const normalized = normalizeCompanion(entry, user);
        if (normalized && !byType[normalized.type]) byType[normalized.type] = normalized;
    });
    user.companions = Object.keys(byType).map(type => byType[type]);
    if (typeof user.markModified === "function") user.markModified("companions");
    return user.companions;
}

function findCompanion(user, idOrType) {
    const companions = normalizeCompanions(user);
    const key = String(idOrType || "");
    return companions.find(entry => String(entry.id) === key || String(entry.type) === key);
}

function sendPetPacket(c, params) {
    if (c && c.socket) c.socket.send(packet.build(["PET"].concat(params.map(value => String(value)))));
}

function sendPetError(c, message) {
    sendPetPacket(c, ["ERROR", message || "Pet action failed", "0", "0"]);
}

function sendPetOk(c, message) {
    sendPetPacket(c, ["OK", message || "Done", "0", "0"]);
}

function sendPetList(c) {
    if (!c || !c.user) return;
    const companions = normalizeCompanions(c.user);
    sendPetPacket(c, ["START", String(normalizeTownReputation(c.user)), "0", "0"]);
    companions.forEach(entry => {
        sendPetPacket(c, [
            "COMPANION",
            entry.id,
            entry.type,
            entry.name,
            entry.status,
            String(entry.hunger),
            String(entry.affection),
            entry.inactiveReason || "",
            String(entry.skinIndex)
        ]);
    });
    sendPetPacket(c, ["END", "0", "0", "0"]);
    if (c.user._companionDataDirty) {
        c.user._companionDataDirty = false;
        c.user.save(function(err) {
            if (err) c.user._companionDataDirty = true;
        });
    }
}

function saveUserAndSendPets(c, message) {
    if (!c || !c.user) return;
    c.user.save(function(err) {
        if (err) {
            sendPetError(c, "Could not save pet changes");
            return;
        }
        if (message) sendPetOk(c, message);
        sendPetList(c);
    });
}

function broadcastPetState(c, companion, action, x, y) {
    if (!c || !c.user || !companion) return;
    const px = clampInt(x, 1, 999999);
    const py = clampInt(y, 1, 999999);
    const payload = [
        c.user.username,
        companion.id,
        companion.type,
        String(companion.hunger),
        String(companion.affection),
        String(companion.skinIndex)
    ].join("|");
    broadcastRoomIncluding(c.user.current_room, packet.build([
        "NPC",
        petObjectId(companion.type),
        companion.id,
        px,
        py,
        action,
        payload
    ]));
}

function markCompanionInactive(c, companion, reason, x, y) {
    companion.status = "inactive";
    companion.summoned = false;
    companion.inactiveReason = reason || "hunger";
    broadcastPetState(c, companion, "petDespawn", x || c.user.pos_x || 1, y || c.user.pos_y || 1);
}

function claimCompanion(c, type) {
    type = normalizePetType(type);
    if (!type) {
        sendPetError(c, "Unknown companion type");
        return;
    }
    if (normalizeTownReputation(c.user) < petThreshold(type)) {
        sendPetError(c, `You need ${petThreshold(type)} town reputation`);
        return;
    }
    if (findCompanion(c.user, type)) {
        sendPetError(c, `${petDisplayName(type)} already claimed`);
        return;
    }
    c.user.companions.push({
        id: companionIdFor(c.user, type),
        type,
        name: petDisplayName(type),
        status: "home",
        hunger: 100,
        affection: type === "dog" ? 100 : 0,
        skinIndex: type === "horse" ? randomHorseSkinIndex() : -1,
        summoned: false,
        inactiveReason: ""
    });
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    saveUserAndSendPets(c, `${petDisplayName(type)} claimed.`);
}

function buyWhistle(c) {
    if (normalizeTownReputation(c.user) < PET_HORSE_REPUTATION) {
        sendPetError(c, `You need ${PET_HORSE_REPUTATION} town reputation`);
        return;
    }
    const money = clampInt(c.user.money || 0, 0, BANK_STACK_LIMIT);
    if (money < WHISTLE_PRICE) {
        sendPetError(c, "You need 100 coins");
        return;
    }
    const inventory = readInventory(c.user);
    if (inventoryCapacityForItem(inventory, WHISTLE_ITEM) < 1) {
        sendPetError(c, "Not enough inventory space");
        return;
    }
    addToInventory(inventory, WHISTLE_ITEM, 1);
    writeInventory(c.user, inventory);
    c.user.money = money - WHISTLE_PRICE;
    c.user.save(function(err) {
        if (err) {
            sendPetError(c, "Could not buy whistle");
            return;
        }
        sendInventorySnapshot(c, inventory);
        c.socket.send(packet.build(["ACCEPT", c.user.username, "money", String(c.user.money)]));
        sendPetOk(c, "Bought whistle.");
        sendPetList(c);
    });
}

function callCompanion(c, companion, x, y) {
    if (!companion) {
        sendPetError(c, "Companion not found");
        return;
    }
    if (companion.status === "inactive") {
        sendPetError(c, "Pet Master must revive this companion");
        return;
    }
    if (companion.status === "summoned") {
        sendPetError(c, "Companion is already summoned");
        return;
    }
    const ownerX = clampInt(x || c.user.pos_x || 1, 1, 999999);
    const ownerY = clampInt(y || c.user.pos_y || 1, 1, 999999);
    const angle = ((Date.now() / 10) + ownerX + ownerY) % 360;
    const spawnX = Math.max(1, Math.round(ownerX + Math.cos(angle * Math.PI / 180) * PET_SPAWN_DISTANCE));
    const spawnY = Math.max(1, Math.round(ownerY + Math.sin(angle * Math.PI / 180) * PET_SPAWN_DISTANCE));
    companion.status = "summoned";
    companion.summoned = true;
    companion.inactiveReason = "";
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    c.user.save(function(err) {
        if (err) {
            sendPetError(c, "Could not summon companion");
            return;
        }
        broadcastPetState(c, companion, "petSummon", spawnX, spawnY);
        sendPetList(c);
    });
}

function sendHomeCompanion(c, companion) {
    if (!companion || companion.status !== "summoned") {
        sendPetError(c, "Companion is not summoned");
        return;
    }
    companion.status = "home";
    companion.summoned = false;
    companion.inactiveReason = "";
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    c.user.save(function(err) {
        if (err) {
            sendPetError(c, "Could not send companion home");
            return;
        }
        broadcastPetState(c, companion, "petDespawn", c.user.pos_x || 1, c.user.pos_y || 1);
        sendPetList(c);
    });
}

function autoHomeCompanion(c, companionId, ownerName) {
    if (!c || !c.user || String(c.user.username || "") !== ADMIN_BOOTSTRAP_USERNAME) {
        sendPetError(c, "Automatic companion dismissal requires the room master.");
        return;
    }

    const ownerClient = findOnlineClientByUsername(ownerName);
    if (!ownerClient || !ownerClient.user) {
        sendPetError(c, "Companion owner is not online.");
        return;
    }
    if (String(ownerClient.user.current_room || "") !== String(c.user.current_room || "")) {
        sendPetError(c, "Companion owner is not in this room.");
        return;
    }

    const companion = findCompanion(ownerClient.user, companionId);
    if (!companion || companion.type !== "horse" || companion.status !== "summoned") {
        sendPetError(c, "Summoned companion horse not found.");
        return;
    }

    const previousStatus = companion.status;
    const previousSummoned = companion.summoned;
    const previousInactiveReason = companion.inactiveReason;
    companion.status = "home";
    companion.summoned = false;
    companion.inactiveReason = "";
    if (typeof ownerClient.user.markModified === "function") ownerClient.user.markModified("companions");

    ownerClient.user.save(function(err) {
        if (err) {
            companion.status = previousStatus;
            companion.summoned = previousSummoned;
            companion.inactiveReason = previousInactiveReason;
            if (typeof ownerClient.user.markModified === "function") ownerClient.user.markModified("companions");
            sendPetError(c, "Could not send companion home.");
            return;
        }

        broadcastPetState(
            ownerClient,
            companion,
            "petDespawn",
            ownerClient.user.pos_x || 1,
            ownerClient.user.pos_y || 1
        );
        sendPetOk(ownerClient, "Your horse could not reach you and went home.");
        sendPetList(ownerClient);
    });
}

function feedCompanion(c, companion, item) {
    if (!companion || companion.status !== "summoned") {
        sendPetError(c, "Summon the companion first");
        return;
    }
    const food = String(item || "0");
    const allowed = petAllowedFoods(companion.type);
    if (!allowed.has(food)) {
        sendPetError(c, "That food does not help this companion");
        return;
    }
    if (clampInt(companion.hunger, 0, 100) >= 100) {
        sendPetError(c, "This companion is already full.");
        return;
    }
    if (c.petFeedPending) {
        sendPetError(c, "Feeding is already in progress.");
        return;
    }
    const equipped = decodeInventoryValue(c.user.weapon);
    if (equipped.item !== food || equipped.amount <= 0) {
        sendPetError(c, "Hold suitable food to feed this companion.");
        return;
    }

    const previousWeapon = String(c.user.weapon || "0");
    const previousHunger = companion.hunger;
    const nextWeapon = packInventoryValue(equipped.item, equipped.amount - 1);
    const nextHunger = Math.min(100, clampInt(companion.hunger, 0, 100) + PET_FOOD_RESTORE);
    c.petFeedPending = true;
    c.user.weapon = nextWeapon;
    companion.hunger = nextHunger;
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    c.user.save(function(err) {
        c.petFeedPending = false;
        if (err) {
            c.user.weapon = previousWeapon;
            companion.hunger = previousHunger;
            sendPetError(c, "Could not feed companion");
            return;
        }
        const weaponPacket = packet.build(["ACCEPT", c.user.username, "weapon", String(c.user.weapon || "0")]);
        c.socket.send(weaponPacket);
        c.broadcastroom(weaponPacket);
        sendPetOk(c, "Companion fed.");
        broadcastPetState(c, companion, "petUpdate", c.user.pos_x || 1, c.user.pos_y || 1);
        sendPetList(c);
    });
}

function petCompanion(c, companion) {
    if (!companion || companion.status !== "summoned" || companion.type !== "dog") {
        sendPetError(c, "Only your summoned dog wants petting");
        return;
    }
    companion.affection = Math.min(100, clampInt(companion.affection, 0, 100) + PET_FOOD_RESTORE);
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    saveUserAndSendPets(c, "Dog petted.");
}

function reviveCompanion(c, companion) {
    if (!companion || companion.status !== "inactive") {
        sendPetError(c, "This companion does not need reviving");
        return;
    }
    const allowed = petAllowedFoods(companion.type);
    const inventory = readInventory(c.user);
    if (countAnyInventoryItem(inventory, allowed) < PET_REVIVE_FOOD_COST) {
        sendPetError(c, `Pet Master needs ${PET_REVIVE_FOOD_COST} suitable food`);
        return;
    }
    removeAnyInventoryItems(inventory, allowed, PET_REVIVE_FOOD_COST);
    writeInventory(c.user, inventory);
    companion.status = "home";
    companion.summoned = false;
    companion.inactiveReason = "";
    companion.hunger = 75;
    companion.affection = companion.type === "dog" ? 75 : 0;
    if (typeof c.user.markModified === "function") c.user.markModified("companions");
    c.user.save(function(err) {
        if (err) {
            sendPetError(c, "Could not revive companion");
            return;
        }
        sendInventorySnapshot(c, inventory);
        sendPetOk(c, "Companion revived.");
        sendPetList(c);
    });
}

function handlePetPacket(c, datapacket) {
    if (!c || !c.user) return;
    const data = PacketModels.pet.parse(datapacket);
    const action = String(data.action || "").toUpperCase();
    const id = String(data.companion_id || "");

    if (action === "LIST") {
        sendPetList(c);
        return;
    }
    if (action === "CLAIM") {
        claimCompanion(c, id);
        return;
    }
    if (action === "BUY_WHISTLE") {
        if (String(data.value || "") !== "PET_MASTER") {
            sendPetError(c, "Talk to the Pet Master.");
            return;
        }
        buyWhistle(c);
        return;
    }
    if (action === "FEED" && c.petFeedPending) {
        sendPetError(c, "Feeding is already in progress.");
        return;
    }
    if (action === "AUTO_HOME") {
        autoHomeCompanion(c, id, data.value);
        return;
    }

    const companion = findCompanion(c.user, id);
    if (!companion) {
        sendPetError(c, "Companion not found");
        return;
    }

    switch (action) {
        case "CALL":
            callCompanion(c, companion, data.value, data.amount);
            break;
        case "SEND_HOME":
            sendHomeCompanion(c, companion);
            break;
        case "FEED":
            feedCompanion(c, companion, data.value);
            break;
        case "PET":
            petCompanion(c, companion);
            break;
        case "REVIVE":
            if (String(data.value || "") !== "PET_MASTER") {
                sendPetError(c, "Talk to the Pet Master.");
                break;
            }
            reviveCompanion(c, companion);
            break;
        case "DEATH":
            if (companion.status === "summoned") {
                markCompanionInactive(c, companion, "death", data.value, data.amount);
                saveUserAndSendPets(c);
            }
            break;
        case "DECAY":
            companion.hunger = clampInt(data.value, 0, 100);
            companion.affection = companion.type === "dog" ? clampInt(data.amount, 0, 100) : 0;
            if (companion.hunger <= 0 || (companion.type === "dog" && companion.affection <= 0)) {
                markCompanionInactive(c, companion, "hunger", c.user.pos_x || 1, c.user.pos_y || 1);
            }
            if (typeof c.user.markModified === "function") c.user.markModified("companions");
            saveUserAndSendPets(c);
            break;
        default:
            sendPetError(c, "Unknown pet action");
            break;
    }
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
            String(spot.remaining),
            normalizeFishSpotType(spot.fishType)
        ]));
    });
}

function handleFishSpotPacket(c, datapacket) {
    if (!c.user) return;
    const data = PacketModels.fishspot.parse(datapacket);
    const rawFields = readPacketStrings(datapacket);
    const room = c.user.current_room;
    const spots = getSessionFishSpots(room);
    const action = String(data.action || "").toUpperCase();
    const spotId = String(data.spot_id || "");
    const x = clampInt(data.target_x, 0, 65535);
    const y = clampInt(data.target_y, 0, 65535);
    const remaining = clampFishSpotRemaining(data.remaining);
    const fishType = normalizeFishSpotType(rawFields[6] || data.fish_type);

    if (!spotId) return;

    const existingIndex = spots.findIndex(spot => spot.id === spotId);

    if (action === "CREATE" || action === "SYNC") {
        const spot = { id: spotId, x, y, remaining: remaining || 150, fishType };
        if (existingIndex >= 0) {
            spots[existingIndex] = spot;
        } else {
            spots.push(spot);
        }
        broadcastRoomIncluding(room, packet.build(["FISHSPOT", "CREATE", spot.id, String(spot.x), String(spot.y), String(spot.remaining), normalizeFishSpotType(spot.fishType)]));
        return;
    }

    if (action === "UPDATE") {
        if (existingIndex >= 0) {
            spots[existingIndex].remaining = remaining;
            broadcastRoomIncluding(room, packet.build(["FISHSPOT", "UPDATE", spotId, String(x), String(y), String(remaining), normalizeFishSpotType(spots[existingIndex].fishType)]));
        }
        return;
    }

    if (action === "DESTROY") {
        if (existingIndex >= 0) spots.splice(existingIndex, 1);
        broadcastRoomIncluding(room, packet.build(["FISHSPOT", "DESTROY", spotId, String(x), String(y), "0", fishType]));
    }
}

function bankLog(...args) {
    // if (BANK_DEBUG) console.log("[BANK]", ...args);
}

const activeTrades = new Map();
const tradeByUser = new Map();
let nextTradeId = 1;

function tradeClientName(c) {
    return c && c.user ? String(c.user.username || "") : "";
}

function findOnlineClient(username) {
    const targetName = String(username || "");
    if (!targetName || typeof maps === "undefined") return null;

    for (const roomName of Object.keys(maps)) {
        const room = maps[roomName];
        if (!room || !Array.isArray(room.clients)) continue;
        const found = room.clients.find(otherClient => otherClient && otherClient.user && String(otherClient.user.username) === targetName);
        if (found) return found;
    }

    return null;
}

function sendTradePacket(c, fields) {
    if (!c || !c.socket) return;
    try {
        c.socket.send(packet.build(["TRADE"].concat(fields.map(value => String(value)))));
    } catch (error) {
        packetLog(`Could not send trade packet: ${error.message || error}`);
    }
}

function sendTradeError(c, message) {
    sendTradePacket(c, ["ERROR", message || "Trade failed"]);
}

function tradeParty(session, username) {
    if (!session) return "";
    const name = String(username || "");
    if (name === session.a) return session.a;
    if (name === session.b) return session.b;
    return "";
}

function tradeOtherName(session, username) {
    const name = String(username || "");
    if (!session) return "";
    return name === session.a ? session.b : session.a;
}

function cancelTradeForUser(username, reason = "Trade cancelled") {
    const name = String(username || "");
    const tradeId = tradeByUser.get(name);
    if (!tradeId) return false;

    const session = activeTrades.get(tradeId);
    activeTrades.delete(tradeId);
    if (session) {
        tradeByUser.delete(session.a);
        tradeByUser.delete(session.b);
        sendTradePacket(findOnlineClient(session.a), ["CANCEL", String(tradeId), reason]);
        sendTradePacket(findOnlineClient(session.b), ["CANCEL", String(tradeId), reason]);
    } else {
        tradeByUser.delete(name);
    }
    return true;
}

function normalizeTradeOffer(session, username) {
    const offer = session.offers[username];
    const items = [];
    Object.keys(offer.items).forEach(slotText => {
        const entry = offer.items[slotText];
        const slot = clampInt(slotText, 1, INVENTORY_SLOT_COUNT);
        const amount = clampInt(entry && entry.amount, 0, 99);
        const item = String(entry && entry.item || "0");
        if (slot >= 1 && slot <= INVENTORY_SLOT_COUNT && item !== "0" && amount > 0) {
            items.push({ slot, item, amount });
        }
    });
    items.sort((left, right) => left.slot - right.slot);
    return {
        items,
        money: clampInt(offer.money || 0, 0, BANK_STACK_LIMIT)
    };
}

function resetTradeAccepts(session) {
    session.offers[session.a].accepted = false;
    session.offers[session.a].confirmed = false;
    session.offers[session.b].accepted = false;
    session.offers[session.b].confirmed = false;
    session.stage = 1;
    session.updatedAt = Date.now();
}

function broadcastTradeOffer(session) {
    const clientA = findOnlineClient(session.a);
    const clientB = findOnlineClient(session.b);
    const offerA = normalizeTradeOffer(session, session.a);
    const offerB = normalizeTradeOffer(session, session.b);

    for (const client of [clientA, clientB]) {
        if (!client) continue;
        sendTradePacket(client, ["CLEAR", session.id]);
        for (const entry of offerA.items) {
            sendTradePacket(client, ["OFFER", session.id, session.a, entry.slot, entry.item, entry.amount]);
        }
        for (const entry of offerB.items) {
            sendTradePacket(client, ["OFFER", session.id, session.b, entry.slot, entry.item, entry.amount]);
        }
        sendTradePacket(client, ["OFFER_MONEY", session.id, session.a, offerA.money]);
        sendTradePacket(client, ["OFFER_MONEY", session.id, session.b, offerB.money]);
        sendTradePacket(client, ["ACCEPT_STATE", session.id, session.a, session.offers[session.a].accepted ? "1" : "0", session.offers[session.a].confirmed ? "1" : "0"]);
        sendTradePacket(client, ["ACCEPT_STATE", session.id, session.b, session.offers[session.b].accepted ? "1" : "0", session.offers[session.b].confirmed ? "1" : "0"]);
        sendTradePacket(client, ["STAGE", session.id, session.stage]);
    }
}

function tradeClientsAreValid(session) {
    const clientA = findOnlineClient(session.a);
    const clientB = findOnlineClient(session.b);
    if (!clientA || !clientB || !clientA.user || !clientB.user) return { ok: false, reason: "Player logged out" };
    if (String(clientA.user.current_room) !== String(clientB.user.current_room)) return { ok: false, reason: "Players are not in the same room" };

    const ax = Number(clientA.user.pos_x) || 0;
    const ay = Number(clientA.user.pos_y) || 0;
    const bx = Number(clientB.user.pos_x) || 0;
    const by = Number(clientB.user.pos_y) || 0;
    const distance = Math.hypot(ax - bx, ay - by);
    if (distance > TRADE_DISTANCE_LIMIT) return { ok: false, reason: "Players are too far apart" };

    return { ok: true, clientA, clientB };
}

function validateTradeOfferForClient(client, offer) {
    const inventory = readInventory(client.user);
    const inventoryBySlot = inventory.map(slot => ({ item: slot.item, amount: slot.amount }));

    for (const entry of offer.items) {
        const slot = inventoryBySlot[entry.slot - 1];
        if (!slot || slot.item !== entry.item || slot.amount < entry.amount) {
            return { ok: false, reason: `${client.user.username} no longer has the offered item` };
        }
        slot.amount -= entry.amount;
    }

    if (clampInt(client.user.money || 0, 0, BANK_STACK_LIMIT) < offer.money) {
        return { ok: false, reason: `${client.user.username} does not have enough money` };
    }

    return { ok: true, inventory };
}

function removeTradeOfferFromInventory(inventory, offer) {
    for (const entry of offer.items) {
        const slot = inventory[entry.slot - 1];
        slot.amount -= entry.amount;
        if (slot.amount <= 0) {
            slot.item = "0";
            slot.amount = 0;
        }
    }
}

function addTradeOfferToInventory(inventory, offer) {
    for (const entry of offer.items) {
        const added = addToInventory(inventory, entry.item, entry.amount);
        if (added !== entry.amount) return false;
    }
    return true;
}

function saveTradeUser(client) {
    return new Promise((resolve, reject) => {
        const attemptSave = () => {
            if (client.user._savePromise) {
                setTimeout(attemptSave, 100);
                return;
            }

            const savePromise = client.user.save();
            if (savePromise && typeof savePromise.then === "function") {
                client.user._savePromise = savePromise
                    .then(resolve)
                    .catch(reject)
                    .finally(() => {
                        client.user._savePromise = null;
                    });
            } else {
                resolve();
            }
        };

        attemptSave();
    });
}

function completeTrade(session) {
    const valid = tradeClientsAreValid(session);
    if (!valid.ok) {
        cancelTradeForUser(session.a, valid.reason);
        return;
    }

    const clientA = valid.clientA;
    const clientB = valid.clientB;
    const offerA = normalizeTradeOffer(session, session.a);
    const offerB = normalizeTradeOffer(session, session.b);
    const validationA = validateTradeOfferForClient(clientA, offerA);
    const validationB = validateTradeOfferForClient(clientB, offerB);

    if (!validationA.ok || !validationB.ok) {
        cancelTradeForUser(session.a, validationA.reason || validationB.reason || "Trade validation failed");
        return;
    }

    const inventoryA = validationA.inventory;
    const inventoryB = validationB.inventory;
    removeTradeOfferFromInventory(inventoryA, offerA);
    removeTradeOfferFromInventory(inventoryB, offerB);

    if (!addTradeOfferToInventory(inventoryA, offerB) || !addTradeOfferToInventory(inventoryB, offerA)) {
        cancelTradeForUser(session.a, "Not enough inventory space");
        return;
    }

    writeInventory(clientA.user, inventoryA);
    writeInventory(clientB.user, inventoryB);
    clientA.user.money = clampInt(clientA.user.money || 0, 0, BANK_STACK_LIMIT) - offerA.money + offerB.money;
    clientB.user.money = clampInt(clientB.user.money || 0, 0, BANK_STACK_LIMIT) - offerB.money + offerA.money;

    activeTrades.delete(session.id);
    tradeByUser.delete(session.a);
    tradeByUser.delete(session.b);

    Promise.all([saveTradeUser(clientA), saveTradeUser(clientB)])
        .then(() => {
            sendInventorySnapshot(clientA, inventoryA);
            sendInventorySnapshot(clientB, inventoryB);
            sendMoneySnapshot(clientA);
            sendMoneySnapshot(clientB);
            sendTradePacket(clientA, ["COMPLETE", session.id]);
            sendTradePacket(clientB, ["COMPLETE", session.id]);
        })
        .catch(() => {
            sendTradeError(clientA, "Trade save failed");
            sendTradeError(clientB, "Trade save failed");
        });
}

function handleTradePacket(c, datapacket) {
    try {
        if (!c.user) {
            sendTradeError(c, "Not logged in");
            return;
        }

        const data = PacketModels.trade.parse(datapacket);
        const action = String(data.action || "").toUpperCase();
        const source = tradeClientName(c);
        const targetName = String(data.target || "");
        const slot = clampInt(data.slot || 0, 0, INVENTORY_SLOT_COUNT);
        const item = String(clampInt(data.item || 0, 0, BANK_STACK_LIMIT));
        const amount = clampInt(data.amount || 0, 0, BANK_STACK_LIMIT);

        if (action === "REQUEST") {
            if (!targetName || targetName === source) {
                sendTradeError(c, "Invalid trade target");
                return;
            }
            if (tradeByUser.has(source)) {
                sendTradeError(c, "You are already trading");
                return;
            }

            const targetClient = findOnlineClient(targetName);
            if (!targetClient || !targetClient.user) {
                sendTradeError(c, "Player is not online");
                return;
            }
            if (tradeByUser.has(targetName)) {
                sendTradeError(c, "That player is already trading");
                return;
            }
            if (String(c.user.current_room) !== String(targetClient.user.current_room)) {
                sendTradeError(c, "Player is not in your room");
                return;
            }

            const distance = Math.hypot((Number(c.user.pos_x) || 0) - (Number(targetClient.user.pos_x) || 0), (Number(c.user.pos_y) || 0) - (Number(targetClient.user.pos_y) || 0));
            if (distance > TRADE_DISTANCE_LIMIT) {
                sendTradeError(c, "Move closer to trade");
                return;
            }

            sendTradePacket(targetClient, ["REQUEST_FROM", source]);
            sendTradePacket(c, ["REQUEST_SENT", targetName]);
            return;
        }

        if (action === "ACCEPT_REQUEST") {
            const targetClient = findOnlineClient(targetName);
            if (!targetClient || !targetClient.user) {
                sendTradeError(c, "Player is not online");
                return;
            }
            if (tradeByUser.has(source) || tradeByUser.has(targetName)) {
                sendTradeError(c, "One player is already trading");
                return;
            }
            if (String(c.user.current_room) !== String(targetClient.user.current_room)) {
                sendTradeError(c, "Player is not in your room");
                return;
            }

            const tradeId = String(nextTradeId++);
            const session = {
                id: tradeId,
                a: targetName,
                b: source,
                offers: {},
                stage: 1,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            session.offers[session.a] = { items: {}, money: 0, accepted: false, confirmed: false };
            session.offers[session.b] = { items: {}, money: 0, accepted: false, confirmed: false };
            activeTrades.set(tradeId, session);
            tradeByUser.set(session.a, tradeId);
            tradeByUser.set(session.b, tradeId);

            sendTradePacket(targetClient, ["START", tradeId, source]);
            sendTradePacket(c, ["START", tradeId, targetName]);
            broadcastTradeOffer(session);
            return;
        }

        if ((action === "DECLINE" || action === "CANCEL") && !tradeByUser.has(source)) {
            const targetClient = findOnlineClient(targetName);
            if (targetClient) sendTradePacket(targetClient, ["CANCEL", "0", `${source} declined the trade`]);
            return;
        }

        const tradeId = tradeByUser.get(source);
        const session = tradeId ? activeTrades.get(tradeId) : null;
        if (!session || !tradeParty(session, source)) {
            sendTradeError(c, "You are not in a trade");
            return;
        }

        if (Date.now() - session.updatedAt > TRADE_TIMEOUT_MS) {
            cancelTradeForUser(source, "Trade timed out");
            return;
        }

        const validity = tradeClientsAreValid(session);
        if (!validity.ok) {
            cancelTradeForUser(source, validity.reason);
            return;
        }

        const offer = session.offers[source];

        if (action === "CANCEL" || action === "DECLINE") {
            cancelTradeForUser(source, "Trade declined");
            return;
        }

        if (action === "OFFER") {
            if (slot < 1 || slot > INVENTORY_SLOT_COUNT || item === "0" || amount <= 0) {
                sendTradeError(c, "Invalid offered item");
                return;
            }

            const inventory = readInventory(c.user);
            const invSlot = inventory[slot - 1];
            if (!invSlot || invSlot.item !== item || invSlot.amount <= 0) {
                sendTradeError(c, "That item is not in that slot");
                return;
            }

            offer.items[String(slot)] = { item, amount: Math.min(amount, invSlot.amount) };
            resetTradeAccepts(session);
            broadcastTradeOffer(session);
            return;
        }

        if (action === "REMOVE") {
            if (slot >= 1 && slot <= INVENTORY_SLOT_COUNT) {
                const existing = offer.items[String(slot)];
                if (existing) {
                    existing.amount -= Math.max(1, amount || existing.amount);
                    if (existing.amount <= 0) delete offer.items[String(slot)];
                }
            }
            resetTradeAccepts(session);
            broadcastTradeOffer(session);
            return;
        }

        if (action === "OFFER_MONEY") {
            offer.money = Math.min(amount, clampInt(c.user.money || 0, 0, BANK_STACK_LIMIT));
            resetTradeAccepts(session);
            broadcastTradeOffer(session);
            return;
        }

        if (action === "ACCEPT_STAGE1") {
            offer.accepted = true;
            session.updatedAt = Date.now();
            if (session.offers[session.a].accepted && session.offers[session.b].accepted) {
                session.stage = 2;
            }
            broadcastTradeOffer(session);
            return;
        }

        if (action === "CONFIRM") {
            if (session.stage !== 2 || !session.offers[session.a].accepted || !session.offers[session.b].accepted) {
                sendTradeError(c, "Trade is not ready to confirm");
                return;
            }

            offer.confirmed = true;
            session.updatedAt = Date.now();
            broadcastTradeOffer(session);
            if (session.offers[session.a].confirmed && session.offers[session.b].confirmed) {
                completeTrade(session);
            }
            return;
        }

        sendTradeError(c, "Unknown trade action");
    } catch (error) {
        sendTradeError(c, "Trade request failed");
    }
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

function withAdminTarget(targetName, cb) {
    const onlineClient = findOnlineClientByUsername(targetName);
    if (onlineClient) {
        cb(null, onlineClient.user, onlineClient);
        return;
    }

    User.findOne({ username: String(targetName || "") }, function(err, user) {
        if (err || !user) {
            cb(err || new Error("User not found"), null, null);
            return;
        }
        cb(null, user, null);
    });
}

function saveAdminTarget(user, onlineClient, afterSave, onError) {
    const done = () => {
        if (typeof afterSave === "function") afterSave();
    };
    const fail = error => {
        if (typeof onError === "function") onError(error);
    };

    if (onlineClient) {
        saveUserQueued(onlineClient, done, fail);
        return;
    }

    user.save(function(err) {
        if (err) {
            fail(err);
        } else {
            done();
        }
    });
}

function rejectProtectedAdminTarget(actor, targetUser, targetName, action) {
    if (!actor || !targetName) return "Missing target user";
    if (String(actor.username).toLowerCase() === String(targetName).toLowerCase()) {
        return `You cannot ${action} yourself`;
    }
    if (isAdminUser(targetUser)) {
        return `You cannot ${action} another admin`;
    }
    return "";
}

function handleAdminPacket(c, datapacket) {
    let data;
    try {
        data = PacketModels.admin.parse(datapacket);
    } catch (error) {
        sendAdminError(c, "Invalid admin packet");
        return;
    }

    if (!c.user || !isAdminUser(c.user)) {
        sendAdminError(c, "Admin permission required");
        return;
    }

    const action = String(data.action || "").toUpperCase();
    const targetName = String(data.target || "");

    if (action === "LIST") {
        sendAdminList(c);
        return;
    }

    if (!targetName || targetName === "0") {
        sendAdminError(c, "Missing target user");
        return;
    }

    if (action === "KICK") {
        const targetClient = findOnlineClientByUsername(targetName);
        if (!targetClient || !targetClient.user) {
            sendAdminError(c, "Target is not online");
            return;
        }
        const protectedReason = rejectProtectedAdminTarget(c.user, targetClient.user, targetName, "kick");
        if (protectedReason) {
            sendAdminError(c, protectedReason);
            return;
        }
        sendAdminOk(c, `Kicked ${targetClient.user.username}`);
        try {
            targetClient.socket.close();
        } catch (error) {
            targetClient.end();
        }
        sendAdminList(c);
        return;
    }

    if (action === "MUTE" || action === "UNMUTE" || action === "BAN" || action === "UNBAN" || action === "GIVE_ITEM" || action === "GIVE_EXP") {
        withAdminTarget(targetName, function(err, targetUser, targetClient) {
            if (err || !targetUser) {
                sendAdminError(c, "Target user not found");
                return;
            }

            const protectedActions = ["MUTE", "BAN"];
            if (protectedActions.indexOf(action) >= 0) {
                const protectedReason = rejectProtectedAdminTarget(c.user, targetUser, targetName, action.toLowerCase());
                if (protectedReason) {
                    sendAdminError(c, protectedReason);
                    return;
                }
            }

            if (action === "MUTE" || action === "BAN") {
                const prefix = action === "MUTE" ? "mute" : "ban";
                const permanent = String(data.arg2 || "").toLowerCase() === "1"
                    || String(data.arg2 || "").toLowerCase() === "true"
                    || String(data.arg1 || "").toLowerCase() === "permanent";
                const expiry = permanent ? null : futureDateFromHours(data.arg1);
                if (!permanent && !expiry) {
                    sendAdminError(c, "Enter a positive number of hours or use permanent");
                    return;
                }
                targetUser[`${prefix}Permanent`] = permanent;
                targetUser[`${prefix}ExpiresAt`] = expiry;

                saveAdminTarget(
                    targetUser,
                    targetClient,
                    function() {
                        sendAdminOk(c, `${action === "MUTE" ? "Muted" : "Banned"} ${targetUser.username}`);
                        if (action === "BAN" && targetClient && targetClient.socket) {
                            try {
                                targetClient.socket.close();
                            } catch (error) {
                                targetClient.end();
                            }
                        }
                        sendAdminList(c);
                    },
                    function() {
                        sendAdminError(c, `Could not save ${prefix}`);
                    }
                );
                return;
            }

            if (action === "UNMUTE" || action === "UNBAN") {
                const prefix = action === "UNMUTE" ? "mute" : "ban";
                targetUser[`${prefix}Permanent`] = false;
                targetUser[`${prefix}ExpiresAt`] = null;
                saveAdminTarget(
                    targetUser,
                    targetClient,
                    function() {
                        sendAdminOk(c, `${action === "UNMUTE" ? "Unmuted" : "Unbanned"} ${targetUser.username}`);
                        sendAdminList(c);
                    },
                    function() {
                        sendAdminError(c, `Could not save ${prefix}`);
                    }
                );
                return;
            }

            if (action === "GIVE_ITEM") {
                const item = String(data.arg1 || "0");
                const amount = parseAdminPositiveInt(data.arg2, ADMIN_MAX_GRANT_AMOUNT);
                if (amount <= 0) {
                    sendAdminError(c, "Enter a positive item amount");
                    return;
                }
                const grantResult = applyItemGrantToUser(targetUser, item, amount);
                if (!grantResult.ok) {
                    sendAdminError(c, grantResult.message);
                    return;
                }
                saveAdminTarget(
                    targetUser,
                    targetClient,
                    function() {
                        syncGrantedItemToOnlineClient(targetClient, grantResult);
                        sendAdminOk(c, `Gave ${amount} of item ${item} to ${targetUser.username}`);
                    },
                    function() {
                        sendAdminError(c, "Could not save item grant");
                    }
                );
                return;
            }

            if (action === "GIVE_EXP") {
                const skill = normalizeAdminSkillField(data.arg1);
                const amount = parseAdminPositiveInt(data.arg2, ADMIN_MAX_GRANT_AMOUNT);
                if (!skill) {
                    sendAdminError(c, "Unknown skill field");
                    return;
                }
                if (amount <= 0) {
                    sendAdminError(c, "Enter a positive XP amount");
                    return;
                }
                const currentValue = clampInt(targetUser[skill] || 0, 0, ADMIN_MAX_GRANT_AMOUNT);
                const nextValue = Math.min(ADMIN_MAX_GRANT_AMOUNT, currentValue + amount);
                targetUser[skill] = String(nextValue);
                saveAdminTarget(
                    targetUser,
                    targetClient,
                    function() {
                        syncGrantedExpToOnlineClient(targetClient, skill, nextValue);
                        sendAdminOk(c, `Gave ${amount} ${skill} to ${targetUser.username}`);
                    },
                    function() {
                        sendAdminError(c, "Could not save XP grant");
                    }
                );
            }
        });
        return;
    }

    sendAdminError(c, "Unknown admin action");
}

module.exports = packet = global.packet = {
    sendFishSpotSnapshot: sendFishSpotSnapshot,
    sendHouseDirty: sendHouseDirty,
    cancelTradeForUser: cancelTradeForUser,

    // Build a packet from an array of JavaScript objects (strings, numbers)
    build: function (params) {
        var packetParts = [];
        var packetSize = 0;
        var command = params && params.length > 0 ? String(params[0]) : "UNKNOWN";
        this.showlogs = false;
        params.forEach(function (param, index) {
            var buffer;


            // if (this.showlogs) console.log(param);
            if (typeof param === 'string') {
                buffer = Buffer.from(param, 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string
            } else if (typeof param === 'number') {
                buffer = writePacketNumber(command, index, param);
            } else {
                buffer = Buffer.from("0", 'utf8');
                buffer = Buffer.concat([buffer, Buffer.from([0])], buffer.length + 1); // Null-terminated string

                // if (this.showlogs) console.log("WARNING: Unknown data type in packet builder!");
            }

            packetSize += buffer.length;
            packetParts.push(buffer);
        });

        var finalPacket = buildPacketFromParts(command, packetParts, packetSize);
        // if (this.showlogs) console.log(finalPacket);
        return finalPacket;
    },

    // Parse a packet to be handled for a client
    parse: function (c, data) {
        var idx = 0;

        while (idx < data.length) {
            if (idx + PACKET_LENGTH_BYTES > data.length) {
                packetLog(`Ignoring incomplete packet length at offset ${idx}`);
                break;
            }

            var packetSize = data.readUInt16LE(idx); // Read the size of the packet
            if (packetSize <= PACKET_LENGTH_BYTES || idx + packetSize > data.length) {
                packetLog(`Ignoring invalid packet size ${packetSize} at offset ${idx}`);
                break;
            }

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
            case "LOGOUT":
                c.end();
                if (c.socket) {
                    try {
                        c.socket.close();
                    } catch (error) {}
                }
                break;
            case "LOGIN":
                var data = PacketModels.login.parse(datapacket);
                User.login(data.username, data.password, function (result, user) {
                    if (result) {
                        if (user.username === ADMIN_BOOTSTRAP_USERNAME && !user.isAdmin) {
                            user.isAdmin = true;
                        }
                        if (isRestrictionActive(user, "ban")) {
                            c.socket.send(packet.build(["LOGIN", "FALSE", `Banned ${restrictionText(user, "ban")}`]));
                            user.save(function() {});
                            return;
                        }
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
                                String(clampInt(c.user.money || 0, 0, BANK_STACK_LIMIT)),
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
                                c.user.fishingExperience || "0",
                                c.user.eye_colour || "0",
                                String(c.user.townReputation || 0),
                                isAdminUser(c.user) ? "1" : "0"

                            ]));

                    } else {
                        c.socket.send(packet.build(["LOGIN", "FALSE", "Invalid username or password"]));
                    }
                });
                break;

            case "LOGIN2":
                c.socket.send(packet.build(["LOGIN2",
                    c.user.item1, c.user.item2, c.user.item3, c.user.item4, c.user.item5, c.user.item6,
                    c.user.status, c.user.trousers_colour, c.user.top_colour, c.user.skin_colour, c.user.hair_colour, c.user.hair, c.user.eye_colour || "0"]));

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
                if (!c.user || isRestrictionActive(c.user, "mute")) {
                    sendAdminError(c, `You are muted ${restrictionText(c.user, "mute")}`);
                    if (c.user) c.user.save(function() {});
                    break;
                }
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
                var rawFishingFields = readPacketStrings(datapacket);
                var fishingActions = ["START", "REQUEST", "STOP"];
                var fishingName = rawFishingFields[1] || data.name;
                var fishingTargetX = data.target_x;
                var fishingTargetY = data.target_y;
                var fishingDirection = data.direction || "0";
                var fishingAction = data.action || "";
                if (fishingActions.indexOf(String(rawFishingFields[2] || "").toUpperCase()) != -1) {
                    fishingAction = String(rawFishingFields[2]).toUpperCase();
                    fishingTargetX = rawFishingFields[3] || "0";
                    fishingTargetY = rawFishingFields[4] || "0";
                    fishingDirection = rawFishingFields[5] || "0";
                }
                if (fishingActions.indexOf(String(fishingDirection).toUpperCase()) != -1 && fishingActions.indexOf(String(fishingAction).toUpperCase()) == -1) {
                    fishingAction = String(fishingDirection).toUpperCase();
                    fishingDirection = "0";
                }
                c.broadcastroom(packet.build(["FISHING", fishingName, fishingTargetX, fishingTargetY, String(fishingDirection), String(fishingAction).toUpperCase()]));
                break;

            case "FISHSPOT":
                handleFishSpotPacket(c, datapacket);
                break;

            case "TOWNJOB":
                handleTownJobPacket(c, datapacket);
                break;

            case "PET":
                handlePetPacket(c, datapacket);
                break;

            case "ACCEPT": // Save changes to the database
                try {
                    var data = PacketModels.accept.parse(datapacket);
                    if (tradeByUser.has(c.user.username) && (String(data.variable || "").indexOf("item") === 0 || String(data.variable || "") === "money")) {
                        cancelTradeForUser(c.user.username, "Trade cancelled by inventory change");
                    }
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
                handleHousePacket(c, datapacket);
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
                if (c.user && tradeByUser.has(c.user.username)) {
                    cancelTradeForUser(c.user.username, "Trade cancelled by banking");
                }
                handleBankPacket(c, datapacket);
                break;

            case "TRADE":
                handleTradePacket(c, datapacket);
                break;

            case "ADMIN":
                handleAdminPacket(c, datapacket);
                break;

            default:
                // console.log("Unknown command: " + header.command);
        }
    }
};
