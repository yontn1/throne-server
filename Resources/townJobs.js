const ITEMS = {
    CHICKEN_COOKED: "11127",
    OAK_TREE_LOG: "11134",
    TWISTVINE_TREE_LOG: "11135",
    SPRUCE_TREE_LOG: "11137",
    MEAT_COOKED: "11140",
    ANCHOVY_COOKED: "11149",
    IRON_HELMET: "11157",
    IRON_PLATEBODY: "11158",
    IRON_PLATELEGS: "11159",
    MITHRIL_SHIELD: "11164",
    ADAMANT_PLATEBODY: "11166"
};

module.exports = {
    low: [
        { id: "low_cooked_chicken", item: ITEMS.CHICKEN_COOKED, amount: 4, money: 80, reputation: 2 },
        { id: "low_cooked_meat", item: ITEMS.MEAT_COOKED, amount: 3, money: 95, reputation: 3 },
        { id: "low_cooked_anchovy", item: ITEMS.ANCHOVY_COOKED, amount: 5, money: 90, reputation: 3 },
        { id: "low_oak_logs", item: ITEMS.OAK_TREE_LOG, amount: 12, money: 110, reputation: 4 }
    ],
    mid: [
        { id: "mid_spruce_logs", item: ITEMS.SPRUCE_TREE_LOG, amount: 14, money: 220, reputation: 7 },
        { id: "mid_twistvine_logs", item: ITEMS.TWISTVINE_TREE_LOG, amount: 10, money: 260, reputation: 8 },
        { id: "mid_iron_helmet", item: ITEMS.IRON_HELMET, amount: 1, money: 240, reputation: 7 },
        { id: "mid_iron_platelegs", item: ITEMS.IRON_PLATELEGS, amount: 1, money: 320, reputation: 9 }
    ],
    high: [
        { id: "high_iron_platebody", item: ITEMS.IRON_PLATEBODY, amount: 1, money: 520, reputation: 16, requiredChariotLevel: 2 },
        { id: "high_mithril_shield", item: ITEMS.MITHRIL_SHIELD, amount: 1, money: 760, reputation: 22, requiredChariotLevel: 4 },
        { id: "high_adamant_platebody", item: ITEMS.ADAMANT_PLATEBODY, amount: 1, money: 1100, reputation: 30, requiredChariotLevel: 5 }
    ]
};
