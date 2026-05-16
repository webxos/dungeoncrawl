// nli.js – deterministic intent mapper, zero latency, plus shorthand
// Updated for DungeonCrawl with class, perks, runes, summon, set bonuses, global events, and spells.
// FIX: Added 'action' argument for attack, defend, flee tools.

const INTENT_MAP = [
  // Movement – includes single letters
  {
    patterns: [
      /^go\s+(north|south|east|west)/i,
      /^move\s+(north|south|east|west)/i,
      /^exit\s+(north|south|east|west)/i,
      /^leave\s+(north|south|east|west)/i,
      /^(north|south|east|west)$/i,
      /^n$/i, /^s$/i, /^e$/i, /^w$/i,
    ],
    tool: 'move',
    extractArgs: (input) => {
      const m = input.match(/\b(north|south|east|west)\b/i);
      return m ? { direction: m[1].toLowerCase() } : null;
    }
  },
  // Look / describe
  {
    patterns: [/^look/i, /^describe/i, /^what('?s| is) here/i, /^where am i/i, /^examine/i, /^l$/i],
    tool: 'look',
    extractArgs: () => ({})
  },
  // Take specific item
  {
    patterns: [/^take\s+(.+)/i, /^get\s+(.+)/i],
    tool: 'take',
    extractArgs: (input) => {
      const m = input.match(/^take\s+(.+)/i) || input.match(/^get\s+(.+)/i);
      return m ? { item_name: m[1].trim() } : null;
    }
  },
  // Search / loot
  {
    patterns: [/^search/i, /^loot/i, /^find/i, /^check for/i, /^pick up/i],
    tool: 'search',
    extractArgs: () => ({})
  },
  // Attack – includes single 'a'
  {
    patterns: [/^attack/i, /^fight/i, /^hit/i, /^strike/i, /^kill/i, /^slay/i, /^a$/i],
    tool: 'attack',
    extractArgs: () => ({ action: 'attack' })   // FIX: add required action field
  },
  // Defend
  {
    patterns: [/^defend/i, /^block/i, /^parry/i, /^guard/i, /^d$/i],
    tool: 'defend',
    extractArgs: () => ({ action: 'defend' })   // FIX: add required action field
  },
  // Flee – includes single 'f'
  {
    patterns: [/^flee/i, /^run\s*(away)?$/i, /^retreat/i, /^escape/i, /^f$/i],
    tool: 'flee',
    extractArgs: (input) => {
      const m = input.match(/\b(north|south|east|west)\b/i);
      const args = { action: 'flee' };          // FIX: add required action field
      if (m) args.direction = m[1].toLowerCase();
      return args;
    }
  },
  // Use item
  {
    patterns: [/^use\s+(.+)/i],
    tool: 'use',
    extractArgs: (input) => {
      const m = input.match(/^use\s+(.+)/i);
      return m ? { item_name: m[1].trim() } : null;
    }
  },
  // Equip item
  {
    patterns: [/^equip\s+(.+)/i, /^wield\s+(.+)/i, /^wear\s+(.+)/i],
    tool: 'equip',
    extractArgs: (input) => {
      const m = input.match(/^(equip|wield|wear)\s+(.+)/i);
      return m ? { item_name: m[2].trim() } : null;
    }
  },
  // Craft item
  {
    patterns: [/^craft\s+(.+)/i, /^make\s+(.+)/i],
    tool: 'craft',
    extractArgs: (input) => {
      const m = input.match(/^(craft|make)\s+(.+)/i);
      return m ? { recipe_name: m[2].trim() } : null;
    }
  },
  // Talk to NPC
  {
    patterns: [/^talk/i, /^speak/i, /^converse/i, /^greet/i],
    tool: 'talk',
    extractArgs: () => ({})
  },
  // Get a quest
  {
    patterns: [/^get a quest/i, /^get quest/i, /^ask for quest/i, /^request quest/i],
    tool: 'talk',
    extractArgs: () => ({})
  },
  // Accept quest
  {
    patterns: [/^accept quest/i, /^take quest/i, /^yes,? (i )?accept/i, /^i will accept/i, /^i take the quest/i],
    tool: 'accept_quest',
    extractArgs: () => ({})
  },
  // Rest
  {
    patterns: [/^rest/i, /^heal/i, /^sleep/i, /^recover/i, /^camp/i],
    tool: 'rest',
    extractArgs: () => ({})
  },
  // Status
  {
    patterns: [/^(my )?(stats?|status|hp|health)/i, /^how (am i|is my health)/i],
    tool: 'status',
    extractArgs: () => ({})
  },
  // Inventory
  {
    patterns: [/^(my )?(inventory|bag|items|pack)/i, /^what do i (have|carry)/i],
    tool: 'inventory',
    extractArgs: () => ({})
  },
  // Quests
  {
    patterns: [/^quests?/i, /^journal/i, /^log/i],
    tool: 'quest_log',
    extractArgs: () => ({})
  },
  // Lore
  {
    patterns: [/^lore/i, /^knowledge/i, /^story/i],
    tool: 'lore',
    extractArgs: () => ({})
  },
  // Blacksmith
  {
    patterns: [/^blacksmith/i, /^forge/i, /^smith/i],
    tool: 'blacksmith_menu',
    extractArgs: () => ({})
  },
  // Alchemist
  {
    patterns: [/^alchemist/i, /^brew/i, /^potion/i],
    tool: 'alchemist_menu',
    extractArgs: () => ({})
  },
  // Recycle
  {
    patterns: [/^recycle/i, /^scrap/i, /^break down/i],
    tool: 'recycle',
    extractArgs: (input) => {
      const m = input.match(/^recycle\s+(.+)/i);
      return m ? { item_name: m[1].trim() } : {};
    }
  },
  // Buy / Sell
  {
    patterns: [/^buy\s+(.+)/i],
    tool: 'buy',
    extractArgs: (input) => {
      const m = input.match(/^buy\s+(.+)/i);
      return m ? { item_name: m[1].trim() } : null;
    }
  },
  {
    patterns: [/^sell\s+(.+)/i],
    tool: 'sell',
    extractArgs: (input) => {
      const m = input.match(/^sell\s+(.+)/i);
      return m ? { item_name: m[1].trim() } : null;
    }
  },
  // Class selection
  {
    patterns: [/^choose class (warrior|mage|rogue)/i, /^set class (warrior|mage|rogue)/i, /^become (warrior|mage|rogue)/i],
    tool: 'set_class',
    extractArgs: (input) => {
      const m = input.match(/(warrior|mage|rogue)/i);
      return m ? { class: m[1].toLowerCase() } : null;
    }
  },
  // Perks
  {
    patterns: [/^perks?$/i, /^show perks?/i, /^my perks?/i],
    tool: 'show_perks',
    extractArgs: () => ({})
  },
  // Rune etching
  {
    patterns: [/^rune etch\s+(.+)/i, /^apply rune\s+(.+)/i, /^etch rune\s+(.+)/i],
    tool: 'rune_etch',
    extractArgs: (input) => {
      const m = input.match(/rune etch\s+(.+)/i) || input.match(/apply rune\s+(.+)/i) || input.match(/etch rune\s+(.+)/i);
      return m ? { rune_name: m[1].trim() } : null;
    }
  },
  // Set bonuses
  {
    patterns: [/^set bonuses?/i, /^active sets?/i, /^my sets?/i],
    tool: 'show_sets',
    extractArgs: () => ({})
  },
  // Global events (manual)
  {
    patterns: [/^global event/i, /^trigger event/i],
    tool: 'global_event',
    extractArgs: () => ({})
  },
  // Roll with advantage/disadvantage
  {
    patterns: [/^roll (with )?advantage/i, /^adv d20/i],
    tool: 'roll_advantage',
    extractArgs: () => ({ dice: '1d20', advantage: true })
  },
  {
    patterns: [/^roll (with )?disadvantage/i, /^disadv d20/i],
    tool: 'roll_disadvantage',
    extractArgs: () => ({ dice: '1d20', disadvantage: true })
  },
  // Spell casting (without slash)
  {
    patterns: [/^cast fireball/i, /^fireball/i],
    tool: 'cast_spell',
    extractArgs: () => ({ spell: 'fireball' })
  },
  {
    patterns: [/^cast lightning bolt/i, /^lightning bolt/i, /^lightning_bolt/i],
    tool: 'cast_spell',
    extractArgs: () => ({ spell: 'lightning_bolt' })
  },
  {
    patterns: [/^cast slow/i, /^slow$/i],
    tool: 'cast_spell',
    extractArgs: () => ({ spell: 'slow' })
  },
  {
    patterns: [/^summon ally/i, /^summon spirit/i, /^summon helper/i, /^cast summon ally/i],
    tool: 'cast_spell',
    extractArgs: () => ({ spell: 'summon_ally' })
  },
  {
    patterns: [/^cast heal/i, /^heal me/i],
    tool: 'cast_spell',
    extractArgs: () => ({ spell: 'heal' })
  }
];

export function resolveIntent(input) {
  const trimmed = input.trim();
  for (const intent of INTENT_MAP) {
    for (const pat of intent.patterns) {
      if (pat.test(trimmed)) {
        const args = intent.extractArgs(trimmed);
        if (args !== null) return { tool: intent.tool, args, source: 'nli' };
      }
    }
  }
  return null;
}
