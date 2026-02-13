# Rift Architect

Multi-agent AI orchestrator for League of Legends. Three Claude-powered agents provide real-time coaching across every phase of a match — champion select, in-game, and post-game.

## What It Does

Rift Architect runs as a system-tray Electron app that detects the League client, tracks game phase transitions, and activates the right AI agent at the right time:

| Phase | Agent | Overlay | What It Does |
|-------|-------|---------|-------------|
| Champion Select | **Drafting Oracle** | Right-side panel | Ban/pick recommendations with meta tier data, blind/counter/synergy classification |
| In-Game | **Macro Strategist** | Top-right toasts | Strategic calls based on live game state (objectives, gold, events) |
| In-Game | **Spell Tracker** | Tab-toggle widget | Enemy summoner spell cooldown tracking with haste-adjusted timers |
| Post-Game | **Tilt Guard** | Right-side panel | Performance review, tilt detection, session wellness tracking |

## Vanguard Safe

Rift Architect only uses official Riot APIs:
- **LCU API** (local lockfile + WebSocket) for client state and champion select data
- **Live Client Data API** (port 2999) for in-game read-only spectator data
- **Riot Cloud REST API** for match history, mastery, and ranked data

No memory reading, no game injection, no file modification. Same APIs used by Blitz.gg, Porofessor, and U.GG.

## Architecture

```
src/
  main/
    index.js                    # Entry point, IPC handlers, dependency wiring
    lcu-connector.js            # Async League client detection (lockfile + WebSocket)
    riot-api-client.js          # Rate-limited Riot API with serial queue
    spell-tracker.js            # Enemy summoner spell cooldown engine
    key-store.js                # Encrypted persistent API key storage
    summoner-detector.js        # Auto-detect logged-in summoner + Data Dragon
    tray.js                     # System tray icon and menu
    orchestrator/
      orchestrator.js           # Phase transitions, agent lifecycle
      state-machine.js          # Game phase FSM with LCU mapping
      event-bus.js              # Pub/sub for cross-component events
    agents/
      base-agent.js             # Abstract agent with Claude tool loop
      drafting-oracle/           # Champ select agent (ban/pick/meta)
      macro-strategist/          # In-game strategic agent
      tilt-guard/                # Post-game wellness agent
    integrations/
      claude/client.js          # Anthropic SDK wrapper with retry + timeout
      riot/live-client.js       # Live Client Data API (port 2999) poller
    data/
      db.js                     # SQLite schema + queries (better-sqlite3)
      meta-scraper.js           # Champion tier data scraper (cheerio)
    windows/
      overlay-manager.js        # Frameless overlay BrowserWindows
  renderer/
    main-window/                # Dashboard (status, match history, settings)
    settings-window/            # API key management
    draft-overlay/              # Drafting Oracle overlay UI
    macro-overlay/              # Macro toast notifications
    spell-tracker/              # Summoner spell timer widget
    tilt-overlay/               # Post-game review overlay
  shared/
    ipc-channels.js             # IPC channel constants
```

## Setup

### Prerequisites

- Node.js 18+
- A [Riot Games API Key](https://developer.riotgames.com/)
- An [Anthropic API Key](https://console.anthropic.com/)

### Install

```bash
git clone https://github.com/willckim/Rift-Architect.git
cd Rift-Architect
npm install
npx electron-rebuild
```

### Configure

Create a `.env` file in the project root:

```
RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx
```

Or configure keys at runtime via **Settings** (tray icon > Settings).

### Run

```bash
npm start
```

The app starts in the system tray. It will automatically detect the League client when it launches.

## Key Features

- **Zero-config detection** — Automatically finds the League client via lockfile polling
- **Tab-toggle overlay** — Hold Tab during a game to see the spell tracker (uses `uiohook-napi` passive hook, doesn't steal Tab from League)
- **Screen-saver z-level** — Overlay escalates to `screen-saver` window level when Tab is held for fullscreen visibility
- **Draggable overlays** — All overlays can be repositioned; positions persist across sessions via `electron-store`
- **Rate limit safety** — Serial API queue with token-bucket limiter, 80% auto-pause, and 429 retry with backoff
- **Meta intelligence** — Scrapes champion tier data from community sites for data-driven ban/pick recommendations
- **Haste-adjusted timers** — Spell tracker detects Ionian Boots and Cosmic Insight, adjusts cooldowns automatically
- **Production key support** — 5-second propagation delay on key save to avoid immediate re-expiry

## Build

```bash
npm run package:win      # Windows portable .exe
npm run package:mac      # macOS .dmg
npm run package:linux    # Linux AppImage
```

## License

ISC

---

*Rift Architect isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.*
