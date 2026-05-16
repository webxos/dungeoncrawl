#!/usr/bin/env python3
"""
Game Engine for DungeonCrawl – Infinite Dungeon
Expanded Monster System (50+ types) + All Tools
"""

import sys
import json
import random
import os
import re
import copy
import subprocess
import difflib

# ----------------------------------------------------------------------
# Configuration & helpers
# ----------------------------------------------------------------------
TEMPLATES_FILE = os.getenv('TEMPLATES_FILE', './templates.json')
CRAFTING_RECIPES_FILE = os.getenv('CRAFTING_RECIPES_FILE', './crafting_recipes.json')
RANDOM_SEED = os.getenv('RANDOM_SEED')
if RANDOM_SEED:
    random.seed(int(RANDOM_SEED))

_templates = None
_crafting_recipes = None

def get_templates():
    global _templates
    if _templates is None:
        try:
            with open(TEMPLATES_FILE, 'r') as f:
                _templates = json.load(f)
        except Exception:
            _templates = {
                "room_descriptions": ["A dark room. Room {room_id} smells of old stone."],
                "ambient": ["You hear distant echoes."],
                "monsters": [],
                "items": [],
                "ground_loot": {},
                "traps": [],
                "npcs": [],
                "quest_hints": {},
                "global_events": [],
                "boss_intros": []
            }
    return _templates

def get_crafting_recipes():
    global _crafting_recipes
    if _crafting_recipes is None:
        try:
            with open(CRAFTING_RECIPES_FILE, 'r') as f:
                _crafting_recipes = json.load(f)
        except Exception:
            _crafting_recipes = {
                "weapons": {"Iron Sword": {"materials": {"Iron Ingot": 3}, "gold_cost": 15,
                                           "result": {"name": "Iron Sword", "type": "weapon", "bonus": 2, "value": 25}}},
                "armor": {"Iron Chainmail": {"materials": {"Iron Ingot": 4}, "gold_cost": 30,
                                             "result": {"name": "Iron Chainmail", "type": "armor", "bonus": 2, "value": 40}}},
                "potions": {},
                "buff_potions": {},
                "permanent_potions": {}
            }
    return _crafting_recipes

def roll_dice(dice_notation="1d20"):
    match = re.match(r'^(\d+)d(\d+)([+-]\d+)?$', dice_notation, re.I)
    if not match:
        return {"total": random.randint(1,20), "rolls": [random.randint(1,20)], "modifier": 0}
    count = int(match.group(1))
    sides = int(match.group(2))
    mod = int(match.group(3)) if match.group(3) else 0
    rolls = [random.randint(1, sides) for _ in range(count)]
    total = sum(rolls) + mod
    return {"total": total, "rolls": rolls, "modifier": mod}

# ----------------------------------------------------------------------
# Zone & movement
# ----------------------------------------------------------------------
def get_zone(room_id):
    if room_id < 13:
        return "entrance"
    elif room_id < 28:
        return "mid"
    elif room_id < 49:
        return "deep"
    elif room_id < 80:
        return "abyss"
    elif room_id < 120:
        return "void"
    elif room_id < 170:
        return "nightmare"
    elif room_id < 230:
        return "eternal"
    else:
        return "boss"

def get_new_room_id(room_id, direction):
    if direction == "north": return room_id + 1
    elif direction == "south": return max(0, room_id - 1)
    elif direction == "east": return room_id + 7
    elif direction == "west": return max(0, room_id - 5)
    else: return None

def get_exits(room_id):
    exits = []
    for d in ["north", "south", "east", "west"]:
        if get_new_room_id(room_id, d) is not None:
            exits.append(d)
    if not exits:
        exits = ["north"]
    return exits

# ----------------------------------------------------------------------
# EXPANDED MONSTER SYSTEM (50+ families)
# ----------------------------------------------------------------------
MONSTER_FAMILIES = {
    "goblinoid": {
        "zones": ["entrance", "mid"],
        "names": ["Goblin", "Hobgoblin", "Bugbear", "Goblin Shaman", "Goblin Assassin"],
        "base_hp": 8, "base_attack": 2, "base_defense": 1,
        "damage_range": [2,5], "xp": 20, "gold_range": [5,10],
        "special": "poison_bite",
        "loot_extra": ["Leather Scrap", "Iron Ore"]
    },
    "beast": {
        "zones": ["entrance", "mid"],
        "names": ["Giant Rat", "Dire Wolf", "Cave Bear", "Mountain Lion", "Wild Boar"],
        "base_hp": 10, "base_attack": 3, "base_defense": 2,
        "damage_range": [3,6], "xp": 25, "gold_range": [5,12],
        "special": "fear_aura",
        "loot_extra": ["Leather Scrap", "Raw Meat"]
    },
    "undead": {
        "zones": ["mid", "deep", "abyss"],
        "names": ["Skeleton", "Zombie", "Ghost", "Wight", "Lichling", "Dullahan"],
        "base_hp": 12, "base_attack": 4, "base_defense": 3,
        "damage_range": [4,8], "xp": 35, "gold_range": [8,20],
        "special": "life_drain",
        "loot_extra": ["Bone Dust", "Essence"]
    },
    "orcish": {
        "zones": ["mid", "deep"],
        "names": ["Orc Warrior", "Orc Berserker", "Orc Chieftain", "Orc Shaman", "Orc Warlord"],
        "base_hp": 18, "base_attack": 5, "base_defense": 3,
        "damage_range": [4,9], "xp": 45, "gold_range": [10,25],
        "special": "frenzy",
        "loot_extra": ["Iron Ore", "Iron Ingot"]
    },
    "elemental": {
        "zones": ["deep", "abyss", "void"],
        "names": ["Fire Elemental", "Earth Elemental", "Air Elemental", "Water Elemental", "Magma Elemental", "Frost Elemental"],
        "base_hp": 25, "base_attack": 6, "base_defense": 5,
        "damage_range": [5,12], "xp": 70, "gold_range": [20,40],
        "special": "burn",
        "loot_extra": ["Enchanted Dust", "Elemental Shard"]
    },
    "demon": {
        "zones": ["abyss", "void", "nightmare"],
        "names": ["Imp", "Quasit", "Shadow Demon", "Vrock", "Balor", "Pit Fiend"],
        "base_hp": 30, "base_attack": 8, "base_defense": 6,
        "damage_range": [6,15], "xp": 100, "gold_range": [30,60],
        "special": "chaos_ray",
        "loot_extra": ["Demon Heart", "Enchanted Dust"]
    },
    "dragonkin": {
        "zones": ["deep", "abyss", "eternal", "boss"],
        "names": ["Dragon Hatchling", "Young Dragon", "Wyvern", "Drake", "Ancient Dragon", "Dragon Lord"],
        "base_hp": 40, "base_attack": 9, "base_defense": 7,
        "damage_range": [8,18], "xp": 150, "gold_range": [50,100],
        "special": "burn",
        "loot_extra": ["Dragon Scale", "Gem Shard"]
    },
    "construct": {
        "zones": ["mid", "deep", "eternal"],
        "names": ["Animated Armor", "Iron Golem", "Stone Golem", "Clockwork Guardian", "Mithril Sentinel"],
        "base_hp": 35, "base_attack": 7, "base_defense": 8,
        "damage_range": [5,12], "xp": 90, "gold_range": [25,50],
        "special": "stone_form",
        "loot_extra": ["Iron Ingot", "Titanium Ingot"]
    },
    "abomination": {
        "zones": ["abyss", "void", "nightmare"],
        "names": ["Gibbering Mouther", "Otyugh", "Beholder", "Mind Flayer", "Aboleth"],
        "base_hp": 45, "base_attack": 9, "base_defense": 5,
        "damage_range": [7,15], "xp": 120, "gold_range": [40,80],
        "special": "petrify",
        "loot_extra": ["Horror Eye", "Enchanted Dust"]
    },
    "fey": {
        "zones": ["entrance", "mid", "deep"],
        "names": ["Sprite", "Pixie", "Dryad", "Satyr", "Hag", "Green Knight"],
        "base_hp": 15, "base_attack": 3, "base_defense": 2,
        "damage_range": [3,8], "xp": 30, "gold_range": [10,25],
        "special": "time_slow",
        "loot_extra": ["Essence", "Herb Bundle"]
    },
    "giant": {
        "zones": ["deep", "abyss", "eternal"],
        "names": ["Ogre", "Troll", "Hill Giant", "Stone Giant", "Fire Giant", "Frost Giant"],
        "base_hp": 50, "base_attack": 10, "base_defense": 4,
        "damage_range": [8,18], "xp": 130, "gold_range": [30,70],
        "special": "frenzy",
        "loot_extra": ["Titanium Ore", "Giant's Toe"]
    },
    "undead_elite": {
        "zones": ["abyss", "void", "nightmare"],
        "names": ["Lich", "Death Knight", "Banshee", "Vampire Lord", "Dracolich"],
        "base_hp": 60, "base_attack": 12, "base_defense": 8,
        "damage_range": [10,20], "xp": 200, "gold_range": [100,200],
        "special": "lich_curse",
        "loot_extra": ["Rare Essence", "Enchanted Dust"]
    },
    "boss": {
        "zones": ["boss"],
        "names": ["Ancient Lich", "Dragon Emperor", "Void Revenant", "Nightmare King", "Eternal Watcher"],
        "base_hp": 200, "base_attack": 20, "base_defense": 15,
        "damage_range": [15,30], "xp": 500, "gold_range": [200,500],
        "special": "apocalypse",
        "loot_extra": ["World Core", "Lich Phylactery"]
    }
}

