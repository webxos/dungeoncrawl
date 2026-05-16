// dungeoncrawl.js – Infinite Dungeon with NLI-only mode (no LLM required)
import axios from 'axios';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PythonShell } from 'python-shell';
import dotenv from 'dotenv';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { resolveIntent } from './nli.js';
import { spellCorrectTokens } from './fuzz.js';
import { detectTier, TIER_CONFIG } from './model_tier.js';
import { C, box, dm, printStatus, printRoom, combatHeader, animateDiceRoll, restAnimation } from './tui.js';

dotenv.config();

// ---------- Configuration ----------
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/api/generate';
let currentModel = process.env.MODEL || 'qwen2.5:0.5b';
const LLM_TIMEOUT = parseInt(process.env.LLM_TIMEOUT) || 10000;
const LLM_MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES) || 1;
const PYTHON_CMD = process.env.PYTHON_CMD || 'python3';
const SOUL_FILE = process.env.SOUL_FILE || path.join(process.cwd(), 'character_soul.md');
const ERROR_LOG = process.env.JSON_ERROR_LOG || path.join(process.cwd(), 'dungeoncrawl_errors.ndjson');
const HISTORY_FILE = process.env.CHARACTER_HISTORY || path.join(process.cwd(), 'character_history.md');

// NEW: default to NLI-only (safe for no Ollama)
const ALWAYS_USE_LLM = process.env.ALWAYS_USE_LLM === 'true';   // false by default
const STREAM_LLM_RESPONSES = process.env.STREAM_LLM_RESPONSES === 'true';

const tier = detectTier(currentModel);
let tierCfg = TIER_CONFIG[tier] || TIER_CONFIG.small;
// Override if LLM fallback is explicitly disabled
if (process.env.LLM_FALLBACK_ENABLED === 'false') {
  tierCfg.llmFallback = false;
}
const NARRATOR_ENABLED = process.env.NARRATOR_ENABLED !== 'false' && tierCfg.narrator;
const QUEST_GEN_ENABLED = tierCfg.questGen;
const LLM_FALLBACK_ENABLED = tierCfg.llmFallback;

// ---------- Game State ----------
let playerName = '';
let currentRoom = 0;
let player = {
  hp: 100, maxHp: 100, gold: 50, inventory: [], level: 1, xp: 0, xpToNext: 100,
  attack_bonus: 0, defense_bonus: 0, damage_bonus: 0, weapon: null, armor: null,
  effects: [], alignment: 0, stat_choices: [],
  class: null,       // 'warrior', 'mage', 'rogue'
  perks: []          // array of perk names
};
let quests = [];
let lore = [];
let visited = new Set();
let currentRoomMechanics = null;
let roomCache = new Map();
let combatActive = false;
let consecutiveBattlesNoPotion = 0;

const rl = readline.createInterface({ input, output });

// ---------- Error Logging ----------
async function logError(severity, category, context, opts = {}) {
  const entry = { timestamp: new Date().toISOString(), severity, category, context: context.substring(0,2000), ...opts };
  try { await fs.appendFile(ERROR_LOG, JSON.stringify(entry) + '\n'); } catch(err) { console.error('Failed to write error log:', err.message); }
}

