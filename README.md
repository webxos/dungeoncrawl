```
▄                      ▜ 
▌▌▌▌▛▌▛▌█▌▛▌▛▌▛▘▛▘▀▌▌▌▌▐
▙▘▙▌▌▌▙▌▙▖▙▌▌▌▙▖▌ █▌▚▚▘▐▖
      ▄▌
```

**Infinite text-based RPG dungeon crawler with crafting, classes, quests, and optional AI narration.**

Built for terminal gameplay, smart natural language commands, and endless replayability.

![Terminal RPG](https://img.shields.io/badge/Terminal%20RPG-Epic%20Adventure-brightgreen)
![Version](https://img.shields.io/badge/version-7.2.0-blue)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![Python](https://img.shields.io/badge/Python-3.9%2B-blue)

---

## ✨ Features

### Core Gameplay
- **Infinite Dungeon** – Procedurally generated rooms that go on forever (`go north` forever)
- **Deep Zone System** – Entrance → Mid → Deep → Abyss → Void → Nightmare → Eternal → Boss
- **Expanded Monster System** – 50+ monster families with special abilities, elites, minions, and mini-bosses
- **Class System** – Warrior, Mage, Rogue with unique bonuses
- **Perk Progression** – Level up and choose powerful perks
- **Rich Combat** – Attack, Defend, Flee, Use items, Spells with dice rolls and animations

### Crafting & Economy
- **Blacksmith** – Forge weapons & armor from materials
- **Alchemist** – Brew healing, buff, and **permanent stat potions**
- **Rune Etching** – Apply powerful runes to gear
- **Set Bonuses** – Collect powerful armor sets (Void Walker, Dragon Knight, etc.)
- **Recycle System** – Break down unwanted items

### Immersion & Quality of Life
- **Smart NLI** – Natural language input with fuzzy spell correction (e.g. `attac` → `attack`)
- **Beautiful TUI** – Progress bars, dice animations, box borders, status strips
- **Quest System** – Dynamic and template-based quests
- **Persistent Soul** – Character memory and personality file
- **Optional LLM Narration** – Works great with or without Ollama

### Technical
- Zero-LLM fallback mode (perfect for low-resource machines)
- Python game engine + Node.js TUI
- Save / Load system
- Detailed error logging

---

## 🎮 Quick Start

### Prerequisites
- **Node.js** 18+
- **Python 3.9+**
- (Optional) Ollama + `qwen2.5:0.5b` for enhanced narration

### Installation

Put all files into a /dungeoncrawl/ folder on your system, then bash:

```bash
cd ~/dungeoncrawl/       #The folder you have the files in
```

# Install dependencies
```bash
npm install
```

### Run the Game

```bash
npm start
```

---

## 🕹️ Basic Commands

| Action              | Example Commands                     |
|---------------------|--------------------------------------|
| Movement            | `north`, `go east`, `n`, `e`        |
| Combat              | `attack`, `a`, `defend`, `flee`     |
| Exploration         | `look`, `search`, `take sword`      |
| Items               | `use potion`, `equip iron sword`    |
| Crafting            | `blacksmith`, `alchemist`, `craft Iron Sword` |
| Info                | `status`, `inventory`, `quests`     |
| Rest                | `rest`                               |
| Special             | `cast fireball`, `/roll`, `/help`   |

**Full command list**: Type `/help` in game.

---

## 🎯 Gameplay Tips

- **Explore deeply** – Better loot and stronger monsters appear in deeper zones
- **Craft early** – Iron gear makes a huge difference
- **Manage HP** – Use `rest` wisely, potions are life-savers
- **Collect sets** – Full armor sets grant powerful bonuses
- **Permanent potions** are extremely strong but limited

---

## 🔧 Tech Stack

- **Backend**: Python 3 (game engine, procedural generation)
- **Frontend**: Node.js + rich TUI
- **AI (optional)**: Ollama (local LLMs)
- **Dependencies**: `axios`, `python-shell`, `dotenv`

---

## 📜 License

MIT License

## Screenshots


![https://github.com/webxos/dungeoncrawl/blob/main/assets/screen1.png](https://github.com/webxos/lack/blob/main/assets/screen1.png)

![https://github.com/webxos/dungeoncrawl/blob/main/assets/screen2.png](https://github.com/webxos/lack/blob/main/assets/screen2.png)