ZONE_FAMILIES = {
    "entrance": [("goblinoid", 40), ("beast", 35), ("fey", 20), ("orcish", 5)],
    "mid": [("goblinoid", 20), ("beast", 15), ("undead", 30), ("orcish", 25), ("construct", 10)],
    "deep": [("undead", 20), ("orcish", 15), ("elemental", 25), ("dragonkin", 15), ("giant", 15), ("fey", 10)],
    "abyss": [("undead", 15), ("elemental", 20), ("demon", 25), ("abomination", 20), ("dragonkin", 10), ("giant", 10)],
    "void": [("demon", 30), ("abomination", 25), ("undead_elite", 20), ("dragonkin", 15), ("elemental", 10)],
    "nightmare": [("demon", 25), ("abomination", 25), ("undead_elite", 30), ("dragonkin", 20)],
    "eternal": [("dragonkin", 30), ("undead_elite", 25), ("giant", 20), ("construct", 15), ("elemental", 10)],
    "boss": [("boss", 100)]
}

def generate_monster(zone, player_level, is_minion=False, room_id=0, is_elite=False):
    families = ZONE_FAMILIES.get(zone, ZONE_FAMILIES["entrance"])
    family_name = random.choices([f for f, _ in families], weights=[w for _, w in families])[0]
    family = MONSTER_FAMILIES[family_name]

    base_name = random.choice(family["names"])
    depth_factor = 1.0 + max(0, (room_id - 50) * 0.01)
    depth_factor = min(2.5, depth_factor)
    level_mod = 1 + (player_level - 1) * 0.15
    overall_factor = depth_factor * level_mod
    if is_minion:
        overall_factor *= 0.7
    if is_elite:
        overall_factor *= 1.8

    base_hp = int(family["base_hp"] * overall_factor)
    base_attack = int(family["base_attack"] + (player_level // 2))
    base_defense = int(family["base_defense"] + (player_level // 3))
    dmg_min = int(family["damage_range"][0] * overall_factor)
    dmg_max = int(family["damage_range"][1] * overall_factor)
    xp = int(family["xp"] * overall_factor)
    gold_min = int(family["gold_range"][0] * overall_factor)
    gold_max = int(family["gold_range"][1] * overall_factor)

    loot_table = []
    for extra in family.get("loot_extra", []):
        loot_table.append({"item": {"name": extra, "type": "misc", "value": random.randint(2, 10)}, "chance": 0.5})

    if zone == "entrance":
        loot_table.append({"item": {"name": "Leather Scrap", "type": "misc", "value": 1}, "chance": 0.6})
        loot_table.append({"item": {"name": "Iron Ore", "type": "misc", "value": 2}, "chance": 0.3})
    elif zone == "mid":
        loot_table.append({"item": {"name": "Iron Ingot", "type": "misc", "value": 4}, "chance": 0.5})
        loot_table.append({"item": {"name": "Titanium Ore", "type": "misc", "value": 5}, "chance": 0.2})
    elif zone in ["deep", "abyss"]:
        loot_table.append({"item": {"name": "Titanium Ingot", "type": "misc", "value": 8}, "chance": 0.5})
        loot_table.append({"item": {"name": "Enchanted Dust", "type": "misc", "value": 10}, "chance": 0.3})
    else:
        loot_table.append({"item": {"name": "Enchanted Dust", "type": "misc", "value": 15}, "chance": 0.6})
        loot_table.append({"item": {"name": "Gem Shard", "type": "misc", "value": 20}, "chance": 0.4})

    if random.random() < 0.3:
        tier = random.choices(["lesser","normal","greater"], weights=[0.5,0.35,0.15])[0]
        heal_val = {"lesser":10, "normal":25, "greater":50}[tier]
        loot_table.append({"item": {"name": f"{tier.capitalize()} Health Potion", "type": "consumable",
                                    "effect": "heal", "value": heal_val, "tier": tier}, "chance": 0.5})

    monster = {
        "name": base_name,
        "hp": max(1, base_hp), "max_hp": max(1, base_hp),
        "attack": max(1, base_attack), "defense": max(0, base_defense),
        "damage_range": [max(1, dmg_min), max(2, dmg_max)],
        "xp": max(1, xp), "gold_range": [max(1, gold_min), max(2, gold_max)],
        "loot_table": loot_table,
        "special": family["special"],
        "element": family_name if family_name in ["elemental", "dragonkin"] else None
    }

    if is_minion:
        monster["name"] = f"{base_name} Minion"
        monster["is_minion"] = True
    if is_elite:
        monster["hp"] = int(monster["hp"] * 1.5)
        monster["max_hp"] = monster["hp"]
        monster["attack"] = int(monster["attack"] * 1.4)
        monster["defense"] = int(monster["defense"] * 1.3)
        monster["xp"] = int(monster["xp"] * 2)
        monster["gold_range"][0] = int(monster["gold_range"][0] * 2)
        monster["gold_range"][1] = int(monster["gold_range"][1] * 2.5)
        monster["name"] = f"Elite {monster['name']}"
        monster["rarity"] = "elite"
        monster["loot_table"].append({"item": {"name": "Rare Essence", "type": "misc", "value": random.randint(50,150)}, "chance": 0.8})
    return monster

# ----------------------------------------------------------------------
# Global event
# ----------------------------------------------------------------------
def trigger_global_event(room_id, player):
    if room_id % 10 != 0 or room_id == 0:
        return None, player, None
    event_type = random.randint(1, 10)
    if event_type == 1:
        return "A traveling merchant appears!", player, {"merchant": True}
    elif event_type == 2:
        dmg = max(1, player["maxHp"] // 10)
        player["hp"] = max(1, player["hp"] - dmg)
        return f"Dark energy lashes out! You lose {dmg} HP.", player, None
    elif event_type == 3:
        heal = player["maxHp"] // 5
        player["hp"] = min(player["maxHp"], player["hp"] + heal)
        return f"A divine light heals you for {heal} HP.", player, None
    elif event_type == 4:
        gold = random.randint(20, 100)
        player["gold"] += gold
        return f"A shower of gold coins! You gain {gold} gold.", player, None
    elif event_type == 5:
        new_room = random.randint(0, max(1, room_id - 5))
        return f"A magical vortex teleports you to Room {new_room}!", player, {"teleport_to": new_room}
    elif event_type == 6:
        player.setdefault("effects", []).append({"name": "global_bless", "duration": 5, "value": 2})
        return "An ancient spirit blesses you with +2 attack for 5 turns.", player, None
    elif event_type == 7:
        dmg = random.randint(5, 15)
        player["hp"] = max(1, player["hp"] - dmg)
        return f"Meteors crash around you! You take {dmg} damage.", player, None
    elif event_type == 8:
        player.setdefault("effects", []).append({"name": "spell_empower", "duration": 2, "value": 2})
        return "Arcane energy surges! Your next spell is empowered.", player, None
    elif event_type == 9:
        return "A distant roar shakes the dungeon. Monsters seem terrified!", player, None
    else:
        zone = get_zone(room_id)
        ambush_monster = generate_monster(zone, player["level"], is_minion=False, room_id=room_id)
        return "You are ambushed by a monster!", player, {"ambush_monster": ambush_monster}

# ----------------------------------------------------------------------
# Room generation
# ----------------------------------------------------------------------
def generate_ground_loot(zone, player_level, room_id):
    loot = []
    material_tables = {
        "entrance": ["Leather Scrap", "Iron Ore", "Wood Scrap"],
        "mid": ["Iron Ingot", "Titanium Ore", "Leather Scrap"],
        "deep": ["Titanium Ingot", "Enchanted Dust", "Dragon Scale"],
        "abyss": ["Void Essence", "Horror Eye", "Enchanted Dust"],
        "void": ["Null Core", "Chronoshard", "Titanium Ingot"],
        "nightmare": ["Dream Shard", "Terror Essence", "Gem Shard"],
        "eternal": ["Phoenix Feather", "Eternal Dust", "Enchanted Dust"],
        "boss": ["World Core", "Lich Phylactery", "Rare Essence"]
    }
    if zone in material_tables:
        mat = random.choice(material_tables[zone])
        loot.append({"name": mat, "type": "misc", "value": random.randint(5, 30)})
    if random.random() < 0.5:
        tier = random.choices(["lesser","normal","greater","superior"], weights=[0.5,0.3,0.15,0.05])[0]
        heal_val = {"lesser":10, "normal":25, "greater":50, "superior":80}[tier]
        loot.append({"name": f"{tier.capitalize()} Health Potion", "type": "consumable", "effect": "heal", "value": heal_val, "tier": tier})
    if random.random() < 0.1:
        loot.append({"name": "Wooden Chest", "type": "chest", "value": 0})
    return loot

def generate_trap(zone):
    traps = {
        "entrance": {"name": "Pit", "effect": "damage", "save_dc": 10, "damage": 5},
        "mid": {"name": "Swinging Blade", "effect": "damage", "save_dc": 12, "damage": 8},
        "deep": {"name": "Lightning Rune", "effect": "damage", "save_dc": 14, "damage": 12},
        "abyss": {"name": "Curse Glyph", "effect": "curse", "save_dc": 15, "damage": 0},
        "void": {"name": "Gravity Inversion", "effect": "stun", "save_dc": 16, "damage": 10},
        "nightmare": {"name": "Soul Drain", "effect": "weaken", "save_dc": 18, "damage": 15},
        "eternal": {"name": "Time Lock", "effect": "slow", "save_dc": 20, "damage": 5}
    }
    return traps.get(zone, traps["entrance"])

# ----------------------------------------------------------------------
# ENHANCED NPC GENERATION (with personality and role)
# ----------------------------------------------------------------------
def generate_npc(zone, player_level):
    names = ["Old Sage","Mysterious Stranger","Goblin Prisoner","Ghost Knight","Dragon Priest","Wandering Bard","Trapped Merchant","Penitent Cultist","Bound Spirit"]
    name = random.choice(names)
    is_quest_giver = random.random() < 0.7
    # Static dialogue fallback (will be overwritten by LLM on frontend if enabled)
    dialogue = f"{name}: " + random.choice([
        "The path ahead is dangerous.","I sense a great evil in the deep.","Help me and I will reward you.",
        "Beware the shadows...","I have a task for you, adventurer."
    ])
    # New fields for richer NPC context
    personalities = ["curious", "brooding", "jovial", "desperate", "ancient", "mysterious", "cryptic", "fearful", "courageous"]
    roles = ["merchant", "wanderer", "guard", "priest", "scholar", "outcast", "hero", "villager", "adventurer"]
    return {
        "name": name,
        "dialogue": dialogue,
        "quest_giver": is_quest_giver,
        "vendor": False,
        "personality": random.choice(personalities),
        "role": random.choice(roles)
    }

# ----------------------------------------------------------------------
# Quest hint & other helpers
# ----------------------------------------------------------------------
def get_quest_hint(zone):
    hints = {
        "entrance": ["You see a crude map marking the goblin camp.","A dying adventurer whispers: 'Seek iron for the blacksmith.'"],
        "mid": ["Scratches on the wall read: 'The forge needs titanium.'","You find a journal: 'The alchemist in the deep brews potions of might.'"],
        "deep": ["A glowing inscription: 'Three scales shall light the way to the Lich.'","You discover notes: 'The Blood Grimoire holds the banishing rite.'"],
        "abyss": ["The walls bleed whispers: 'Void consumes all.'","An ethereal voice: 'Find the Null Core.'"]
    }
    return random.choice(hints.get(zone, ["The dungeon whispers secrets."]))

def upgrade_to_mini_boss(room_mechanics, room_id, player_level):
    if room_id % 15 != 0 or room_id == 0:
        return room_mechanics
    if not room_mechanics.get("monster"):
        return room_mechanics
    monster = room_mechanics["monster"]
    monster["hp"] = int(monster["hp"] * 2.5)
    monster["max_hp"] = monster["hp"]
    monster["attack"] = int(monster["attack"] * 1.8)
    monster["defense"] = int(monster["defense"] * 1.5)
    monster["xp"] = int(monster["xp"] * 2.5)
    monster["gold_range"] = [monster["gold_range"][0] * 3, monster["gold_range"][1] * 4]
    monster["name"] = f"Mini-Boss: {monster['name']}"
    monster["is_mini_boss"] = True
    monster["loot_table"].append({"item": {"name": "Mini-Boss Trophy", "type": "misc", "value": 50}, "chance": 1.0})
    monster["loot_table"].append({"item": {"name": "Rare Essence", "type": "misc", "value": 25}, "chance": 0.8})
    room_mechanics["boss_intro"] = f"A powerful Mini-Boss blocks your path: {monster['name']}!"
    return room_mechanics

def handle_boss_room(room_mechanics, room_id, player_level):
    if room_id % 50 == 0 and room_id > 0:
        templates = get_templates()
        boss_monsters = [m for m in templates.get("monsters", []) if m.get("zone") == "boss"]
        if boss_monsters:
            boss = random.choice(boss_monsters)
            monster = generate_monster("boss", player_level, is_minion=False, room_id=room_id)
            monster["name"] = boss["name"]
            monster["hp"] = int(boss.get("base_hp", 200) * (1 + player_level * 0.1))
            monster["max_hp"] = monster["hp"]
            monster["special"] = boss.get("special", "apocalypse")
            room_mechanics["monster"] = monster
            intro_list = templates.get("boss_intros", [])
            if intro_list:
                room_mechanics["boss_intro"] = random.choice(intro_list).get("intro", "The boss roars!")
            room_mechanics["type"] = "boss"
    return room_mechanics

def generate_room_mechanics(room_id, player_level=1):
    zone = get_zone(room_id)
    templates = get_templates()

    # REDUCED MONSTER SPAWN FREQUENCY (35% base)
    if zone in ["entrance","mid"]:
        type_weights = {"monster": 35, "treasure": 15, "trap": 5, "npc": 25, "empty": 20}
    elif zone in ["deep","abyss"]:
        type_weights = {"monster": 40, "treasure": 10, "trap": 10, "npc": 20, "empty": 20}
    else:
        type_weights = {"monster": 45, "treasure": 5, "trap": 15, "npc": 15, "empty": 20}
    room_type = random.choices(list(type_weights.keys()), weights=list(type_weights.values()))[0]

    desc_list = templates.get("room_descriptions", ["Room {room_id}"])
    description = random.choice(desc_list).replace("{room_id}", str(room_id))
    ambient_list = templates.get("ambient", [])
    ambient = random.choice(ambient_list) if ambient_list else ""

    monster = None
    if room_type == "monster" or random.random() < 0.4:   # Additional random chance
        is_minion = random.random() < 0.15
        monster = generate_monster(zone, player_level, is_minion=is_minion, room_id=room_id)

    room_mech = {
        "room_id": room_id,
        "zone": zone,
        "type": room_type,
        "description": description,
        "ambient": ambient,
        "exits": get_exits(room_id),
        "monster": monster,
        "ground_loot": generate_ground_loot(zone, player_level, room_id),
        "npc": generate_npc(zone, player_level) if room_type == "npc" and random.random() < 0.6 else None,
        "trap": generate_trap(zone) if room_type == "trap" else None,
        "quest_hint": get_quest_hint(zone) if random.random() < 0.2 else None,
        "pending_quest": None,
        "visited": False
    }

    room_mech = upgrade_to_mini_boss(room_mech, room_id, player_level)
    room_mech = handle_boss_room(room_mech, room_id, player_level)
    return room_mech

# ----------------------------------------------------------------------
# Combat helpers
# ----------------------------------------------------------------------
def apply_monster_special(monster, player, defense_bonus):
    special = monster.get("special")
    if not special:
        return player, monster, ""
    msg = ""
    if special == "poison_bite":
        dmg = random.randint(3, 8)
        player["hp"] -= dmg
        player.setdefault("effects", []).append({"name": "poisoned", "duration": 3, "value": 2})
        msg = f" The {monster['name']} poisons you for {dmg} damage!"
    elif special == "burn":
        dmg = random.randint(4, 10)
        player["hp"] -= dmg
        player.setdefault("effects", []).append({"name": "burning", "duration": 2, "value": 3})
        msg = f" Flames sear you for {dmg} damage!"
    elif special == "life_drain":
        dmg = random.randint(5, 12)
        player["hp"] -= dmg
        monster["hp"] = min(monster["max_hp"], monster["hp"] + dmg//2)
        msg = f" The {monster['name']} drains your life for {dmg} damage and heals!"
    elif special == "fear_aura":
        if random.random() < 0.3:
            player.setdefault("effects", []).append({"name": "frightened", "duration": 2, "value": -2})
            msg = f" You are frightened by {monster['name']} (-2 attack)!"
    elif special == "chaos_ray":
        dmg = random.randint(8, 16)
        player["hp"] -= dmg
        msg = f" A chaotic ray deals {dmg} damage to you!"
    elif special == "stone_form":
        monster["defense"] += 5
        msg = f" The {monster['name']} turns to stone, gaining +5 defense!"
    elif special == "petrify":
        if random.random() < 0.2:
            player.setdefault("effects", []).append({"name": "petrified", "duration": 1, "value": 0})
            msg = f" You begin to turn to stone! You lose your next turn."
    elif special == "frenzy":
        monster["attack"] += 4
        msg = f" The {monster['name']} enters a frenzy! Attack increased."
    elif special == "time_slow":
        player.setdefault("effects", []).append({"name": "slowed", "duration": 2, "value": 1})
        msg = f" The {monster['name']} slows time around you!"
    elif special == "lich_curse":
        player.setdefault("effects", []).append({"name": "cursed", "duration": 0, "value": 1})
        msg = " A curse takes hold of your soul!"
    elif special == "apocalypse":
        dmg = random.randint(15, 30)
        player["hp"] -= dmg
        msg = f" APOCALYPSE! You take {dmg} damage from the boss's final attack!"
    return player, monster, msg

def calculate_heal(item, player_level):
    tier = item.get("tier", "normal")
    base_heal = item.get("value", 10)
    if tier == "lesser": return base_heal + player_level * 2
    elif tier == "normal": return base_heal + player_level * 3
    elif tier == "greater": return base_heal + player_level * 4
    elif tier == "superior": return base_heal + player_level * 5
    elif tier == "supreme": return base_heal + player_level * 6
    else: return base_heal + player_level * 2

# ----------------------------------------------------------------------
# Inventory helpers
# ----------------------------------------------------------------------
def find_item_by_name(item_name, inventory, cutoff=0.7):
    lower_name = item_name.lower()
    exact = next((i for i in inventory if i["name"].lower() == lower_name), None)
    if exact:
        return exact
    names = [i["name"] for i in inventory]
    matches = difflib.get_close_matches(lower_name, [n.lower() for n in names], n=1, cutoff=cutoff)
    if matches:
        matched_name = next(n for n in names if n.lower() == matches[0])
        return next(i for i in inventory if i["name"] == matched_name)
    return None

def remove_one_item(player, item):
    for i in player["inventory"]:
        if i["name"] == item["name"] and i.get("type") == item.get("type"):
            if i.get("stack", 1) > 1:
                i["stack"] -= 1
                return
            else:
                player["inventory"] = [x for x in player["inventory"] if not (x["name"] == item["name"] and x.get("type") == item.get("type"))]
                return

# ----------------------------------------------------------------------
# TOOL IMPLEMENTATIONS
# ----------------------------------------------------------------------
def tool_move(args, state):
    direction = args.get("direction")
    current = state.get("room")
    if current is None:
        return {"success": False, "message": "No current room in state."}
    exits = get_exits(current)
    if direction not in exits:
        return {"success": False, "message": f"Cannot go {direction}. Available exits: {', '.join(exits)}"}
    mech = state["room_mechanics"]
    if mech.get("monster") and mech["monster"]["hp"] > 0:
        return {"success": False, "message": f"A {mech['monster']['name']} blocks your way! Fight or flee first."}
    new_room = get_new_room_id(current, direction)
    if new_room is None:
        return {"success": False, "message": "You cannot go that way."}
    player_level = state["player"]["level"]
    new_mech = generate_room_mechanics(new_room, player_level)
    event_desc, updated_player, extra = trigger_global_event(new_room, state["player"])
    if event_desc:
        new_mech["event_message"] = event_desc
        if extra and "teleport_to" in extra:
            new_room = extra["teleport_to"]
            new_mech = generate_room_mechanics(new_room, player_level)
        elif extra and "ambush_monster" in extra:
            new_mech["monster"] = extra["ambush_monster"]
        state["player"] = updated_player
    return {"success": True, "new_room": new_room, "room_mechanics": new_mech,
            "message": f"You move {direction} to Room {new_room}." + (f" {event_desc}" if event_desc else "")}

def tool_look(args, state):
    mech = state["room_mechanics"]
    desc = mech.get("description", f"You are in Room {mech['room_id']}.")
    if mech.get("ambient"):
        desc += " " + mech["ambient"]
    desc += f" Exits: {', '.join(mech['exits'])}."
    if mech.get("monster"):
        m = mech["monster"]
        desc += f" A {m['name']} (HP: {m['hp']}/{m['max_hp']}) is here!"
    if mech.get("ground_loot"):
        desc += f" You see: {', '.join([i['name'] for i in mech['ground_loot']])}."
    if mech.get("npc"):
        desc += f" {mech['npc']['name']} is here."
    if mech.get("quest_hint"):
        desc += f" {mech['quest_hint']}"
    if mech.get("event_message"):
        desc += f" {mech['event_message']}"
    if mech.get("boss_intro"):
        desc += f" {mech['boss_intro']}"
    return {"success": True, "description": desc, "message": desc}

def tool_search(args, state):
    mech = state["room_mechanics"]
    loot = mech.get("ground_loot", [])
    chest_loot = []
    other_loot = []
    for item in loot:
        if item.get("type") == "chest":
            chest_items = [
                {"name": "Gold Coins", "type": "misc", "value": random.randint(10, 50)},
                {"name": "Lesser Health Potion", "type": "consumable", "effect": "heal", "value": 10, "tier": "lesser"},
                {"name": "Iron Ingot", "type": "misc", "value": 4},
                {"name": "Enchanted Dust", "type": "misc", "value": 5}
            ]
            chest_loot.append(random.choice(chest_items))
        else:
            other_loot.append(item)
    all_loot = other_loot + chest_loot
    if all_loot:
        msg = f"You find: {', '.join([i['name'] for i in all_loot])}."
        player = state["player"]
        for item in all_loot:
            player["inventory"].append(item)
        mech["ground_loot"] = []
        return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech, "loot": all_loot}
    else:
        return {"success": True, "message": "You find nothing."}

def tool_take(args, state):
    item_name = args.get("item_name")
    mech = state["room_mechanics"]
    loot_list = mech.get("ground_loot", [])
    item = find_item_by_name(item_name, loot_list)
    if not item:
        return {"success": False, "message": f"No {item_name} here."}
    player = state["player"]
    player["inventory"].append(item)
    mech["ground_loot"] = [i for i in loot_list if i["name"] != item["name"]]
    return {"success": True, "message": f"You take the {item['name']}.", "player": player, "updated_room_mechanics": mech, "loot": [item]}

def tool_equip(args, state):
    item_name = args.get("item_name")
    player = state["player"]
    item = find_item_by_name(item_name, player["inventory"])
    if not item:
        return {"success": False, "message": f"You don't have {item_name}."}
    if item["type"] == "weapon":
        if player.get("weapon"):
            player["inventory"].append(player["weapon"])
        player["weapon"] = item
        player["inventory"] = [i for i in player["inventory"] if not (i["name"] == item["name"] and i.get("type") == "weapon")]
    elif item["type"] == "armor":
        if player.get("armor"):
            player["inventory"].append(player["armor"])
        player["armor"] = item
        player["inventory"] = [i for i in player["inventory"] if not (i["name"] == item["name"] and i.get("type") == "armor")]
    else:
        player["attack_bonus"] += item.get("bonus", 0)
        player["defense_bonus"] += item.get("bonus", 0)
        player["inventory"] = [i for i in player["inventory"] if i["name"] != item["name"]]
    return {"success": True, "message": f"You equip {item['name']}.", "player": player}

def tool_use_out_of_combat(args, state):
    item_name = args.get("item_name")
    player = state["player"]
    item = find_item_by_name(item_name, player["inventory"])
    if not item:
        return {"success": False, "message": f"You don't have {item_name}."}
    if not item.get("consumable", False) and item.get("type") != "consumable":
        return {"success": False, "message": f"{item_name} is not usable."}
    effect = item.get("effect")
    if effect == "heal":
        heal_amount = calculate_heal(item, player.get("level",1))
        player["hp"] = min(player["maxHp"], player["hp"] + heal_amount)
        msg = f"You use {item_name} and heal {heal_amount} HP."
    elif effect == "cure":
        player["effects"] = [e for e in player["effects"] if e["name"] not in ["poisoned","burning","cursed"]]
        msg = f"You use {item_name} and are cured of ailments."
    elif effect == "buff":
        player.setdefault("effects", []).append({"name":"blessed","duration":5,"value":2})
        msg = f"You use {item_name} and feel stronger (+2 attack for 5 turns)."
    else:
        msg = f"You use {item_name} but nothing happens."
    remove_one_item(player, item)
    return {"success": True, "message": msg, "player": player, "item_used": item["name"]}

def tool_use_wrapper(args, state):
    if state.get("combat_active"):
        return tool_combat_action({"action": "use", "item_name": args.get("item_name")}, state)
    else:
        return tool_use_out_of_combat(args, state)

def tool_combat_action(args, state):
    action = args.get("action")
    player = state["player"]
    mech = state["room_mechanics"]
    monster = mech.get("monster")
    if not monster or monster["hp"] <= 0:
        return {"success": False, "message": "No monster to fight."}

    for effect in player.get("effects", []):
        if effect["name"] == "poisoned":
            player["hp"] -= effect.get("value", 2)
            effect["duration"] -= 1
        elif effect["name"] == "burning":
            player["hp"] -= effect.get("value", 3)
            effect["duration"] -= 1
    player["effects"] = [e for e in player["effects"] if e["duration"] > 0]

    weapon = player.get("weapon")
    damage_bonus = player.get("damage_bonus", 0) + (weapon.get("bonus", 0) if weapon else 0)
    attack_bonus = player.get("attack_bonus", 0) + (weapon.get("hit_bonus", 0) if weapon else 0)
    defense_bonus = player.get("defense_bonus", 0)
    armor = player.get("armor")
    if armor:
        defense_bonus += armor.get("bonus", 0)
    for item in player["inventory"]:
        if item.get("type") in ["boots","gloves","ring","amulet"] and item.get("bonus"):
            defense_bonus += item.get("bonus", 0)
            attack_bonus += item.get("bonus", 0)

    HIT_BONUS = 5
    monster_name = monster["name"]

    if action == "attack":
        dice_result = roll_dice("1d20")
        roll = dice_result["total"]
        total_attack = roll + attack_bonus + HIT_BONUS
        monster_ac = 10 + monster["defense"]
        crit = roll == 20
        if player.get("class") == "rogue" and random.random() < 0.15:
            crit = True

        if total_attack >= monster_ac:
            base_dice = random.randint(monster["damage_range"][0], monster["damage_range"][1])
            if crit:
                base_dice *= 2
                crit_msg = " Critical hit!"
            else:
                crit_msg = ""
            total_damage = base_dice + damage_bonus
            monster["hp"] -= total_damage
            msg = f"You attack the {monster_name} and hit for {total_damage} damage!{crit_msg}"
            if monster["hp"] <= 0:
                xp = monster["xp"]
                gold = random.randint(monster["gold_range"][0], monster["gold_range"][1])
                gold = int(gold * player.get("gold_find_multiplier", 1))
                loot = []
                for entry in monster.get("loot_table", []):
                    if random.random() < entry.get("chance", 1.0):
                        loot.append(entry["item"])
                mech["monster"] = None
                player["xp"] += xp
                player["gold"] += gold
                if loot:
                    player["inventory"].extend(loot)
                msg += f" You defeated the {monster_name}! Gained {xp} XP, {gold} gold."
                if loot:
                    loot_names = ', '.join([item['name'] for item in loot])
                    msg += f" Found: {loot_names}."
                if random.random() < 0.2:
                    zone = mech["zone"]
                    new_monster = generate_monster(zone, player["level"], is_minion=random.random()<0.15, room_id=mech["room_id"])
                    mech["monster"] = new_monster
                    msg += f" From the shadows, a {new_monster['name']} appears!"
                return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                        "xp": xp, "gold": gold, "loot": loot, "monster_defeated": True, "monster_name": monster_name,
                        "is_minion": monster.get("is_minion", False), "zone": mech["zone"], "dice": dice_result}
            else:
                monster_roll = roll_dice("1d20")["total"]
                monster_attack = monster_roll + monster["attack"]
                player_ac = 10 + defense_bonus
                monster_damage = 0
                if monster_attack >= player_ac:
                    raw_damage = random.randint(monster["damage_range"][0], monster["damage_range"][1])
                    monster_damage = max(1, raw_damage - defense_bonus)
                    player["hp"] -= monster_damage
                    msg += f" The {monster_name} hits you back for {monster_damage} damage!"
                else:
                    msg += f" The {monster_name} misses you."
                player, monster, special_msg = apply_monster_special(monster, player, defense_bonus)
                if special_msg:
                    msg += special_msg
                return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                        "damage": monster_damage, "dice": dice_result,
                        "monster_dice": {"notation": "1d20", "rolls": [monster_roll], "total": monster_attack, "modifier": monster["attack"]}}
        else:
            msg = f"You attack the {monster_name} but miss."
            monster_roll = roll_dice("1d20")["total"]
            monster_attack = monster_roll + monster["attack"]
            player_ac = 10 + defense_bonus
            monster_damage = 0
            if monster_attack >= player_ac:
                raw_damage = random.randint(monster["damage_range"][0], monster["damage_range"][1])
                monster_damage = max(1, raw_damage - defense_bonus)
                player["hp"] -= monster_damage
                msg += f" The {monster_name} hits you for {monster_damage} damage!"
            else:
                msg += f" The {monster_name} misses you."
            player, monster, special_msg = apply_monster_special(monster, player, defense_bonus)
            if special_msg:
                msg += special_msg
            return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                    "damage": monster_damage, "dice": dice_result,
                    "monster_dice": {"notation": "1d20", "rolls": [monster_roll], "total": monster_attack, "modifier": monster["attack"]}}

    elif action == "defend":
        player.setdefault("effects", []).append({"name": "defending", "duration": 1, "value": 2})
        msg = "You take a defensive stance."
        r1 = roll_dice("1d20")["total"]
        r2 = roll_dice("1d20")["total"]
        monster_roll = min(r1, r2)
        monster_attack = monster_roll + monster["attack"]
        player_ac = 10 + defense_bonus + 2
        monster_damage = 0
        if monster_attack >= player_ac:
            raw_damage = random.randint(monster["damage_range"][0], monster["damage_range"][1])
            monster_damage = max(1, raw_damage - defense_bonus)
            player["hp"] -= monster_damage
            msg += f" The {monster_name} still hits you for {monster_damage} damage!"
        else:
            msg += f" The {monster_name} misses you."
        player, monster, special_msg = apply_monster_special(monster, player, defense_bonus)
        if special_msg:
            msg += special_msg
        return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                "damage": monster_damage, "dice": {"notation": "defense (disadvantage)", "rolls": [r1, r2], "total": monster_roll, "modifier": monster["attack"]}}

    elif action == "flee":
        direction = args.get("direction")
        exits = mech.get("exits", [])
        if not direction and exits:
            direction = exits[0]
        elif not direction:
            return {"success": False, "message": "No direction to flee!"}
        flee_roll = roll_dice("1d100")["total"]
        monster_level = max(1, monster["attack"] // 2)
        level_diff = player["level"] - monster_level
        flee_bonus = min(20, max(-10, level_diff * 5))
        flee_chance = 75 + flee_bonus
        flee_chance = max(10, min(95, flee_chance))
        success = flee_roll <= flee_chance
        if success:
            exit_dir = direction if direction in exits else (exits[0] if exits else None)
            if exit_dir:
                new_room = get_new_room_id(state["room"], exit_dir)
                if new_room is None:
                    new_room = state["room"] + 1
                new_mech = generate_room_mechanics(new_room, player["level"])
                msg = f"You roll {flee_roll} (need ≤{flee_chance}) — you flee {exit_dir}!"
                return {"success": True, "message": msg, "new_room": new_room, "room_mechanics": new_mech,
                        "player": player, "updated_room_mechanics": new_mech,
                        "dice": {"notation": "1d100", "rolls": [flee_roll], "total": flee_roll, "modifier": 0},
                        "fled": True}
        raw_damage = random.randint(monster["damage_range"][0], monster["damage_range"][1])
        monster_damage = max(1, raw_damage - defense_bonus)
        player["hp"] -= monster_damage
        msg = f"You roll {flee_roll} (need ≤{flee_chance}) — FAILED to flee! The {monster_name} strikes you for {monster_damage} damage!"
        return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                "damage": monster_damage, "dice": {"notation": "1d100", "rolls": [flee_roll], "total": flee_roll, "modifier": 0},
                "fled": False}

    elif action == "use":
        item_name = args.get("item_name")
        item = find_item_by_name(item_name, player["inventory"])
        if not item:
            return {"success": False, "message": f"You don't have {item_name}."}
        if not item.get("consumable", False) and item.get("type") != "consumable":
            return {"success": False, "message": f"{item_name} is not usable in combat."}
        effect = item.get("effect")
        if effect == "heal":
            heal_amount = calculate_heal(item, player["level"])
            player["hp"] = min(player["maxHp"], player["hp"] + heal_amount)
            msg = f"You use {item_name} and heal {heal_amount} HP."
        elif effect == "buff":
            player.setdefault("effects", []).append({"name": "blessed", "duration": 3, "value": 2})
            msg = f"You use {item_name} and feel blessed (+2 attack for 3 turns)."
        else:
            msg = f"You use {item_name} but nothing happens."
        remove_one_item(player, item)
        monster_roll = roll_dice("1d20")["total"]
        monster_attack = monster_roll + monster["attack"]
        player_ac = 10 + defense_bonus
        monster_damage = 0
        if monster_attack >= player_ac:
            raw_damage = random.randint(monster["damage_range"][0], monster["damage_range"][1])
            monster_damage = max(1, raw_damage - defense_bonus)
            player["hp"] -= monster_damage
            msg += f" The {monster_name} hits you for {monster_damage} damage!"
        else:
            msg += f" The {monster_name} misses you."
        return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech,
                "damage": monster_damage, "item_used": item["name"]}

    else:
        return {"success": False, "message": f"Unknown combat action: {action}"}