// ---------- Soul File Management ----------
let soulWriteQueue = Promise.resolve();
async function readSoul() {
  await soulWriteQueue;   // wait for any pending write
  try {
    const raw = await fs.readFile(SOUL_FILE, 'utf-8');
    const sections = raw.split(/^## /m);
    let persona = 'You are a brave dungeon adventurer.';
    let memory = [];
    let directives = '';
    for (const section of sections) {
      if (section.startsWith('VOICE')) persona = section.substring(5).trim();
      else if (section.startsWith('MEMORY')) {
        const lines = section.split('\n');
        memory = lines.filter(l => l.trim().startsWith('- ')).map(l => l.trim().substring(2).trim());
      } else if (section.startsWith('DIRECTIVES')) directives = section.substring(10).trim();
    }
    return { persona, memory, directives };
  } catch {
    const defaultSoul = {
      persona: 'You are a brave adventurer exploring a vast fantasy dungeon. You are courageous, curious, and eager to find treasure and glory. You speak in first person and respond to the Dungeon Master\'s narration.',
      memory: [`[${new Date().toISOString()}] You started your journey in Room 0.`],
      directives: '1. Always suggest 2 next actions.\n2. If HP < 30, recommend rest.\n3. If a monster is present, acknowledge it first.\n4. Do not invent rooms or exits.'
    };
    await writeSoul(defaultSoul, playerName);
    return defaultSoul;
  }
}
async function writeSoul(soul, playerName) {
  const name = playerName || 'Adventurer';
  const content = `# SOUL: ${name}\n\n## VOICE\n${soul.persona}\n\n## MEMORY\n${soul.memory.map(m => `- ${m}`).join('\n')}\n\n## DIRECTIVES\n${soul.directives}`;
  soulWriteQueue = soulWriteQueue.then(() => fs.writeFile(SOUL_FILE, content));
  return soulWriteQueue;
}
async function updateMemory(newEntry) {
  const soul = await readSoul();
  soul.memory.push(`[${new Date().toISOString()}] ${newEntry}`);
  if (soul.memory.length > 20) soul.memory = soul.memory.slice(-20);
  await writeSoul(soul, playerName);
}
async function appendHistory(entry) {
  await fs.appendFile(HISTORY_FILE, `- **${new Date().toISOString()}** ${entry}\n`);
}

// ---------- Class & Perks ----------
async function chooseClass() {
  console.log(`\n${C.bold}${C.yellow}Choose your class:${C.reset}`);
  console.log(`1. ${C.bold}Warrior${C.reset} – +10 HP, +2 Attack Bonus, +2 Damage Bonus`);
  console.log(`2. ${C.bold}Mage${C.reset}   – +2 Damage Bonus, +2 Attack Bonus`);
  console.log(`3. ${C.bold}Rogue${C.reset}  – +2 Defense Bonus, +2 Attack Bonus, +5 HP`);
  while (true) {
    const answer = await rl.question('Your choice (1-3): ');
    const choice = parseInt(answer);
    if (isNaN(choice) || choice < 1 || choice > 3) {
      console.log(`${C.red}Invalid choice. Please enter 1, 2, or 3.${C.reset}`);
      continue;
    }
    switch (choice) {
      case 1: // Warrior
        player.class = 'warrior';
        player.maxHp += 10;
        player.hp = player.maxHp;
        player.attack_bonus += 2;
        player.damage_bonus += 2;
        break;
      case 2: // Mage
        player.class = 'mage';
        player.damage_bonus += 2;
        player.attack_bonus += 2;
        break;
      case 3: // Rogue
        player.class = 'rogue';
        player.defense_bonus += 2;
        player.attack_bonus += 2;
        player.maxHp += 5;
        player.hp = player.maxHp;
        break;
    }
    console.log(`${C.green}You are now a ${player.class}!${C.reset}`);
    await appendHistory(`Chose class: ${player.class}`);
    break;
  }
}

async function choosePerk(level) {
  console.log(`\n${C.bold}${C.yellow}Choose a perk (Level ${level}):${C.reset}`);
  console.log(`1. +5 Max HP`);
  console.log(`2. +2 Attack Bonus`);
  console.log(`3. +2 Defense Bonus`);
  console.log(`4. +4 Damage Bonus`);
  console.log(`5. +10% Gold Find (passive)`);
  while (true) {
    const answer = await rl.question('Your choice (1-5): ');
    const choice = parseInt(answer);
    if (isNaN(choice) || choice < 1 || choice > 5) {
      console.log(`${C.red}Invalid choice. Please enter 1-5.${C.reset}`);
      continue;
    }
    let perkName = '';
    switch (choice) {
      case 1: perkName = 'Vitality'; player.maxHp += 5; player.hp += 5; break;
      case 2: perkName = 'Fury'; player.attack_bonus += 2; break;
      case 3: perkName = 'Toughness'; player.defense_bonus += 2; break;
      case 4: perkName = 'Might'; player.damage_bonus += 4; break;
      case 5: perkName = 'Lucky'; player.gold_find_multiplier = (player.gold_find_multiplier || 1) + 0.1; break;
    }
    player.perks.push(perkName);
    console.log(`${C.green}Perk "${perkName}" acquired!${C.reset}`);
    await appendHistory(`Gained perk: ${perkName}`);
    break;
  }
}

// ---------- Global Events ----------
async function triggerGlobalEvent(roomMechanics, player) {
  const chance = 0.15; // 15% chance per new room
  if (Math.random() > chance) return null;
  const eventType = Math.floor(Math.random() * 5);
  switch (eventType) {
    case 0: { // Wandering merchant
      dm("A traveling merchant appears out of the shadows!");
      const itemsForSale = [
        { name: "Lesser Health Potion", type: "consumable", effect: "heal", value: 10, price: 15, tier: "lesser" },
        { name: "Strength Potion", type: "consumable", effect: "buff", value: 2, price: 30 },
        { name: "Iron Dagger", type: "weapon", bonus: 2, value: 20, price: 25 }
      ];
      const item = itemsForSale[Math.floor(Math.random() * itemsForSale.length)];
      console.log(`${C.yellow}Merchant offers: ${item.name} for ${item.price} gold. Buy? (y/n)${C.reset}`);
      const answer = await rl.question('');
      if (answer.toLowerCase() === 'y' && player.gold >= item.price) {
        player.gold -= item.price;
        player.inventory.push(item);
        dm(`You bought ${item.name}.`);
      } else if (answer.toLowerCase() === 'y') {
        dm("Not enough gold.");
      } else {
        dm("The merchant shrugs and vanishes.");
      }
      return 'merchant';
    }
    case 1: { // Blessing
      const heal = Math.floor(player.maxHp * 0.3);
      player.hp = Math.min(player.maxHp, player.hp + heal);
      dm(`A divine light envelops you. You recover ${heal} HP.`);
      return 'blessing';
    }
    case 2: { // Curse
      const dmg = Math.floor(player.maxHp * 0.1);
      player.hp = Math.max(1, player.hp - dmg);
      dm(`Dark energy lashes out! You lose ${dmg} HP.`);
      return 'curse';
    }
    case 3: { // Gold shower
      const gold = Math.floor(Math.random() * 50) + 20;
      player.gold += gold;
      dm(`A shower of gold coins falls from above! You gain ${gold} gold.`);
      return 'gold';
    }
    case 4: { // Temporary effect
      player.effects.push({ name: "blessed", duration: 3, value: 2 });
      dm("An unseen spirit blesses you with +2 attack for 3 turns.");
      return 'bless_spirit';
    }
    default: return null;
  }
}

// ---------- Mini-Boss Upgrade ----------
function upgradeToMiniBoss(roomMechanics, roomId, playerLevel) {
  if (roomId % 15 !== 0) return roomMechanics;
  if (!roomMechanics.monster) return roomMechanics;
  const monster = roomMechanics.monster;
  monster.hp = Math.floor(monster.hp * 2);
  monster.max_hp = monster.hp;
  monster.attack = Math.floor(monster.attack * 1.5);
  monster.defense = Math.floor(monster.defense * 1.5);
  monster.xp = Math.floor(monster.xp * 2);
  monster.gold_range = [monster.gold_range[0] * 2, monster.gold_range[1] * 3];
  monster.name = `Mini-Boss: ${monster.name}`;
  monster.is_mini_boss = true;
  if (!monster.loot_table) monster.loot_table = [];
  monster.loot_table.push({ item: { name: "Mini-Boss Trophy", type: "misc", value: 50 }, chance: 1.0 });
  monster.loot_table.push({ item: { name: "Rare Essence", type: "misc", value: 25 }, chance: 0.8 });
  dm(`${C.red}⚠ A powerful Mini-Boss blocks your path!${C.reset}`);
  return roomMechanics;
}

// ---------- Quest Helpers ----------
function updateQuestProgress(quests, toolName, result, player, roomId, itemUsed, loreDiscovered = null) {
  return quests.map(q => {
    if (q.completed || q.failed) return q;
    const objectives = q.objectives.map(obj => {
      if (obj.current >= obj.required) return obj;
      switch (obj.type) {
        case 'kill':
          if (toolName === 'attack' && result.success && result.monster_defeated) {
            if (obj.target === 'any' || result.monster_name === obj.target || (obj.target === 'Minion' && result.is_minion))
              return { ...obj, current: obj.current + 1 };
          }
          break;
        case 'collect':
          if (toolName === 'take' && result.loot && result.loot.some(i => i.name === obj.target))
            return { ...obj, current: obj.current + 1 };
          break;
        case 'explore':
          if (toolName === 'move' && roomId >= obj.target)
            return { ...obj, current: obj.current + 1 };
          break;
        case 'craft':
          if (toolName === 'craft' && result.item_used === obj.target)
            return { ...obj, current: obj.current + 1 };
          break;
        case 'survive_battles':
          if (toolName === 'attack' && result.monster_defeated && !itemUsed?.includes('potion'))
            return { ...obj, current: obj.current + 1 };
          break;
      }
      return obj;
    });
    return { ...q, objectives };
  });
}
function checkQuestCompletion(quests, player) {
  const completedNames = [];
  let p = { ...player };
  const updated = quests.map(q => {
    if (q.completed || q.failed) return q;
    const allDone = q.objectives.every(o => o.current >= o.required);
    if (!allDone) return q;
    completedNames.push(q.name);
    p.gold += q.reward.gold;
    p.xp += q.reward.xp;
    if (q.reward.item) p.inventory.push(q.reward.item);
    return { ...q, completed: true };
  });
  return { quests: updated, player: p, completedNames };
}
function checkQuestFailure(quests, player, currentRoom, combatResult) {
  return quests.map(q => {
    if (q.completed || q.failed) return q;
    if (q.fail_conditions?.time_limit_rooms && (currentRoom - q.started_room) > q.fail_conditions.time_limit_rooms)
      return { ...q, failed: true };
    return q;
  });
}

// ---------- Utility ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function printIntro() {
  const title = `\u001b[37m\n▄                      ▜   \n▌▌▌▌▛▌▛▌█▌▛▌▛▌▛▘▛▘▀▌▌▌▌▐\n▙▘▙▌▌▌▙▌▙▖▙▌▌▌▙▖▌ █▌▚▚▘▐▖\n      ▄▌\n\u001b[0m`;
  console.log(title);
  console.log('\u001b[1;37m╔══════════════════════════════════════════════════════════════╗\u001b[0m');
  console.log('\u001b[1;37m║        D U N G E O N C R A W L   INFINITE v7.2               ║\u001b[0m');
  console.log('\u001b[1;37m║    Endless dungeon • Stacking inventory • LLM Quests         ║\u001b[0m');
  console.log('\u001b[1;37m╚══════════════════════════════════════════════════════════════╝\u001b[0m\n');
}  
      
// ---------- Python Tool Call ----------
async function callPythonTool(command, args = {}) {
  return new Promise((resolve, reject) => {
    const options = { mode: 'json', pythonPath: PYTHON_CMD, scriptPath: '.', args: [command, JSON.stringify(args)] };
    let stderrOutput = '';
    const pyshell = new PythonShell('game_engine.py', options);
    pyshell.on('stderr', data => { stderrOutput += data; });
    pyshell.on('error', err => reject(new Error(`Python error: ${err.message}\nStderr: ${stderrOutput}`)));
    const results = [];
    pyshell.on('message', message => results.push(message));
    pyshell.end(err => {
      if (err) reject(new Error(`Python shell error: ${err.message}\nStderr: ${stderrOutput}`));
      else if (results.length === 0) reject(new Error(`No output from Python\nStderr: ${stderrOutput}`));
      else resolve(results[0]);
    });
  });
}
async function safeToolCall(tool, args, fallback = null) {
  try {
    return await callPythonTool('execute_tool', { tool, args, state: buildGameState() });
  } catch (err) {
    await logError('error', 'python_tool', err.message, { tool, args: JSON.stringify(args) });
    return fallback !== null ? fallback : { success: false, message: `Tool "${tool}" failed: ${err.message}` };
  }
}

// ---------- LLM Calls (safely disabled) ----------
async function safeCallOllama(...args) {
  if (!ALWAYS_USE_LLM) return null;
  try {
    return await callOllama(...args);
  } catch (err) {
    await logError('warn', 'llm', 'Ollama unavailable', {error: err.message});
    return null;
  }
}

async function callOllama(prompt, system) {
  // This will only be called if ALWAYS_USE_LLM = true and Ollama is reachable.
  const payload = {
    model: currentModel,
    prompt, system,
    stream: false,
    format: 'json',
    options: { temperature: tierCfg.temperature, num_ctx: 768, num_predict: tierCfg.maxTokens }
  };
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(OLLAMA_ENDPOINT, payload, { timeout: LLM_TIMEOUT });
      const rawText = response.data.response.trim();
      let parsed = null;
      try { parsed = JSON.parse(rawText); } catch (e) {
        const jsonBlockMatch = rawText.match(/```(?:json)?\s*(\{.*?\})\s*```/s);
        if (jsonBlockMatch) try { parsed = JSON.parse(jsonBlockMatch[1]); } catch {}
        if (!parsed) {
          const firstBrace = rawText.indexOf('{');
          const lastBrace = rawText.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            try { parsed = JSON.parse(rawText.substring(firstBrace, lastBrace + 1)); } catch {}
          }
        }
        if (!parsed) {
          await logError('error', 'llm_json', 'LLM returned malformed JSON', { raw: rawText, context: `${system}\n\n${prompt}` });
          return { error: 'Malformed JSON response' };
        }
      }
      return parsed;
    } catch (err) {
      if (attempt < LLM_MAX_RETRIES) await sleep(Math.pow(2, attempt) * 1500);
      else {
        await logError('error', 'llm_json', 'LLM unavailable after retries', { raw: err.message, context: `${system}\n\n${prompt}` });
        return { error: 'LLM failed after retries' };
      }
    }
  }
  return null;
}

async function callOllamaStream(prompt, system, onToken) {
  if (!ALWAYS_USE_LLM) return '';
  // Stream implementation omitted for brevity – will be skipped anyway
  return '';
}

async function callOllamaText(prompt, system = '', temperature = null, maxTokens = null) {
  if (!ALWAYS_USE_LLM) return '';
  const temp = temperature ?? tierCfg.temperature;
  const tokens = maxTokens ?? tierCfg.maxTokens;
  const payload = { model: currentModel, prompt, system, stream: false, options: { temperature: temp, num_predict: tokens } };
  try {
    const response = await axios.post(OLLAMA_ENDPOINT, payload, { timeout: 5000 });
    return response.data.response?.trim() || '';
  } catch (err) {
    await logError('warn', 'llm_json', 'Text generation failed', { raw: err.message, context: prompt });
    return '';
  }
}

// ---------- Enhanced NPC Dialogue Generation ----------
async function generateNPCDialogue(npc, player, room) {
  if (!ALWAYS_USE_LLM) return npc.dialogue; // fallback to static dialogue
  const personality = npc.personality || 'mysterious and helpful';
  const role = npc.role || 'mysterious figure';
  const prompt = `You are ${npc.name}, a ${role} in a fantasy dungeon.
The player, ${playerName}, is a level ${player.level} ${player.class || 'adventurer'}.
Current room: ${room.description || 'a dark chamber'}.
Your personality: ${personality}.
Speak a few sentences of unique dialogue. Be concise, in character, and offer a hint about the dungeon or a quest.
Do not include any JSON or extra formatting.`;
  const system = "You are an immersive fantasy NPC. Speak naturally, in first person.";
  const dialogue = await callOllamaText(prompt, system, 0.8, 100);
  return dialogue.trim() || npc.dialogue;
}

// ---------- Enhanced Quest Generation (real LLM JSON) ----------
async function generateLLMQuest(npcName, zone, playerLevel, roomId) {
  if (!ALWAYS_USE_LLM) {
    // Fallback static quest
    return {
      id: `q_fallback_${Date.now()}`,
      name: `Help ${npcName}`,
      description: `Defeat monsters in the ${zone} zone.`,
      objectives: [{ type: "kill", target: "any", required: Math.max(1, playerLevel), current: 0 }],
      reward: { gold: 50 + playerLevel * 10, xp: 60 + playerLevel * 8 },
      completed: false, failed: false, started_room: roomId
    };
  }
  const prompt = `Generate a unique fantasy quest for a level ${playerLevel} adventurer.
Offered by: ${npcName} in the ${zone} zone.
Return a valid JSON object with exactly these fields:
{
  "name": "string (short, exciting)",
  "description": "string (one sentence)",
  "objectives": [{"type": "kill|collect|explore", "target": "monster or item name", "required": number}],
  "reward": {"gold": number, "xp": number, "item": {"name": "string", "type": "weapon|armor|consumable", "bonus": number, "value": number} | null}
}
Make it balanced. Reward gold ≈ 50-200, xp ≈ 60-250. Use only one objective.`;
  const system = "You are a quest generator. Output only valid JSON. No extra text.";
  const response = await callOllama(prompt, system);
  if (response && !response.error && response.name) {
    return {
      id: `q_${Date.now()}_${Math.floor(Math.random()*10000)}`,
      name: response.name,
      description: response.description,
      objectives: response.objectives.map(o => ({ ...o, current: 0 })),
      reward: response.reward,
      completed: false,
      failed: false,
      started_room: roomId
    };
  }
  // fallback to static quest
  return {
    id: `q_fallback_${Date.now()}`,
    name: `Help ${npcName}`,
    description: `Defeat monsters in the ${zone} zone.`,
    objectives: [{ type: "kill", target: "any", required: Math.max(1, playerLevel), current: 0 }],
    reward: { gold: 50 + playerLevel * 10, xp: 60 + playerLevel * 8 },
    completed: false, failed: false, started_room: roomId
  };
}

// ---------- Generate Unique Magical Item (template fallback) ----------
async function generateUniqueMagicalItem(monsterName, playerLevel, zone) {
  // If LLM is disabled, return a simple template item
  if (!ALWAYS_USE_LLM || !QUEST_GEN_ENABLED) {
    return {
      name: `Mystic ${monsterName} Heart`,
      type: "ring",
      bonus: 2 + Math.floor(playerLevel / 5),
      value: 100 + playerLevel * 10,
      property: "Vitality",
      unique: true,
      consumable: false,
      description: "A rare magical item."
    };
  }
  // Otherwise try LLM
  const prompt = `Create a unique magical item...`; // full prompt omitted for brevity
  const response = await safeCallOllama(prompt, "You are a fantasy item generator. Output only valid JSON.");
  if (response && !response.error) {
    return {
      name: response.name,
      type: response.type,
      bonus: response.bonus,
      value: response.value,
      property: response.property,
      unique: true,
      consumable: false,
      description: `Unique magical ${response.type} with ${response.property} property (+${response.bonus})`
    };
  }
  return {
    name: `Mystic ${monsterName} Heart`,
    type: "ring",
    bonus: 2 + Math.floor(playerLevel / 5),
    value: 100 + playerLevel * 10,
    property: "Vitality",
    unique: true,
    consumable: false,
    description: "A rare magical item."
  };
}