def tool_rest(args, state):
    return {"success": False, "message": "Use 'rest' command in main game."}

def tool_status(args, state):
    p = state["player"].copy()
    return {"success": True, "status": p, "message": "You check your status."}

def tool_inventory(args, state):
    return {"success": True, "inventory": state["player"]["inventory"], "message": "You check your inventory."}

def tool_quest_log(args, state):
    return {"success": True, "quests": state.get("quests", []), "message": "Your quest journal."}

def tool_lore(args, state):
    return {"success": True, "lore": state.get("lore", []), "message": "Lore fragments."}

def tool_summary(args, state):
    p = state["player"]
    mech = state["room_mechanics"]
    parts = [f"Room {mech['room_id']} ({mech['zone']})", f"HP {p['hp']}/{p.get('maxHp',100)}", f"Level {p['level']} (XP {p['xp']}/{p.get('xpToNext',100)})"]
    if mech.get("monster") and mech["monster"]["hp"]>0:
        parts.append(f"Monster: {mech['monster']['name']} HP {mech['monster']['hp']}/{mech['monster']['max_hp']}")
    if mech.get("ground_loot"):
        parts.append("Loot visible")
    parts.append(f"Exits: {', '.join(mech.get('exits',[]))}")
    if state.get("combat_active"):
        parts.append("COMBAT")
    return {"success": True, "summary": " | ".join(parts)}