// ---------- Narration (disabled if ALWAYS_USE_LLM false) ----------
async function narrateResult(toolName, toolResult, playerName, roomDesc, activeQuestHint = '') {
  if (!NARRATOR_ENABLED) return toolResult.message || "The dungeon stirs...";
  // We'll skip narration to keep game fast
  return toolResult.message || "The dungeon stirs...";
}

// ---------- Agent Step – NLI-first, LLM optional ----------
const VALID_TOOLS = ['move','look','attack','search','rest','status','inventory','take','equip','use','flee','defend','talk','quest_log','lore','craft','accept_quest','recycle','blacksmith_menu','alchemist_menu','buy','sell'];

async function runAgentStep(userInput, conversationHistory, state) {
  // 1. Try NLI (deterministic, zero latency)
  let intent = resolveIntent(userInput);
  if (intent) {
    // Validate quickly
    const validation = await callPythonTool('validate_intent', { tool: intent.tool, args: intent.args, state }).catch(() => ({ valid: true }));
    if (validation.valid === false) {
      return { answer: validation.reason || "You can't do that right now." };
    }
    return { toolName: intent.tool, args: intent.args, source: 'nli' };
  }

  // 2. Spell correction fallback
  const corrected = spellCorrectTokens(userInput);
  if (corrected.corrected !== userInput.toLowerCase()) {
    intent = resolveIntent(corrected.corrected);
    if (intent) {
      const validation = await callPythonTool('validate_intent', { tool: intent.tool, args: intent.args, state }).catch(() => ({ valid: true }));
      if (validation.valid !== false) {
        return { toolName: intent.tool, args: intent.args, source: 'nli' };
      }
    }
  }

  // 3. Optionally fall back to LLM if explicitly enabled
  if (ALWAYS_USE_LLM && LLM_FALLBACK_ENABLED) {
    try {
      // Build system prompt with tools and state
      const stateSummary = await callPythonTool('tool_summary', { state }).then(r => r.summary || '').catch(() => '');
      const actionMenu = await callPythonTool('get_action_menu', { state }).then(r => r.menu || []).catch(() => []);
      const toolDescriptions = VALID_TOOLS.map(tool => {
        if (tool === 'move') return '- move {"direction": "north|south|east|west"}';
        if (tool === 'flee') return '- flee {"direction": "north|south|east|west"} (optional)';
        if (['take','equip','use','recycle','buy','sell'].includes(tool)) return `- ${tool} {"item_name": "item name"}`;
        if (tool === 'craft') return '- craft {"recipe_name": "recipe name"}';
        if (tool === 'accept_quest') return '- accept_quest {}';
        return `- ${tool} {}`;
      }).join('\n');
      const soul = await readSoul();
      const recentCtx = conversationHistory.slice(-3).map(h => `User: ${h.user}\nDM: ${h.summary || h.agent}`).join('\n');
      const playerStatus = `HP: ${state.player.hp}/${state.player.maxHp}, Gold: ${state.player.gold}, Level: ${state.player.level}, XP: ${state.player.xp}/${state.player.xpToNext}`;
      const roomDesc = state.room_mechanics?.description || "Unknown room.";
      const monsterInfo = state.room_mechanics?.monster ? `Monster: ${state.room_mechanics.monster.name} (HP: ${state.room_mechanics.monster.hp}/${state.room_mechanics.monster.max_hp})` : "No monster in sight.";
      const exits = state.room_mechanics?.exits?.join(', ') || 'none';
      const inventoryShort = state.player.inventory.slice(0,5).map(i => i.name).join(', ') + (state.player.inventory.length > 5 ? '...' : '');

      const systemPrompt = `${soul.persona}
Current game state:
- Room: ${roomDesc}
- Exits: ${exits}
- ${monsterInfo}
- ${playerStatus}
- Inventory (first few): ${inventoryShort || 'empty'}
- State summary: ${stateSummary}

Available tools (JSON only):
${toolDescriptions}

Respond with {"tool": "tool_name", "args": {...}} or {"answer": "your message"}. Do not add extra text.`;

      const userPrompt = `${recentCtx}
User: ${userInput}
Your JSON response:`;

      const llmResp = await safeCallOllama(userPrompt, systemPrompt);
      if (llmResp && !llmResp.error) {
        if (llmResp.answer && typeof llmResp.answer === 'string') {
          return { answer: llmResp.answer, source: 'llm' };
        }
        const toolName = llmResp.tool;
        let args = llmResp.args || {};
        if (toolName && VALID_TOOLS.includes(toolName)) {
          return { toolName, args, source: 'llm' };
        }
      }
    } catch (err) {
      await logError('warn', 'llm_fallback', 'LLM unavailable, using core fallback', {input: userInput});
    }
  }

  // 4. Ultimate fallback - treat as "look" and show help tip
  return { 
    toolName: 'look', 
    args: {}, 
    source: 'fallback',
    answer: "I didn't understand that command. Try: go north, attack, search, rest, status, inventory, talk, or /help" 
  };
}

// ---------- Model Switching (optional) ----------
async function switchModel() {
  console.log('\nFetching installed Ollama models...');
  const result = await callPythonTool('list_models').catch(err => { console.log(`\x1b[31mError: ${err.message}\x1b[0m`); return null; });
  if (!result || result.error) { console.log(`\x1b[31mCould not get model list. Is ollama installed? Error: ${result?.error}\x1b[0m`); return; }
  const models = result.models;
  if (!models.length) { console.log('\x1b[31mNo models found. Please install a model with `ollama pull <name>`.\x1b[0m'); return; }
  console.log('\nAvailable models:');
  models.forEach((m, i) => console.log(`  ${i+1}. ${m}`));
  const answer = await rl.question('\nEnter the number of the model to switch to (or press Enter to cancel): ');
  const choice = parseInt(answer);
  if (isNaN(choice) || choice < 1 || choice > models.length) { console.log('No change.'); return; }
  currentModel = models[choice-1];
  console.log(`\x1b[32mSwitched to model: ${currentModel}\x1b[0m`);
}

// ---------- Save/Load ----------
async function saveGame() {
  const saveData = { playerName, currentRoom, player: JSON.parse(JSON.stringify(player)), visited: Array.from(visited), room_mechanics: currentRoomMechanics, roomCache: Array.from(roomCache.entries()), quests, lore, combat_active: combatActive };
  await fs.writeFile('dungeoncrawl_save.json', JSON.stringify(saveData, null, 2));
  console.log('\x1b[32mAdventure saved!\x1b[0m');
}
async function loadGame() {
  try {
    const data = JSON.parse(await fs.readFile('dungeoncrawl_save.json', 'utf8'));
    playerName = data.playerName; currentRoom = data.currentRoom; player = data.player; visited = new Set(data.visited); currentRoomMechanics = data.room_mechanics; roomCache = new Map(data.roomCache || []); quests = data.quests || []; lore = data.lore || []; combatActive = data.combat_active || false;
    if (!currentRoomMechanics) { console.log('\x1b[33mWarning: Saved room mechanics missing. Regenerating...\x1b[0m'); currentRoomMechanics = await callPythonTool('generate_room', { room: currentRoom, player_level: player.level }); roomCache.set(currentRoom, currentRoomMechanics); }
    console.log('\x1b[32mAdventure loaded!\x1b[0m'); return true;
  } catch { return false; }
}

// ---------- Level Up ----------
async function chooseLevelUpBonus() {
  console.log(`\n${C.bold}${C.yellow}Choose your level ${player.level} bonus:${C.reset}`);
  console.log(`1. +2 Attack Bonus\n2. +2 Defense Bonus\n3. +4 Damage Bonus\n4. +10 Max HP`);
  while (true) {
    const answer = await rl.question('Your choice (1-4): ');
    const choice = parseInt(answer);
    if (isNaN(choice) || choice < 1 || choice > 4) {
      console.log(`${C.red}Invalid choice. Please enter 1, 2, 3, or 4.${C.reset}`);
      continue;
    }
    switch (choice) {
      case 1: player.attack_bonus += 2; break;
      case 2: player.defense_bonus += 2; break;
      case 3: player.damage_bonus += 4; break;
      case 4: player.maxHp += 10; player.hp += 10; break;
    }
    player.stat_choices.push(choice);
    console.log(`${C.green}Bonus applied!${C.reset}`);
    break;
  }
}
async function checkLevelUp() {
  while (player.xp >= player.xpToNext) {
    player.level++;
    player.xp -= player.xpToNext;
    player.xpToNext = 100 + 20 * (player.level - 1);
    player.maxHp += 10;
    player.hp = player.maxHp;
    console.log(`\n\x1b[33m***** LEVEL UP! *****\x1b[0m\n\x1b[32mYou are now level ${player.level}! Max HP increased to ${player.maxHp}.\x1b[0m`);
    await chooseLevelUpBonus();
    if (player.level % 3 === 0) await choosePerk(player.level);
    await appendHistory(`Reached level ${player.level} and gained a bonus.`);
    await updateMemory(`Reached level ${player.level}!`);
  }
}

// ---------- Apply Tool Result (with unique magical drops) ----------
async function applyToolResult(state, toolResult, toolName) {
  let newState = { ...state };
  if (!(newState.visited instanceof Set)) newState.visited = new Set(newState.visited);
  if (toolResult.new_room !== undefined) {
    newState.currentRoom = toolResult.new_room;
    if (roomCache.has(newState.currentRoom)) newState.room_mechanics = roomCache.get(newState.currentRoom);
    else { newState.room_mechanics = toolResult.room_mechanics; roomCache.set(newState.currentRoom, newState.room_mechanics); }
    newState.room_mechanics = upgradeToMiniBoss(newState.room_mechanics, newState.currentRoom, newState.player.level);
    newState.visited.add(newState.currentRoom);
    await triggerGlobalEvent(newState.room_mechanics, newState.player);
    await appendHistory(`Moved to Room ${newState.currentRoom} (${newState.room_mechanics.zone})`);
  }
  if (toolResult.updated_room_mechanics) { newState.room_mechanics = toolResult.updated_room_mechanics; roomCache.set(newState.currentRoom, newState.room_mechanics); }
  if (toolResult.player) newState.player = toolResult.player;
  else {
    if (toolResult.damage) newState.player.hp -= toolResult.damage;
    if (toolResult.heal) newState.player.hp = Math.min(newState.player.maxHp, newState.player.hp + toolResult.heal);
    if (toolResult.gold) {
      let multiplier = newState.player.gold_find_multiplier || 1;
      newState.player.gold += Math.floor(toolResult.gold * multiplier);
    }
    if (toolResult.xp) newState.player.xp += toolResult.xp;
    if (toolResult.loot) {
      const lootItems = Array.isArray(toolResult.loot) ? toolResult.loot : [toolResult.loot];
      for (const item of lootItems) {
        if (item.unique_magical) {
          const uniqueItem = await generateUniqueMagicalItem(item.monster_name || "unknown", newState.player.level, newState.room_mechanics?.zone || "unknown");
          newState.player.inventory.push(uniqueItem);
          await appendHistory(`Found unique magical item: ${uniqueItem.name} (+${uniqueItem.bonus}, ${uniqueItem.property})`);
        } else {
          newState.player.inventory.push(item);
        }
      }
      await appendHistory(`Found: ${lootItems.map(i => i.name).join(', ')}`);
    }
    if (toolResult.effects) newState.player.effects = toolResult.effects;
    if (toolResult.weapon) newState.player.weapon = toolResult.weapon;
    if (toolResult.armor) newState.player.armor = toolResult.armor;
  }
  if (toolResult.quests) newState.quests = toolResult.quests;
  if (toolResult.lore) newState.lore = toolResult.lore;
  newState.combat_active = !!(newState.room_mechanics?.monster && newState.room_mechanics.monster.hp > 0);
  if (!newState.combat_active && toolName === 'attack' && toolResult.monster_defeated) consecutiveBattlesNoPotion++;
  else if (toolName === 'use' && toolResult.item_used?.includes('potion')) consecutiveBattlesNoPotion = 0;

  let loreDiscovered = toolResult.lore?.[0] || null;
  let updatedQuests = updateQuestProgress(newState.quests, toolName, toolResult, newState.player, newState.currentRoom, toolResult.item_used, loreDiscovered);
  updatedQuests = checkQuestFailure(updatedQuests, newState.player, newState.currentRoom, toolResult);
  const { quests: completedQuests, player: updatedPlayer, completedNames } = checkQuestCompletion(updatedQuests, newState.player);
  newState.quests = completedQuests;
  newState.player = updatedPlayer;
  for (const qname of completedNames) {
    await appendHistory(`Completed quest: ${qname}`);
    await updateMemory(`Completed quest: ${qname}`);
    const quest = newState.quests.find(q => q.name === qname);
    if (quest) {
      const rewardStr = `${quest.reward.gold} gold, ${quest.reward.xp} XP${quest.reward.item ? ', ' + quest.reward.item.name : ''}`;
      console.log(`\n\x1b[33mQuest Complete!\x1b[0m\nYou completed "${qname}" and received ${rewardStr}.\n`);
    }
  }
  return newState;
}

function buildGameState() {
  return { room: currentRoom, currentRoom, room_mechanics: currentRoomMechanics, player, combat_active: combatActive, quests, lore };
}