def tool_craft(args, state):
    return {"success": False, "message": "Use /blacksmith for weapons/armor or /alchemist for potions."}

def tool_recycle(args, state):
    item_name = args.get("item_name")
    player = state["player"]
    item = find_item_by_name(item_name, player["inventory"])
    if not item:
        return {"success": False, "message": f"You don't have {item_name}."}
    materials = []
    value = item.get("value", 1)
    name_lower = item["name"].lower()
    if "leather" in name_lower:
        materials.append({"name": "Leather Scrap", "count": max(2, value // 5)})
    elif "iron" in name_lower or "steel" in name_lower:
        materials.append({"name": "Iron Ore", "count": max(2, value // 4)})
        if random.random() < 0.5:
            materials.append({"name": "Iron Ingot", "count": 1})
    elif "titanium" in name_lower:
        materials.append({"name": "Titanium Ore", "count": max(2, value // 6)})
        if random.random() < 0.5:
            materials.append({"name": "Titanium Ingot", "count": 1})
    elif item["type"] in ["weapon","armor","boots","gloves","ring","amulet"]:
        if "iron" in name_lower or "steel" in name_lower:
            materials.append({"name": "Iron Ore", "count": max(2, value // 5)})
        elif "titanium" in name_lower:
            materials.append({"name": "Titanium Ore", "count": max(2, value // 6)})
        else:
            materials.append({"name": "Leather Scrap", "count": max(2, value // 4)})
        if item.get("unique"):
            materials.append({"name": "Enchanted Dust", "count": 2})
    elif item["type"] == "consumable":
        if "potion" in name_lower:
            materials.append({"name": "Herb Bundle", "count": max(2, value // 8)})
            materials.append({"name": "Essence", "count": 1})
        else:
            materials.append({"name": "Enchanted Dust", "count": max(1, value // 10)})
    else:
        materials.append({"name": "Misc Scrap", "count": 2})
    for mat in materials:
        for _ in range(mat["count"]):
            player["inventory"].append({"name": mat["name"], "type": "misc", "value": 1, "consumable": False})
    player["inventory"] = [i for i in player["inventory"] if not (i["name"] == item["name"] and i.get("type") == item.get("type"))]
    material_str = ', '.join([f"{m['count']}x {m['name']}" for m in materials])
    return {"success": True, "message": f"You recycle {item['name']} and receive {material_str}.", "player": player}

def tool_blacksmith_menu(args, state):
    return {"success": True, "menu": [
        {"id": "craft_weapon", "name": "Craft Weapon", "description": "Forge a weapon"},
        {"id": "craft_armor", "name": "Craft Armor", "description": "Forge armor"},
        {"id": "upgrade_artifact", "name": "Upgrade Artifact", "description": "Enhance a unique item"},
        {"id": "recycle", "name": "Recycle Items", "description": "Break items into materials"},
        {"id": "exit", "name": "Exit", "description": "Leave the blacksmith"}
    ]}

def tool_blacksmith_action(args, state):
    action = args.get("action")
    player = state["player"]
    if action == "craft_weapon" or action == "craft_armor":
        recipes = get_crafting_recipes().get("weapons", {}) if action == "craft_weapon" else get_crafting_recipes().get("armor", {})
        if not recipes:
            if action == "craft_weapon":
                recipes = {"Iron Sword": {"materials": {"Iron Ingot": 3}, "gold_cost": 15, "result": {"name": "Iron Sword", "type": "weapon", "bonus": 2, "value": 25}}}
            else:
                recipes = {"Iron Chainmail": {"materials": {"Iron Ingot": 4}, "gold_cost": 30, "result": {"name": "Iron Chainmail", "type": "armor", "bonus": 2, "value": 40}}}
        return {"success": True, "type": action, "recipes": [{"name": n, "materials": d["materials"], "gold_cost": d["gold_cost"], "result": d["result"]} for n,d in recipes.items()]}
    elif action == "craft_selected":
        recipe_name = args.get("recipe_name")
        recipes = get_crafting_recipes()
        for category in ["weapons","armor"]:
            if recipe_name in recipes.get(category, {}):
                recipe = recipes[category][recipe_name]
                inv = player["inventory"]
                for mat, count_needed in recipe["materials"].items():
                    have = sum(1 for i in inv if i["name"] == mat)
                    if have < count_needed:
                        return {"success": False, "message": f"Missing {count_needed - have} x {mat}."}
                if player["gold"] < recipe["gold_cost"]:
                    return {"success": False, "message": f"Need {recipe['gold_cost']} gold."}
                for mat, count_needed in recipe["materials"].items():
                    removed = 0
                    new_inv = []
                    for i in inv:
                        if i["name"] == mat and removed < count_needed:
                            removed += 1
                            continue
                        new_inv.append(i)
                    player["inventory"] = new_inv
                player["gold"] -= recipe["gold_cost"]
                result_item = copy.deepcopy(recipe["result"])
                player["inventory"].append(result_item)
                return {"success": True, "message": f"You craft {result_item['name']}!", "player": player}
        return {"success": False, "message": f"Unknown recipe {recipe_name}."}
    elif action == "upgrade_artifact":
        artifacts = [i for i in player["inventory"] if i.get("unique")]
        if not artifacts:
            return {"success": False, "message": "No artifacts to upgrade."}
        return {"success": True, "type": "upgrade_artifact", "artifacts": [{"name": a["name"], "upgrade_level": a.get("upgrade_level",0), "bonus": a.get("bonus",0)} for a in artifacts]}
    elif action == "upgrade_selected":
        artifact_name = args.get("artifact_name")
        artifact = next((i for i in player["inventory"] if i["name"] == artifact_name and i.get("unique")), None)
        if not artifact:
            return {"success": False, "message": "Artifact not found."}
        upgrade_level = artifact.get("upgrade_level", 0)
        if upgrade_level >= 3:
            return {"success": False, "message": "Already fully upgraded."}
        cost_gold = 150 * (upgrade_level + 1)
        cost_materials = {"Gem Shard": upgrade_level + 1, "Enchanted Dust": upgrade_level + 2}
        inv = player["inventory"]
        for mat, need in cost_materials.items():
            have = sum(1 for i in inv if i["name"] == mat)
            if have < need:
                return {"success": False, "message": f"Need {need - have} more {mat}."}
        if player["gold"] < cost_gold:
            return {"success": False, "message": f"Need {cost_gold} gold."}
        for mat, need in cost_materials.items():
            removed = 0
            new_inv = []
            for i in inv:
                if i["name"] == mat and removed < need:
                    removed += 1
                    continue
                new_inv.append(i)
            player["inventory"] = new_inv
        player["gold"] -= cost_gold
        artifact["upgrade_level"] = upgrade_level + 1
        artifact["bonus"] = artifact.get("bonus", 2) + 1
        artifact["value"] = int(artifact["value"] * 1.2)
        if player.get("weapon") and player["weapon"]["name"] == artifact_name:
            player["weapon"] = artifact
        if player.get("armor") and player["armor"]["name"] == artifact_name:
            player["armor"] = artifact
        return {"success": True, "message": f"You upgrade {artifact_name} to +{artifact['bonus']}!", "player": player}
    elif action == "recycle":
        return {"success": True, "type": "recycle", "items": [{"name": i["name"], "type": i["type"]} for i in player["inventory"] if i.get("type") != "misc" or i.get("value",0) > 0]}
    else:
        return {"success": False, "message": "Unknown blacksmith action."}

def tool_alchemist_menu(args, state):
    return {"success": True, "menu": [
        {"id": "brew_potion", "name": "Brew Health Potion", "description": "Create healing potions"},
        {"id": "brew_buff", "name": "Brew Buff Potion", "description": "Temporary stat boosts"},
        {"id": "brew_permanent", "name": "Brew Permanent Potion", "description": "Permanent stat boost (rare)"},
        {"id": "recycle", "name": "Recycle Items", "description": "Break items into materials"},
        {"id": "exit", "name": "Exit", "description": "Leave the alchemist"}
    ]}

def tool_alchemist_action(args, state):
    action = args.get("action")
    player = state["player"]
    if action == "brew_potion" or action == "brew_buff" or action == "brew_permanent":
        category = "potions" if action == "brew_potion" else ("buff_potions" if action == "brew_buff" else "permanent_potions")
        recipes = get_crafting_recipes().get(category, {})
        if not recipes:
            if category == "potions":
                recipes = {"Lesser Health Potion": {"materials": {"Herb Bundle": 2}, "gold_cost": 5, "result": {"name": "Lesser Health Potion", "type": "consumable", "effect": "heal", "value": 10, "tier": "lesser"}}}
            elif category == "buff_potions":
                recipes = {"Strength Potion": {"materials": {"Essence": 1, "Herb Bundle": 2}, "gold_cost": 20, "result": {"name": "Strength Potion", "type": "consumable", "effect": "buff", "value": 2}}}
            else:
                recipes = {"Potion of Vitality": {"materials": {"Dragon Scale": 1, "Essence": 3}, "gold_cost": 200, "result": {"effect": "permanent_hp_boost", "value": 10}, "max_consumed": 1}}
        return {"success": True, "type": action, "recipes": [{"name": n, "materials": d["materials"], "gold_cost": d["gold_cost"], "result": d["result"], "max_consumed": d.get("max_consumed",1)} for n,d in recipes.items()]}
    elif action == "brew_selected":
        recipe_name = args.get("recipe_name")
        potion_type = args.get("potion_type")
        if potion_type == "potion":
            category = "potions"
        elif potion_type == "buff":
            category = "buff_potions"
        else:
            category = "permanent_potions"
        recipes = get_crafting_recipes().get(category, {})
        if recipe_name not in recipes:
            return {"success": False, "message": f"Unknown recipe {recipe_name}."}
        recipe = recipes[recipe_name]
        inv = player["inventory"]
        for mat, count_needed in recipe["materials"].items():
            have = sum(1 for i in inv if i["name"] == mat)
            if have < count_needed:
                return {"success": False, "message": f"Missing {count_needed - have} x {mat}."}
        if player["gold"] < recipe["gold_cost"]:
            return {"success": False, "message": f"Need {recipe['gold_cost']} gold."}
        if category == "permanent_potions":
            consumed = player.get("consumed_permanent", [])
            if recipe_name in consumed:
                return {"success": False, "message": f"Already consumed {recipe_name}."}
            max_consumed = recipe.get("max_consumed", 1)
            if len([p for p in consumed if p == recipe_name]) >= max_consumed:
                return {"success": False, "message": f"Max consumed {max_consumed} of this potion."}
        for mat, count_needed in recipe["materials"].items():
            removed = 0
            new_inv = []
            for i in inv:
                if i["name"] == mat and removed < count_needed:
                    removed += 1
                    continue
                new_inv.append(i)
            player["inventory"] = new_inv
        player["gold"] -= recipe["gold_cost"]
        if category in ["potions","buff_potions"]:
            result_item = copy.deepcopy(recipe["result"])
            player["inventory"].append(result_item)
            return {"success": True, "message": f"You brew {result_item['name']}!", "player": player}
        else:
            effect = recipe["result"]["effect"]
            value = recipe["result"]["value"]
            if effect == "permanent_hp_boost":
                player["maxHp"] += value
                player["hp"] += value
            elif effect == "permanent_attack_boost":
                player["attack_bonus"] += value
            elif effect == "permanent_defense_boost":
                player["defense_bonus"] += value
            player.setdefault("consumed_permanent", []).append(recipe_name)
            return {"success": True, "message": f"You drink the {recipe_name} and feel permanently stronger!", "player": player}
    elif action == "recycle":
        return {"success": True, "type": "recycle", "items": [{"name": i["name"], "type": i["type"]} for i in player["inventory"] if i.get("type") != "misc" or i.get("value",0) > 0]}
    else:
        return {"success": False, "message": "Unknown alchemist action."}

def tool_talk(args, state):
    mech = state["room_mechanics"]
    npc = mech.get("npc")
    if not npc:
        return {"success": False, "message": "No one here to talk to."}
    msg = npc.get("dialogue", f"{npc['name']} greets you.")
    if npc.get("quest_giver") and not mech.get("pending_quest"):
        quest = generate_llm_quest(npc['name'], mech['zone'], state['player']['level'], mech['room_id'])
        if quest:
            mech["pending_quest"] = quest
            msg += f" {npc['name']} offers you a quest: \"{quest['name']}\" – {quest['description']} (Reward: {quest['reward']['gold']} gold, {quest['reward']['xp']} XP). Accept? (say 'accept quest')"
    return {"success": True, "message": msg, "updated_room_mechanics": mech, "can_give_quest": bool(mech.get("pending_quest"))}

def tool_accept_quest(args, state):
    mech = state["room_mechanics"]
    quest = mech.get("pending_quest")
    if not quest:
        return {"success": False, "message": "No quest is currently offered."}
    player_quests = state.get("quests", [])
    player_quests.append(quest)
    mech["pending_quest"] = None
    return {"success": True, "message": f"You accept the quest: {quest['name']}.", "quests": player_quests, "updated_room_mechanics": mech}

def tool_buy(args, state):
    item_name = args.get("item_name")
    npc = state["room_mechanics"].get("npc")
    if not npc or not npc.get("vendor"):
        return {"success": False, "message": "No vendor here."}
    inventory = npc.get("inventory", [])
    item = find_item_by_name(item_name, inventory)
    if not item:
        return {"success": False, "message": f"{item_name} not for sale."}
    player = state["player"]
    if player["gold"] < item["value"]:
        return {"success": False, "message": f"Not enough gold. Need {item['value']} gold."}
    player["gold"] -= item["value"]
    player["inventory"].append(copy.deepcopy(item))
    return {"success": True, "message": f"You bought {item['name']} for {item['value']} gold.", "player": player}

def tool_sell(args, state):
    item_name = args.get("item_name")
    player = state["player"]
    item = find_item_by_name(item_name, player["inventory"])
    if not item:
        return {"success": False, "message": f"You don't have {item_name}."}
    sell_price = max(1, item["value"] // 2)
    player["gold"] += sell_price
    player["inventory"] = [i for i in player["inventory"] if not (i["name"] == item["name"] and i.get("type") == item.get("type"))]
    return {"success": True, "message": f"You sold {item_name} for {sell_price} gold.", "player": player}

def cast_spell(args, state):
    spell = args.get("spell", "").lower()
    player = state["player"]
    mech = state["room_mechanics"]
    monster = mech.get("monster")
    if not spell:
        return {"success": False, "message": "Cast what?"}
    spell_power = player.get("spell_power", 0) + player.get("damage_bonus", 0)
    if spell == "lightning_bolt":
        if not monster or monster["hp"] <= 0:
            return {"success": False, "message": "No enemy to target."}
        damage = roll_dice("3d6")["total"] + spell_power
        monster["hp"] -= damage
        msg = f"You cast Lightning Bolt! The {monster['name']} takes {damage} damage."
        if monster["hp"] <= 0:
            msg += " It falls, smoking and defeated."
            mech["monster"] = None
            xp = monster.get("xp", 50)
            gold = random.randint(monster.get("gold_range", [10,30])[0], monster.get("gold_range", [10,30])[1])
            player["xp"] += xp
            player["gold"] += gold
            if monster.get("loot_table"):
                for entry in monster["loot_table"]:
                    if random.random() < entry.get("chance", 1.0):
                        player["inventory"].append(entry["item"])
            return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech, "monster_defeated": True}
        else:
            monster_roll = roll_dice("1d20")["total"] + monster["attack"]
            player_ac = 10 + player.get("defense_bonus", 0)
            if monster_roll >= player_ac:
                dmg = random.randint(monster["damage_range"][0], monster["damage_range"][1])
                player["hp"] -= dmg
                msg += f" The {monster['name']} retaliates and hits you for {dmg} damage!"
            else:
                msg += f" The {monster['name']} misses you."
            return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech, "damage": dmg}
    elif spell == "fireball":
        if not monster or monster["hp"] <= 0:
            return {"success": False, "message": "No enemy to target."}
        damage = roll_dice("4d6")["total"] + spell_power
        monster["hp"] -= damage
        msg = f"You cast Fireball! The {monster['name']} takes {damage} damage."
        if monster["hp"] <= 0:
            msg += " It is consumed by flames."
            mech["monster"] = None
            xp = monster.get("xp", 50)
            gold = random.randint(monster.get("gold_range", [10,30])[0], monster.get("gold_range", [10,30])[1])
            player["xp"] += xp
            player["gold"] += gold
            return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech, "monster_defeated": True}
        else:
            monster_roll = roll_dice("1d20")["total"] + monster["attack"]
            player_ac = 10 + player.get("defense_bonus", 0)
            if monster_roll >= player_ac:
                dmg = random.randint(monster["damage_range"][0], monster["damage_range"][1])
                player["hp"] -= dmg
                msg += f" The {monster['name']} retaliates and hits you for {dmg} damage!"
            else:
                msg += f" The {monster['name']} misses you."
            return {"success": True, "message": msg, "player": player, "updated_room_mechanics": mech, "damage": dmg}
    elif spell == "heal":
        heal_amount = random.randint(10, 30) + spell_power
        player["hp"] = min(player["maxHp"], player["hp"] + heal_amount)
        msg = f"You cast Heal and recover {heal_amount} HP."
        return {"success": True, "message": msg, "player": player}
    else:
        return {"success": False, "message": f"Unknown spell: {spell}"}

def generate_llm_quest(npc_name, zone, player_level, room_id):
    return {
        "id": f"q_fallback_{random.randint(10000,99999)}",
        "name": f"Help {npc_name}",
        "description": f"Defeat monsters in the {zone} zone.",
        "objectives": [{"type": "kill", "target": "any", "required": max(1, player_level//2), "current": 0}],
        "reward": {"gold": 50 + player_level*10, "xp": 60 + player_level*15},
        "completed": False,
        "failed": False,
        "started_room": room_id
    }

# ----------------------------------------------------------------------
# Tool dispatch table
# ----------------------------------------------------------------------
TOOLS = {
    "move": {"func": tool_move, "args": ["direction"]},
    "look": {"func": tool_look, "args": []},
    "attack": {"func": tool_combat_action, "args": ["action"]},
    "defend": {"func": tool_combat_action, "args": ["action"]},
    "flee": {"func": tool_combat_action, "args": ["action"]},
    "use": {"func": tool_use_wrapper, "args": ["item_name"]},
    "craft": {"func": tool_craft, "args": ["recipe_name"]},
    "recycle": {"func": tool_recycle, "args": ["item_name"]},
    "blacksmith_menu": {"func": tool_blacksmith_menu, "args": []},
    "blacksmith_action": {"func": tool_blacksmith_action, "args": ["action"]},
    "alchemist_menu": {"func": tool_alchemist_menu, "args": []},
    "alchemist_action": {"func": tool_alchemist_action, "args": ["action"]},
    "search": {"func": tool_search, "args": []},
    "take": {"func": tool_take, "args": ["item_name"]},
    "equip": {"func": tool_equip, "args": ["item_name"]},
    "rest": {"func": tool_rest, "args": []},
    "status": {"func": tool_status, "args": []},
    "inventory": {"func": tool_inventory, "args": []},
    "talk": {"func": tool_talk, "args": []},
    "accept_quest": {"func": tool_accept_quest, "args": []},
    "quest_log": {"func": tool_quest_log, "args": []},
    "lore": {"func": tool_lore, "args": []},
    "summary": {"func": tool_summary, "args": []},
    "roll_dice": {"func": lambda args, state: roll_dice(args.get("dice","1d20")), "args": ["dice"]},
    "cast_spell": {"func": cast_spell, "args": ["spell"]},
    "buy": {"func": tool_buy, "args": ["item_name"]},
    "sell": {"func": tool_sell, "args": ["item_name"]},
}

# ----------------------------------------------------------------------
# Main entry point
# ----------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command specified"}))
        sys.exit(1)

    command = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    if command == "generate_room":
        room_id = args.get("room", 0)
        player_level = args.get("player_level", 1)
        print(json.dumps(generate_room_mechanics(room_id, player_level)))

    elif command == "execute_tool":
        tool_name = args.get("tool")
        tool_args = args.get("args", {})
        state = args.get("state", {})
        if tool_name not in TOOLS:
            print(json.dumps({"success": False, "error": f"Unknown tool: {tool_name}"}))
            return
        tool = TOOLS[tool_name]
        missing = [arg for arg in tool["args"] if arg not in tool_args]
        if missing:
            print(json.dumps({"success": False, "error": f"Missing args: {missing}"}))
            return
        try:
            result = tool["func"](tool_args, state)
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))

    elif command == "get_action_menu":
        print(json.dumps({"menu": []}))

    elif command == "validate_intent":
        print(json.dumps({"valid": True, "reason": ""}))

    elif command == "tool_summary":
        state = args.get("state", {})
        print(json.dumps(tool_summary({}, state)))

    elif command == "list_models":
        try:
            result = subprocess.run(['ollama','list'], capture_output=True, text=True, check=False)
            if result.returncode != 0 or not result.stdout.strip():
                print(json.dumps({"models": []}))
            else:
                lines = result.stdout.strip().split('\n')
                if len(lines) < 2:
                    print(json.dumps({"models": []}))
                else:
                    models = [line.split()[0] for line in lines[1:] if line.strip()]
                    print(json.dumps({"models": models}))
        except Exception:
            print(json.dumps({"models": []}))

    elif command == "cast_spell":
        result = cast_spell(args, args.get("state", {}))
        print(json.dumps(result))

    elif command == "generate_monster":
        zone = args.get("zone", "entrance")
        player_level = args.get("player_level", 1)
        is_minion = args.get("is_minion", False)
        room_id = args.get("room_id", 0)
        print(json.dumps(generate_monster(zone, player_level, is_minion, room_id)))

    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))

if __name__ == "__main__":
    main()