// ---------- Blacksmith / Alchemist Handlers ----------
async function handleBlacksmith() {
  const menuResult = await safeToolCall('blacksmith_menu', {});
  if (!menuResult.success) { console.log(`\x1b[31m${menuResult.message}\x1b[0m`); return; }
  const menu = menuResult.menu;
  while (true) {
    console.log(`\n${C.bold}${C.yellow}Blacksmith Menu${C.reset}`);
    for (let i=0; i<menu.length; i++) console.log(`${i+1}. ${menu[i].name} - ${menu[i].description}`);
    const choice = await rl.question('Choose an option (or "exit" to leave): ');
    if (choice.toLowerCase() === 'exit') break;
    const idx = parseInt(choice)-1;
    if (isNaN(idx) || idx<0 || idx>=menu.length) { console.log('Invalid choice.'); continue; }
    const action = menu[idx].id;
    const actionResult = await safeToolCall('blacksmith_action', { action });
    if (!actionResult.success) { console.log(`\x1b[31m${actionResult.message}\x1b[0m`); continue; }
    if (actionResult.type === 'craft_weapon' || actionResult.type === 'craft_armor') {
      const recipes = actionResult.recipes;
      console.log(`\n${C.bold}Available recipes:${C.reset}`);
      for (let i=0; i<recipes.length; i++) {
        const r = recipes[i];
        const mats = Object.entries(r.materials).map(([name,count]) => `${count}x ${name}`).join(', ');
        console.log(`${i+1}. ${r.name} - Cost: ${r.gold_cost} gold, Materials: ${mats} -> ${r.result.name}`);
      }
      const recipeChoice = await rl.question('Choose recipe number (or 0 to cancel): ');
      const recipeIdx = parseInt(recipeChoice)-1;
      if (recipeIdx>=0 && recipeIdx<recipes.length) {
        const recipe = recipes[recipeIdx];
        const craftResult = await safeToolCall('blacksmith_action', { action: 'craft_selected', recipe_name: recipe.name });
        if (craftResult.success) { console.log(`\x1b[32m${craftResult.message}\x1b[0m`); player = craftResult.player; }
        else console.log(`\x1b[31m${craftResult.message}\x1b[0m`);
      }
    } else if (actionResult.type === 'upgrade_artifact') {
      const artifacts = actionResult.artifacts;
      if (artifacts.length === 0) { console.log('No artifacts to upgrade.'); continue; }
      console.log(`\n${C.bold}Artifacts:${C.reset}`);
      for (let i=0; i<artifacts.length; i++) console.log(`${i+1}. ${artifacts[i].name} (upgrade level ${artifacts[i].upgrade_level}, +${artifacts[i].bonus})`);
      const artifactChoice = await rl.question('Choose artifact number (or 0 to cancel): ');
      const artifactIdx = parseInt(artifactChoice)-1;
      if (artifactIdx>=0 && artifactIdx<artifacts.length) {
        const artifact = artifacts[artifactIdx];
        const upgradeResult = await safeToolCall('blacksmith_action', { action: 'upgrade_selected', artifact_name: artifact.name });
        if (upgradeResult.success) { console.log(`\x1b[32m${upgradeResult.message}\x1b[0m`); player = upgradeResult.player; }
        else console.log(`\x1b[31m${upgradeResult.message}\x1b[0m`);
      }
    } else if (actionResult.type === 'recycle') {
      const items = actionResult.items;
      if (items.length === 0) { console.log('No items to recycle.'); continue; }
      console.log(`\n${C.bold}Items to recycle:${C.reset}`);
      for (let i=0; i<items.length; i++) console.log(`${i+1}. ${items[i].name} (${items[i].type})`);
      const itemChoice = await rl.question('Choose item number (or 0 to cancel): ');
      const itemIdx = parseInt(itemChoice)-1;
      if (itemIdx>=0 && itemIdx<items.length) {
        const recycleResult = await safeToolCall('recycle', { item_name: items[itemIdx].name });
        if (recycleResult.success) { console.log(`\x1b[32m${recycleResult.message}\x1b[0m`); player = recycleResult.player; }
        else console.log(`\x1b[31m${recycleResult.message}\x1b[0m`);
      }
    }
  }
}
async function handleAlchemist() {
  const menuResult = await safeToolCall('alchemist_menu', {});
  if (!menuResult.success) { console.log(`\x1b[31m${menuResult.message}\x1b[0m`); return; }
  const menu = menuResult.menu;
  while (true) {
    console.log(`\n${C.bold}${C.green}Alchemist Menu${C.reset}`);
    for (let i=0; i<menu.length; i++) console.log(`${i+1}. ${menu[i].name} - ${menu[i].description}`);
    const choice = await rl.question('Choose an option (or "exit" to leave): ');
    if (choice.toLowerCase() === 'exit') break;
    const idx = parseInt(choice)-1;
    if (isNaN(idx) || idx<0 || idx>=menu.length) { console.log('Invalid choice.'); continue; }
    const action = menu[idx].id;
    const actionResult = await safeToolCall('alchemist_action', { action });
    if (!actionResult.success) { console.log(`\x1b[31m${actionResult.message}\x1b[0m`); continue; }
    if (actionResult.type === 'brew_potion' || actionResult.type === 'brew_buff' || actionResult.type === 'brew_permanent') {
      const recipes = actionResult.recipes;
      console.log(`\n${C.bold}Available recipes:${C.reset}`);
      for (let i=0; i<recipes.length; i++) {
        const r = recipes[i];
        const mats = Object.entries(r.materials).map(([name,count]) => `${count}x ${name}`).join(', ');
        console.log(`${i+1}. ${r.name} - Cost: ${r.gold_cost} gold, Materials: ${mats} -> ${r.result.name || r.result.effect}`);
      }
      const recipeChoice = await rl.question('Choose recipe number (or 0 to cancel): ');
      const recipeIdx = parseInt(recipeChoice)-1;
      if (recipeIdx>=0 && recipeIdx<recipes.length) {
        const recipe = recipes[recipeIdx];
        let potionType = 'potion';
        if (actionResult.type === 'brew_buff') potionType = 'buff';
        else if (actionResult.type === 'brew_permanent') potionType = 'permanent';
        const brewResult = await safeToolCall('alchemist_action', { action: 'brew_selected', recipe_name: recipe.name, potion_type: potionType });
        if (brewResult.success) { console.log(`\x1b[32m${brewResult.message}\x1b[0m`); player = brewResult.player; }
        else console.log(`\x1b[31m${brewResult.message}\x1b[0m`);
      }
    } else if (actionResult.type === 'recycle') {
      const items = actionResult.items;
      if (items.length === 0) { console.log('No items to recycle.'); continue; }
      console.log(`\n${C.bold}Items to recycle:${C.reset}`);
      for (let i=0; i<items.length; i++) console.log(`${i+1}. ${items[i].name} (${items[i].type})`);
      const itemChoice = await rl.question('Choose item number (or 0 to cancel): ');
      const itemIdx = parseInt(itemChoice)-1;
      if (itemIdx>=0 && itemIdx<items.length) {
        const recycleResult = await safeToolCall('recycle', { item_name: items[itemIdx].name });
        if (recycleResult.success) { console.log(`\x1b[32m${recycleResult.message}\x1b[0m`); player = recycleResult.player; }
        else console.log(`\x1b[31m${recycleResult.message}\x1b[0m`);
      }
    }
  }
}
async function handleRecycle() {
  const recycleMenu = await safeToolCall('blacksmith_action', { action: 'recycle' });
  if (!recycleMenu.success) { console.log(`\x1b[31m${recycleMenu.message}\x1b[0m`); return; }
  const items = recycleMenu.items;
  if (items.length === 0) { console.log('No items to recycle.'); return; }
  console.log(`\n${C.bold}Items to recycle:${C.reset}`);
  for (let i=0; i<items.length; i++) console.log(`${i+1}. ${items[i].name} (${items[i].type})`);
  const itemChoice = await rl.question('Choose item number (or 0 to cancel): ');
  const idx = parseInt(itemChoice)-1;
  if (idx>=0 && idx<items.length) {
    const recycleResult = await safeToolCall('recycle', { item_name: items[idx].name });
    if (recycleResult.success) { console.log(`\x1b[32m${recycleResult.message}\x1b[0m`); player = recycleResult.player; }
    else console.log(`\x1b[31m${recycleResult.message}\x1b[0m`);
  }
}

// ---------- Rest ----------
async function handleRest() {
  if (combatActive) { dm("You cannot rest while enemies are nearby! Fight or flee first."); return; }
  if (player.hp === player.maxHp) { dm("You are already at full health."); return; }
  const healAmount = Math.floor(player.maxHp * 0.4) + player.level * 2;
  const oldHp = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + healAmount);
  const actualHeal = player.hp - oldHp;
  dm(`You rest and recover ${actualHeal} HP.`);
  const zone = currentRoomMechanics?.zone;
  if (zone && (zone === 'mid' || zone === 'deep' || zone.startsWith('abyss') || zone.startsWith('void'))) {
    if (Math.random() < 0.3) {
      dm("Your rest is disturbed by a wandering monster!");
      const newMonster = await callPythonTool('generate_monster', { zone, player_level: player.level, is_minion: Math.random() < 0.2, room_id: currentRoom });
      if (newMonster) { currentRoomMechanics.monster = newMonster; combatActive = true; console.log(`\x1b[31m⚔️ A ${newMonster.name} attacks!${C.reset}`); }
    }
  }
  await updateMemory(`Rested and healed ${actualHeal} HP.`);
  await appendHistory(`Rested and healed ${actualHeal} HP.`);
}

// ---------- Display Inventory with Stacking ----------
function displayInventory() {
  if (player.inventory.length === 0) { console.log('Inventory: empty'); return; }
  const stackMap = new Map();
  for (const item of player.inventory) {
    const key = `${item.name}|${item.type}`;
    if (stackMap.has(key)) {
      const existing = stackMap.get(key);
      existing.stack = (existing.stack || 1) + 1;
    } else {
      stackMap.set(key, { ...item, stack: 1 });
    }
  }
  const stackedItems = Array.from(stackMap.values());
  console.log('Inventory:');
  for (const item of stackedItems) {
    const stackStr = item.stack > 1 ? ` x${item.stack}` : '';
    const tierStr = item.tier ? ` (${item.tier})` : '';
    console.log(`  ${item.name}${tierStr}${stackStr} (${item.type}) - value: ${item.value} gold`);
  }
}

// ---------- Main Game Loop ----------
async function gameLoop() {
  printIntro();
  while (true) {
    const nameInput = await rl.question('What is your name, legendary adventurer? ');
    if (nameInput.startsWith('/')) {
      if (nameInput === '/help') console.log('Commands: /help, /inventory, /status, /quests, /lore, /save, /load, /equip, /craft, /dm, /guide, /roll, /cast, /alignment, /blacksmith, /alchemist, /recycle, quit');
      else if (nameInput === '/inventory') console.log('You have no inventory yet. Enter your name to start.');
      else if (nameInput === '/status') console.log('You have no stats yet. Enter your name to start.');
      else if (nameInput === '/guide') console.log('DungeonCrawl Guide: Type actions like "go north", "attack", "search", "craft Iron Sword". Use /status to see your stats. Save often with /save.');
      else if (nameInput === '/dm') console.log('Use /dm once the game starts to switch models.');
      else console.log('Unknown command. Enter your name to begin.');
    } else { playerName = nameInput; break; }
  }
  console.log(`\nWelcome, ${playerName}.\n`);
  await chooseClass();
  await readSoul();
  await writeSoul({ persona: `You are ${playerName}, a brave adventurer.`, memory: [`[${new Date().toISOString()}] You started your journey in Room 0.`], directives: '...' }, playerName);
  await appendHistory(`Started adventure as ${playerName}`);
  const loaded = await loadGame();
  if (!loaded) {
    currentRoom = 0; visited.add(currentRoom);
    try { currentRoomMechanics = await callPythonTool('generate_room', { room: currentRoom, player_level: player.level }); if (!currentRoomMechanics) throw new Error('Invalid room data'); }
    catch (err) { console.log('\x1b[31mError generating initial room. Using default.\x1b[0m'); await logError('error','python_tool','Initial room generation failed',{raw:err.message}); currentRoomMechanics = { room_id:0, zone:'entrance', type:'empty', exits:['north'], description:'A cold, dark room.', ambient:'', monster:null, ground_loot:[] }; }
    roomCache.set(currentRoom, currentRoomMechanics);
  } else if (!currentRoomMechanics) {
    console.log('\x1b[31mLoaded game has no room mechanics. Generating fallback.\x1b[0m');
    try { currentRoomMechanics = await callPythonTool('generate_room', { room: currentRoom, player_level: player.level }); }
    catch { currentRoomMechanics = { room_id: currentRoom, zone:'entrance', type:'empty', exits:['north'], description:'A cold, dark room.', ambient:'', monster:null, ground_loot:[] }; }
    roomCache.set(currentRoom, currentRoomMechanics);
  }
  const history = [];
  const lookResult = await safeToolCall('look', {}, { description: 'You are in a dark room (fallback).' });
  dm(lookResult.description || 'You are in a dark room.');
  printRoom(currentRoomMechanics);
  printStatus(player, currentRoomMechanics?.zone, currentModel);
  if (currentRoomMechanics.monster && currentRoomMechanics.monster.hp > 0) {
    combatActive = true;
    console.log(`\x1b[31m⚔️ Combat starts! ${currentRoomMechanics.monster.name} (HP: ${currentRoomMechanics.monster.hp}) attacks!\x1b[0m`);
    combatHeader(player.hp, player.maxHp, currentRoomMechanics.monster.name, currentRoomMechanics.monster.hp, currentRoomMechanics.monster.max_hp);
  }
  while (true) {
    const userInput = await rl.question('\x1b[33m> \x1b[0m');
    const lower = userInput.toLowerCase().trim();
    if (lower === 'quit' || lower === 'exit') { await saveGame(); console.log('\nFarewell, legend.\n'); break; }
    if (lower === '/save') { await saveGame(); continue; }
    if (lower === '/load') { await loadGame(); continue; }
    if (lower === '/dm') { await switchModel(); continue; }
    if (lower === '/status') {
      const alignmentText = player.alignment > 0 ? 'Good' : (player.alignment < 0 ? 'Evil' : 'Neutral');
      console.log(`HP: ${player.hp}/${player.maxHp} | Gold: ${player.gold} | Level: ${player.level} (XP: ${player.xp}/${player.xpToNext}) | Attack: +${player.attack_bonus} | Damage: +${player.damage_bonus} | Defense: +${player.defense_bonus} | Alignment: ${alignmentText} | Class: ${player.class || 'none'} | Perks: ${player.perks.join(', ') || 'none'}`);
      if (player.weapon) console.log(`Weapon: ${player.weapon.name}`);
      if (player.armor) console.log(`Armor: ${player.armor.name}`);
      if (player.effects.length) console.log(`Effects: ${player.effects.map(e => `${e.name} (${e.duration})`).join(', ')}`);
      continue;
    }
    if (lower === '/inventory') { displayInventory(); continue; }
    if (lower === '/quests') {
      if (quests.length === 0) console.log('No active quests.');
      else { quests.forEach(q => { console.log(`${q.completed ? '✓' : (q.failed ? '✗' : '○')} ${q.name}: ${q.description}`); q.objectives.forEach(obj => console.log(`   - ${obj.type} ${obj.target}: ${obj.current}/${obj.required}`)); }); }
      continue;
    }
    if (lower === '/lore') {
      if (lore.length === 0) console.log('You have not discovered any lore yet.');
      else { console.log('Lore fragments:'); lore.forEach((frag,i) => console.log(`  ${i+1}. ${frag}`)); }
      continue;
    }
    if (lower === '/equip') { console.log(`Equipment:\n  Weapon: ${player.weapon ? player.weapon.name : 'none'}\n  Armor: ${player.armor ? player.armor.name : 'none'}\nTo equip an item, type "equip <item name>"`); continue; }
    if (lower === '/craft') { console.log('Crafting recipes: Use /blacksmith for weapons/armor, /alchemist for potions.'); continue; }
    if (lower === '/guide') { console.log('Guide: Use commands like "go north", "attack", "search", "craft Iron Sword". In combat you can also "defend", "flee", "use <item>". Check /status, /inventory, /quests, /lore. Save with /save. Use /dm to change Ollama models. New: infinite dungeon – go north forever!'); continue; }
    if (lower === '/help') {
      const helpLines = [
        `${C.bold}MOVEMENT${C.reset}`,
        '  go north/south/east/west   n s e w',
        '',
        `${C.bold}EXPLORATION${C.reset}`,
        '  look  examine  search  loot  find',
        '',
        `${C.bold}COMBAT${C.reset}`,
        '  attack  fight  hit  strike',
        '  defend  block  parry',
        '  flee [direction]  run  retreat',
        '  use <item>',
        '',
        `${C.bold}INVENTORY & GEAR${C.reset}`,
        '  inventory  bag  items',
        '  take <item>   equip <item>   use <item>',
        '  craft <recipe>',
        '',
        `${C.bold}CRAFTING NPCs${C.reset}`,
        '  /blacksmith – forge weapons/armor, upgrade artifacts, recycle',
        '  /alchemist – brew potions (incl. permanent stat boosters), recycle',
        '  /recycle – quickly recycle an item',
        '',
        `${C.bold}INFO${C.reset}`,
        '  status  stats  hp',
        '  quests  journal',
        '  lore  knowledge',
        '',
        `${C.bold}NEW FEATURES${C.reset}`,
        '  rest        – partial heal (40% + 2/level)',
        '  Quest Books – rare loot that generates custom quests via local model',
        '  Flee improved: 75% base + 5% per level above monster',
        '  Minions now spawn 15% of rooms, loot chance reduced',
        '  Infinite dungeon – go north forever!',
        '',
        `${C.bold}SYSTEM${C.reset}`,
        '  /save  /load  /dm (model switch)  /help  quit',
        '',
        `${C.gray}Tip: Spell mistakes are auto-corrected. Try "attac" → "attack"${C.reset}`,
      ];
      box('DUNGEONCRAWL COMMANDS', helpLines, C.cyan);
      continue;
    }
    if (lower === '/roll') { const dice = userInput.substring(5).trim() || '1d20'; const result = await safeToolCall('roll_dice', { dice }).catch(err=>({error:err.message})); if (result.error) console.log(`\x1b[31mRoll error: ${result.error}\x1b[0m`); else { await animateDiceRoll(result.rolls, dice, result.total, result.modifier); console.log(`Result: ${result.total}`); } continue; }
    if (lower === '/cast') { const spell = userInput.substring(5).trim(); if (!spell) console.log('Cast what? Example: /cast fireball'); else { const result = await safeToolCall('cast_spell', { spell }).catch(err=>({error:err.message})); if (result.error) console.log(`\x1b[31mSpell error: ${result.error}\x1b[0m`); else console.log(`\x1b[35m${result.message}\x1b[0m`); } continue; }
    if (lower === '/alignment') { const alignmentText = player.alignment > 0 ? 'Good' : (player.alignment < 0 ? 'Evil' : 'Neutral'); console.log(`Your alignment: ${alignmentText} (${player.alignment})`); continue; }
    if (lower === '/blacksmith') { await handleBlacksmith(); continue; }
    if (lower === '/alchemist') { await handleAlchemist(); continue; }
    if (lower === '/recycle') { await handleRecycle(); continue; }
    if (lower === 'rest' || lower === '/rest') { await handleRest(); continue; }

    if (combatActive) console.log('(Combat: you can attack, defend, use item, or flee)');

    const state = buildGameState();
    const step = await runAgentStep(userInput, history, state);
    if (step.error) { console.log(`\x1b[31mThe agent is confused: ${step.error}. Please try again or rephrase.\x1b[0m`); continue; }

    if (step.toolName) {
      try {
        let toolResult;
        if (step.toolName === 'talk') {
          // --- FIRST, call the Python tool to get the base NPC data ---
          let talkResult = await safeToolCall('talk', step.args);
          if (talkResult.success && currentRoomMechanics?.npc) {
            // --- Generate dynamic dialogue if LLM enabled ---
            if (ALWAYS_USE_LLM) {
              const dynamicDialogue = await generateNPCDialogue(
                currentRoomMechanics.npc,
                player,
                currentRoomMechanics
              );
              talkResult.message = dynamicDialogue;
            }
            // --- Quest offering (now uses the enhanced LLM quest generator) ---
            if (talkResult.can_give_quest && !currentRoomMechanics.pending_quest) {
              const newQuest = await generateLLMQuest(
                currentRoomMechanics.npc.name,
                currentRoomMechanics.zone,
                player.level,
                currentRoom
              );
              currentRoomMechanics.pending_quest = newQuest;
              talkResult.message += `\n\n${currentRoomMechanics.npc.name} offers you a quest: "${newQuest.name}" – ${newQuest.description} (Reward: ${newQuest.reward.gold} gold, ${newQuest.reward.xp} XP). Accept? (say 'accept quest')`;
              talkResult.updated_room_mechanics = currentRoomMechanics;
            }
          }
          toolResult = talkResult;
        } else {
          toolResult = await safeToolCall(step.toolName, step.args);
        }
        if (toolResult.success) {
          let newState = await applyToolResult(state, toolResult, step.toolName);
          player = newState.player;
          currentRoom = newState.currentRoom;
          currentRoomMechanics = newState.room_mechanics;
          visited = new Set(newState.visited);
          quests = newState.quests;
          lore = newState.lore;
          combatActive = newState.combat_active;
          roomCache.set(currentRoom, currentRoomMechanics);
          await checkLevelUp();
          await updateMemory(`${step.toolName}: ${toolResult.message.substring(0,80)}`);
          await appendHistory(`${step.toolName}: ${toolResult.message.substring(0,120)}`);
          if (toolResult.dice) await animateDiceRoll(toolResult.dice.rolls, toolResult.dice.notation, toolResult.dice.total, toolResult.dice.modifier);
          if (toolResult.monster_dice) await animateDiceRoll(toolResult.monster_dice.rolls, toolResult.monster_dice.notation, toolResult.monster_dice.total, toolResult.monster_dice.modifier);
          let outputMessage = toolResult.message;
          if (NARRATOR_ENABLED) {
            const activeQuestHint = currentRoomMechanics?.quest_hint || '';
            const narration = await narrateResult(step.toolName, toolResult, playerName, currentRoomMechanics?.description || '', activeQuestHint);
            outputMessage = narration;
          }
          dm(outputMessage);
          printStatus(player, currentRoomMechanics?.zone, currentModel);
          if (toolResult.new_room !== undefined) printRoom(currentRoomMechanics);
          if (combatActive && currentRoomMechanics.monster && currentRoomMechanics.monster.hp > 0) combatHeader(player.hp, player.maxHp, currentRoomMechanics.monster.name, currentRoomMechanics.monster.hp, currentRoomMechanics.monster.max_hp);
          history.push({ user: userInput, agent: `[Used tool ${step.toolName}]`, summary: toolResult.message.substring(0,80), toolName: step.toolName, timestamp: new Date().toISOString() });
          if (history.length > 5) history.shift();
          if (player.hp <= 0) { console.log('\x1b[31mYou have died... Game over.\x1b[0m'); break; }
        } else { console.log(`\x1b[31mTool error: ${toolResult.error || toolResult.message}\x1b[0m`); }
      } catch (err) { await logError('error','python_tool',`Tool execution failed: ${err.message}`,{tool:step.toolName,room:currentRoom,playerLevel:player.level,raw:err.stack,state:JSON.stringify(state)}); console.log(`\x1b[31mPython call failed: ${err.message}\x1b[0m`); }
    } else if (step.answer) { console.log(`\nDungeon Master: ${step.answer}\n`); await updateMemory(`Direct answer: ${step.answer.substring(0,80)}`); await appendHistory(`Direct answer: ${step.answer.substring(0,120)}`); history.push({ user: userInput, agent: step.answer, summary: step.answer.substring(0,80), timestamp: new Date().toISOString() }); if (history.length > 5) history.shift(); }
  }
  rl.close();
}

gameLoop().catch(err => { console.error('Fatal error:', err); rl.close(); });
