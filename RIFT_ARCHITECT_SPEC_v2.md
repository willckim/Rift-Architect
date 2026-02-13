# RIFT ARCHITECT — Multi-Agent League of Legends Orchestrator

## Technical Specification v2.0

**Project Codename:** Rift Architect
**Author:** Big Boss — Senior Agentic Systems Architect
**Target Runtime:** Node.js 20+ / TypeScript 5.x / Electron 33+
**AI Backend:** Anthropic Claude API (claude-sonnet-4-20250514)
**Primary Interface:** Standalone Electron Desktop App (like Blitz.gg / Porofessor)

---

## 1. PROJECT OVERVIEW

### 1.1 What This Is

A **three-agent real-time orchestration system** for League of Legends, delivered as a standalone desktop application that auto-detects the League client, hooks into its local APIs, and provides intelligent overlays during every phase of gameplay.

This is the same architecture used by Blitz.gg, Porofessor, U.GG Desktop, and Mobalytics — an **Electron app** that:
- Watches for the League client process to start
- Reads the LCU lockfile to authenticate with the local client API
- Subscribes to game phase transitions via LCU WebSocket
- Reads live game data from the Live Client Data API (`https://127.0.0.1:2999`)
- Renders overlay windows that sit on top of the League client

### 1.2 Why Electron (Not a Chrome Extension)

League of Legends is a native desktop application, not a web page. There is nothing for a Chrome extension to inject into. The companion app ecosystem (Blitz, Porofessor, Mobalytics) universally uses this pattern:

```
┌──────────────────────────────────────────┐
│        LEAGUE OF LEGENDS CLIENT          │
│  (Native app — no browser involved)      │
│                                          │
│  Exposes locally:                        │
│  • LCU API (REST + WebSocket on random   │
│    port, auth via lockfile)              │
│  • Live Client Data API (port 2999,      │
│    no auth, HTTPS with self-signed cert) │
└──────────────────────────────────────────┘
         ▲                ▲
         │ LCU WebSocket  │ HTTP Polling
         │ + REST          │
┌────────┴────────────────┴────────────────┐
│         RIFT ARCHITECT (Electron)         │
│                                          │
│  • Detects client process & lockfile     │
│  • Subscribes to game phase changes      │
│  • Runs agent logic in main process      │
│  • Renders overlay BrowserWindows        │
│    (frameless, always-on-top,            │
│     transparent, click-through)          │
└──────────────────────────────────────────┘
```

### 1.3 The Three Agents

| Agent | Codename | Domain | Active During |
|-------|----------|--------|---------------|
| Agent 1 | **Drafting Oracle** | Champion Select Intelligence | Champ select lobby |
| Agent 2 | **Macro Strategist** | Live Game Decision Support | Active game |
| Agent 3 | **Tilt Guard** | Post-Match Wellness Analyst | Post-game / between games |

### 1.4 Architecture Philosophy

This is NOT a "GPT wrapper." Each agent has:
- Its own data pipeline
- Its own reasoning prompt chain
- Its own output interface (dedicated overlay window)
- Coordination handled by an **Orchestrator** that manages agent lifecycle, shared state, and overlay window visibility

---

## 2. SYSTEM ARCHITECTURE

### 2.1 High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    ELECTRON APP (Main Process)                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    ORCHESTRATOR                         │  │
│  │  ┌──────────────┐  ┌──────────┐  ┌─────────────────┐  │  │
│  │  │ LCU Connector │  │  State   │  │   Event Bus     │  │  │
│  │  │ (Process      │  │  Machine │  │   (EventEmitter │  │  │
│  │  │  Detection +  │  │  (Game   │  │    pub/sub)     │  │  │
│  │  │  Lockfile     │  │  Phase)  │  │                 │  │  │
│  │  │  Parser)      │  │          │  │                 │  │  │
│  │  └──────┬───────┘  └────┬─────┘  └────────┬────────┘  │  │
│  │         │               │                  │           │  │
│  │  ┌──────┴───────────────┴──────────────────┴────────┐  │  │
│  │  │              AGENT RUNTIME ENGINE                  │  │  │
│  │  │                                                    │  │  │
│  │  │  ┌──────────────┐ ┌────────────────┐ ┌──────────┐ │  │  │
│  │  │  │   Drafting   │ │     Macro      │ │   Tilt   │ │  │  │
│  │  │  │   Oracle     │ │   Strategist   │ │  Guard   │ │  │  │
│  │  │  └──────────────┘ └────────────────┘ └──────────┘ │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  INTEGRATION LAYER                      │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│  │  │  Riot API     │  │  Claude API  │  │  SQLite      │  │  │
│  │  │  Client       │  │  Client      │  │  (better-    │  │  │
│  │  │  (+ Rate      │  │  (Tool Use)  │  │   sqlite3)   │  │  │
│  │  │   Limiter)    │  │              │  │              │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               OVERLAY WINDOWS (Renderer Processes)      │  │
│  │                                                         │  │
│  │  ┌───────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │  Draft    │  │   Macro      │  │   Tilt Guard    │  │  │
│  │  │  Overlay  │  │   Overlay    │  │   Overlay       │  │  │
│  │  │  Window   │  │   Window     │  │   Window        │  │  │
│  │  │           │  │              │  │                 │  │  │
│  │  │ Frameless │  │  Frameless   │  │  Frameless      │  │  │
│  │  │ Always-   │  │  Always-     │  │  Always-        │  │  │
│  │  │ on-top    │  │  on-top      │  │  on-top         │  │  │
│  │  │ Transp.   │  │  Transp.     │  │  Transp.        │  │  │
│  │  └───────────┘  └──────────────┘  └─────────────────┘  │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │          MAIN WINDOW (System Tray App)          │    │  │
│  │  │  Settings, Session History, Agent Status         │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌──────────────────┐     ┌──────────────────┐
│  Riot Games API  │     │  Anthropic API   │
│  (Remote)        │     │  (Remote)        │
└──────────────────┘     └──────────────────┘
         │
         ▼
┌──────────────────┐
│  League Client   │
│  LCU API (Local) │
│  Live Client     │
│  Data (Local)    │
└──────────────────┘
```

### 2.2 Directory Structure

```
rift-architect/
├── package.json
├── tsconfig.json
├── electron-builder.yml          # Electron packaging config
├── .env.example                  # API keys template
├── README.md
│
├── src/
│   ├── main/                     # Electron Main Process
│   │   ├── index.ts              # App entry point, window management
│   │   ├── tray.ts               # System tray icon and menu
│   │   ├── windows/
│   │   │   ├── main-window.ts    # Settings/dashboard window
│   │   │   ├── overlay-manager.ts # Creates and manages overlay BrowserWindows
│   │   │   └── overlay-config.ts  # Per-overlay positioning, sizing, behavior
│   │   │
│   │   ├── orchestrator/
│   │   │   ├── orchestrator.ts   # Agent lifecycle + game phase management
│   │   │   ├── state-machine.ts  # Game phase state machine
│   │   │   └── event-bus.ts      # Internal pub/sub for agent coordination
│   │   │
│   │   ├── agents/
│   │   │   ├── base-agent.ts     # Abstract base class for all agents
│   │   │   ├── drafting-oracle/
│   │   │   │   ├── agent.ts      # Drafting Oracle implementation
│   │   │   │   ├── prompt.ts     # System prompt + tool definitions
│   │   │   │   └── types.ts
│   │   │   ├── macro-strategist/
│   │   │   │   ├── agent.ts      # Macro Strategist implementation
│   │   │   │   ├── prompt.ts
│   │   │   │   ├── triggers.ts   # State change detection logic
│   │   │   │   └── types.ts
│   │   │   └── tilt-guard/
│   │   │       ├── agent.ts      # Tilt Guard implementation
│   │   │       ├── prompt.ts
│   │   │       ├── tilt-calculator.ts  # Deterministic tilt score
│   │   │       ├── routines.ts   # Cooldown exercise library
│   │   │       └── types.ts
│   │   │
│   │   ├── integrations/
│   │   │   ├── riot/
│   │   │   │   ├── client.ts         # Riot API HTTP client with rate limiting
│   │   │   │   ├── rate-limiter.ts   # Token bucket rate limiter
│   │   │   │   ├── endpoints.ts      # Typed endpoint definitions
│   │   │   │   ├── lcu-connector.ts  # LCU process detection + lockfile parser
│   │   │   │   ├── lcu-websocket.ts  # LCU WebSocket subscription manager
│   │   │   │   ├── live-client.ts    # Live Client Data API poller (port 2999)
│   │   │   │   └── types.ts          # Riot API response types
│   │   │   └── claude/
│   │   │       ├── client.ts         # Anthropic SDK wrapper
│   │   │       ├── tool-schemas.ts   # Tool definitions for each agent
│   │   │       └── types.ts
│   │   │
│   │   ├── data/
│   │   │   ├── db.ts                 # SQLite connection + migrations
│   │   │   ├── models/
│   │   │   │   ├── match-history.ts
│   │   │   │   ├── session-log.ts
│   │   │   │   └── tilt-metrics.ts
│   │   │   └── seeds/
│   │   │       └── champion-data.ts  # Static champion metadata cache
│   │   │
│   │   └── utils/
│   │       ├── logger.ts             # Structured logging (electron-log)
│   │       ├── errors.ts             # Custom error classes
│   │       └── platform.ts           # OS-specific path resolution
│   │
│   ├── renderer/                 # Electron Renderer Processes (overlay UIs)
│   │   ├── common/
│   │   │   ├── styles/
│   │   │   │   ├── base.css          # Shared overlay styles
│   │   │   │   └── animations.css    # Transition/fade animations
│   │   │   └── ipc-bridge.ts         # Typed IPC helpers for renderer
│   │   │
│   │   ├── main-window/
│   │   │   ├── index.html
│   │   │   ├── app.ts               # Dashboard: status, settings, session history
│   │   │   └── styles.css
│   │   │
│   │   ├── draft-overlay/
│   │   │   ├── index.html
│   │   │   ├── app.ts               # Draft recommendations UI
│   │   │   └── styles.css
│   │   │
│   │   ├── macro-overlay/
│   │   │   ├── index.html
│   │   │   ├── app.ts               # Macro call toast notifications
│   │   │   └── styles.css
│   │   │
│   │   └── tilt-overlay/
│   │       ├── index.html
│   │       ├── app.ts               # Tilt score + cooldown routines
│   │       └── styles.css
│   │
│   └── shared/                   # Shared types between main and renderer
│       ├── ipc-channels.ts           # IPC channel name constants
│       └── types.ts                  # Shared interfaces
│
├── resources/                    # Electron build resources
│   ├── icon.ico                  # Windows icon
│   ├── icon.icns                 # macOS icon
│   └── icon.png                  # Linux icon
│
├── tests/
│   ├── agents/
│   │   ├── drafting-oracle.test.ts
│   │   ├── macro-strategist.test.ts
│   │   └── tilt-guard.test.ts
│   ├── integrations/
│   │   ├── riot-client.test.ts
│   │   ├── lcu-connector.test.ts
│   │   └── live-client.test.ts
│   ├── orchestrator/
│   │   └── state-machine.test.ts
│   └── fixtures/
│       ├── lcu-responses/            # Mock LCU API responses
│       │   ├── champ-select.json
│       │   ├── gameflow-phases.json
│       │   └── end-of-game.json
│       ├── live-client-responses/    # Mock Live Client Data API responses
│       │   ├── allgamedata.json
│       │   ├── playerlist.json
│       │   └── eventdata.json
│       └── riot-api-responses/       # Mock Riot remote API responses
│           ├── match-detail.json
│           ├── champion-mastery.json
│           └── league-entries.json
│
└── docs/
    ├── ARCHITECTURE.md
    ├── RIOT_API_GUIDE.md
    └── AGENT_PROMPTS.md
```

---

## 3. ELECTRON APP ARCHITECTURE

### 3.1 Process Model

Electron uses a multi-process architecture. This maps naturally to our system:

| Process | Role | What Lives Here |
|---------|------|----------------|
| **Main Process** | Backend brain | Orchestrator, all agents, API clients, SQLite, LCU connector |
| **Renderer: Main Window** | Dashboard UI | Settings, session history, agent status, summoner config |
| **Renderer: Draft Overlay** | Agent 1 output | Ban/pick recommendations during champ select |
| **Renderer: Macro Overlay** | Agent 2 output | Strategic call toasts during live game |
| **Renderer: Tilt Overlay** | Agent 3 output | Post-game analysis and cooldown routines |

### 3.2 IPC Communication (Main ↔ Renderer)

All communication between the main process and overlay windows uses Electron's IPC with a typed channel system:

```typescript
// src/shared/ipc-channels.ts

export const IPC_CHANNELS = {
  // Orchestrator → Overlays
  GAME_PHASE_CHANGED: "orchestrator:phase-changed",
  
  // Agent 1 → Draft Overlay
  DRAFT_RECOMMENDATION: "draft:recommendation",
  DRAFT_PICK_LOCKED: "draft:pick-locked",
  DRAFT_PHASE_UPDATE: "draft:phase-update",
  
  // Agent 2 → Macro Overlay
  MACRO_CALL: "macro:call",
  MACRO_DISMISS: "macro:dismiss",
  MACRO_GAME_STATE: "macro:game-state",
  
  // Agent 3 → Tilt Overlay
  TILT_SCORE_UPDATE: "tilt:score-update",
  TILT_RECOMMENDATION: "tilt:recommendation",
  TILT_SESSION_SUMMARY: "tilt:session-summary",
  
  // Main Window
  STATUS_UPDATE: "status:update",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SESSION_HISTORY: "session:history",
  
  // Overlay control
  OVERLAY_SHOW: "overlay:show",
  OVERLAY_HIDE: "overlay:hide",
  OVERLAY_TOGGLE: "overlay:toggle",
} as const;
```

### 3.3 Overlay Window Configuration

Overlays must be **frameless, transparent, always-on-top, and click-through** in non-interactive regions — identical to how Blitz.gg renders its overlays on top of the League client.

```typescript
// src/main/windows/overlay-manager.ts

import { BrowserWindow, screen } from "electron";

interface OverlayConfig {
  id: string;
  htmlFile: string;       // Path to renderer HTML
  width: number;
  height: number;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center-right";
  offsetX: number;        // Offset from anchor point
  offsetY: number;
  clickThrough: boolean;  // If true, clicks pass through to the game
}

const OVERLAY_CONFIGS: Record<string, OverlayConfig> = {
  draft: {
    id: "draft-overlay",
    htmlFile: "renderer/draft-overlay/index.html",
    width: 340,
    height: 580,
    anchor: "center-right",
    offsetX: -20,
    offsetY: 0,
    clickThrough: false,   // User needs to interact with draft recommendations
  },
  macro: {
    id: "macro-overlay",
    htmlFile: "renderer/macro-overlay/index.html",
    width: 380,
    height: 120,
    anchor: "top-right",
    offsetX: -20,
    offsetY: 100,
    clickThrough: true,    // Toasts should not block gameplay clicks
  },
  tilt: {
    id: "tilt-overlay",
    htmlFile: "renderer/tilt-overlay/index.html",
    width: 400,
    height: 500,
    anchor: "center-right",
    offsetX: -20,
    offsetY: 0,
    clickThrough: false,   // User interacts with cooldown routine
  },
};

function createOverlayWindow(config: OverlayConfig): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
  
  // Calculate position from anchor
  let x: number, y: number;
  switch (config.anchor) {
    case "top-right":
      x = screenW - config.width + config.offsetX;
      y = config.offsetY;
      break;
    case "center-right":
      x = screenW - config.width + config.offsetX;
      y = Math.floor((screenH - config.height) / 2) + config.offsetY;
      break;
    // ... other anchors
  }

  const overlay = new BrowserWindow({
    x,
    y,
    width: config.width,
    height: config.height,
    frame: false,               // No window chrome
    transparent: true,          // Transparent background
    alwaysOnTop: true,          // Sits above League client
    skipTaskbar: true,          // Not in taskbar
    resizable: false,
    focusable: !config.clickThrough,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,   // Security: isolate renderer
      nodeIntegration: false,   // Security: no Node in renderer
    },
  });

  // Click-through: mouse events pass to the window underneath
  if (config.clickThrough) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }

  overlay.loadFile(config.htmlFile);
  overlay.setVisibleOnAllWorkspaces(true);

  return overlay;
}
```

### 3.4 System Tray Integration

The app runs primarily from the system tray (like Blitz.gg). No persistent taskbar window.

```typescript
// src/main/tray.ts

import { Tray, Menu, nativeImage } from "electron";

function createTray(): Tray {
  const tray = new Tray(nativeImage.createFromPath("resources/icon.png"));
  
  const contextMenu = Menu.buildFromTemplate([
    { label: "Rift Architect", enabled: false },
    { type: "separator" },
    { label: "Status: Waiting for League Client...", id: "status", enabled: false },
    { type: "separator" },
    { label: "Open Dashboard", click: () => showMainWindow() },
    { label: "Settings", click: () => showMainWindow("settings") },
    { type: "separator" },
    {
      label: "Overlays",
      submenu: [
        { label: "Draft Oracle", type: "checkbox", checked: true, id: "overlay-draft" },
        { label: "Macro Strategist", type: "checkbox", checked: true, id: "overlay-macro" },
        { label: "Tilt Guard", type: "checkbox", checked: true, id: "overlay-tilt" },
      ]
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip("Rift Architect — Waiting for League Client");
  
  return tray;
}
```

### 3.5 App Lifecycle

```typescript
// src/main/index.ts — simplified entry point

import { app, BrowserWindow } from "electron";
import { createTray } from "./tray";
import { OverlayManager } from "./windows/overlay-manager";
import { Orchestrator } from "./orchestrator/orchestrator";
import { LCUConnector } from "./integrations/riot/lcu-connector";
import { initDatabase } from "./data/db";
import { logger } from "./utils/logger";

let tray: Tray;
let orchestrator: Orchestrator;

app.whenReady().then(async () => {
  logger.info("Rift Architect starting...");

  // 1. Initialize database
  await initDatabase();

  // 2. Create system tray
  tray = createTray();

  // 3. Create overlay manager (creates windows but keeps them hidden)
  const overlayManager = new OverlayManager();

  // 4. Create LCU connector (starts watching for League client process)
  const lcuConnector = new LCUConnector();

  // 5. Create and start orchestrator
  orchestrator = new Orchestrator(lcuConnector, overlayManager);
  orchestrator.start();

  logger.info("Rift Architect ready. Watching for League client...");
});

// macOS: keep app running when all windows closed (tray app behavior)
app.on("window-all-closed", (e: Event) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  orchestrator?.shutdown();
});
```

---

## 4. LCU CONNECTOR — LEAGUE CLIENT DETECTION

This is the **most critical integration**. Without it, nothing works. This is how Blitz.gg, Porofessor, and every other companion app discovers and connects to the League client.

### 4.1 Process Detection

The League client runs as `LeagueClientUx.exe` (Windows) or `LeagueClientUx` (macOS). On launch, it writes a **lockfile** containing connection credentials.

```typescript
// src/main/integrations/riot/lcu-connector.ts

import { EventEmitter } from "events";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";

interface LCUCredentials {
  processId: number;
  port: number;
  password: string;
  protocol: "https";
}

export class LCUConnector extends EventEmitter {
  private credentials: LCUCredentials | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private wsConnection: WebSocket | null = null;

  // Polling interval to check if the League client is running
  private readonly POLL_MS = 3000;

  /**
   * Start watching for the League client process.
   * Emits "connected" when found, "disconnected" when lost.
   */
  start(): void {
    this.pollInterval = setInterval(() => this.poll(), this.POLL_MS);
    this.poll(); // Check immediately
  }

  private poll(): void {
    const lockfilePath = this.findLockfile();
    
    if (lockfilePath && !this.credentials) {
      // Client just appeared
      this.credentials = this.parseLockfile(lockfilePath);
      if (this.credentials) {
        this.emit("connected", this.credentials);
        this.connectWebSocket();
      }
    } else if (!lockfilePath && this.credentials) {
      // Client just disappeared
      this.credentials = null;
      this.wsConnection?.close();
      this.emit("disconnected");
    }
  }

  /**
   * Find the League client lockfile.
   * 
   * Strategy 1: Parse process command line args for --install-directory
   * Strategy 2: Check known default install paths
   */
  private findLockfile(): string | null {
    // Strategy 1: Find process and extract install directory
    try {
      if (process.platform === "win32") {
        const output = execSync(
          'wmic PROCESS WHERE name="LeagueClientUx.exe" GET commandline',
          { encoding: "utf-8", timeout: 5000 }
        );
        const match = output.match(/--install-directory=([^\s"]+)/);
        if (match) {
          const lockfile = path.join(match[1], "lockfile");
          if (fs.existsSync(lockfile)) return lockfile;
        }
      } else if (process.platform === "darwin") {
        const output = execSync(
          "ps aux | grep LeagueClientUx | grep -v grep",
          { encoding: "utf-8", timeout: 5000 }
        );
        const match = output.match(/--install-directory=([^\s]+)/);
        if (match) {
          const lockfile = path.join(match[1], "lockfile");
          if (fs.existsSync(lockfile)) return lockfile;
        }
      }
    } catch {
      // Process not found — that's fine
    }

    // Strategy 2: Check default paths
    const defaultPaths = process.platform === "win32"
      ? [
          "C:\\Riot Games\\League of Legends\\lockfile",
          "D:\\Riot Games\\League of Legends\\lockfile",
        ]
      : [
          "/Applications/League of Legends.app/Contents/LoL/lockfile",
        ];

    for (const p of defaultPaths) {
      if (fs.existsSync(p)) return p;
    }

    return null;
  }

  /**
   * Parse lockfile format: processName:pid:port:password:protocol
   * Example: LeagueClient:12345:53210:abc123def:https
   */
  private parseLockfile(filepath: string): LCUCredentials | null {
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const parts = content.split(":");
      if (parts.length < 5) return null;
      
      return {
        processId: parseInt(parts[1], 10),
        port: parseInt(parts[2], 10),
        password: parts[3],
        protocol: "https",
      };
    } catch {
      return null;
    }
  }

  /**
   * Make an authenticated request to the LCU API.
   * Uses Basic auth with username "riot" and password from lockfile.
   * LCU uses a self-signed cert, so we disable TLS verification for localhost.
   */
  async request(method: string, endpoint: string, body?: any): Promise<any> {
    if (!this.credentials) throw new Error("Not connected to League client");
    
    const url = `https://127.0.0.1:${this.credentials.port}${endpoint}`;
    const auth = Buffer.from(`riot:${this.credentials.password}`).toString("base64");

    const response = await fetch(url, {
      method,
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      // Node.js: need to disable TLS verification for self-signed cert
      // Use a custom agent in production
    });

    if (!response.ok) throw new Error(`LCU ${response.status}: ${await response.text()}`);
    return response.json();
  }

  /**
   * Connect to LCU WebSocket for real-time game phase events.
   * This is how we detect transitions between lobby, champ select, in-game, etc.
   */
  private connectWebSocket(): void {
    if (!this.credentials) return;
    
    const url = `wss://127.0.0.1:${this.credentials.port}/`;
    const auth = Buffer.from(`riot:${this.credentials.password}`).toString("base64");

    // Using the 'ws' library for Node.js WebSocket
    const ws = new WebSocket(url, {
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false,  // Self-signed cert
    });

    ws.on("open", () => {
      // Subscribe to all events (WAMP protocol)
      ws.send(JSON.stringify([5, "OnJsonApiEvent"]));
      this.emit("websocket-connected");
    });

    ws.on("message", (data: string) => {
      try {
        const message = JSON.parse(data);
        // WAMP event format: [8, "OnJsonApiEvent", { uri, data, eventType }]
        if (message[0] === 8 && message[2]) {
          const event = message[2];
          this.emit("lcu-event", event);
          
          // Specifically emit game phase changes
          if (event.uri === "/lol-gameflow/v1/gameflow-phase") {
            this.emit("phase-changed", event.data);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      this.wsConnection = null;
      this.emit("websocket-disconnected");
    });

    this.wsConnection = ws;
  }

  /**
   * Get current game phase directly (for startup, when we missed the WS event).
   */
  async getCurrentPhase(): Promise<string> {
    return this.request("GET", "/lol-gameflow/v1/gameflow-phase");
  }

  /**
   * Get champ select session data.
   */
  async getChampSelectSession(): Promise<any> {
    return this.request("GET", "/lol-champ-select/v1/session");
  }

  /**
   * Get end-of-game stats.
   */
  async getEndOfGameStats(): Promise<any> {
    return this.request("GET", "/lol-end-of-game/v1/eog-stats-block");
  }

  shutdown(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.wsConnection?.close();
  }
}
```

### 4.2 LCU Game Phase Values

These are the string values returned by `/lol-gameflow/v1/gameflow-phase`:

| LCU Phase String | Our State | Meaning |
|-----------------|-----------|---------|
| `"None"` | IDLE | Client open, not doing anything |
| `"Lobby"` | LOBBY | In a game lobby |
| `"Matchmaking"` | LOBBY | In queue, searching |
| `"ReadyCheck"` | LOBBY | Match found, accept/decline |
| `"ChampSelect"` | CHAMP_SELECT | In champion select |
| `"GameStart"` | LOADING | Loading into game |
| `"InProgress"` | IN_GAME | Game is live |
| `"WaitingForStats"` | POST_GAME | Game ended, waiting for stats |
| `"PreEndOfGame"` | POST_GAME | Stats loading |
| `"EndOfGame"` | POST_GAME | Post-game lobby |

---

## 5. LIVE CLIENT DATA API — IN-GAME DATA SOURCE

### 5.1 Overview

During an active game, the League client exposes a **local HTTP API** at `https://127.0.0.1:2999/liveclientdata/`. This requires NO authentication and NO API key. It uses a self-signed certificate.

This is Agent 2's primary data source.

### 5.2 Key Endpoints

```typescript
// src/main/integrations/riot/live-client.ts

const BASE_URL = "https://127.0.0.1:2999/liveclientdata";

export class LiveClientAPI {
  private pollTimer: NodeJS.Timeout | null = null;
  private eventIndex: number = 0;  // Track last seen event for delta detection

  /**
   * Get complete game snapshot.
   * Includes: active player, all players, events, game data.
   */
  async getAllGameData(): Promise<AllGameData> {
    return this.fetch("/allgamedata");
  }

  /**
   * Get active player stats (the user's own champion).
   * Includes: abilities, championStats, currentGold, level, summonerName.
   */
  async getActivePlayer(): Promise<ActivePlayer> {
    return this.fetch("/activeplayer");
  }

  /**
   * Get all players in the game.
   * Each player: championName, isBot, isDead, items, level, position,
   * respawnTimer, scores (assists, creepScore, deaths, kills, wardScore).
   */
  async getPlayerList(): Promise<Player[]> {
    return this.fetch("/playerlist");
  }

  /**
   * Get game events (kills, dragon/baron takes, turret kills, etc.).
   * Events include: EventID, EventName, EventTime, and event-specific data.
   */
  async getEventData(): Promise<GameEvents> {
    return this.fetch("/eventdata");
  }

  /**
   * Get basic game stats: gameMode, gameTime, mapName, mapNumber, mapTerrain.
   */
  async getGameStats(): Promise<GameStats> {
    return this.fetch("/gamestats");
  }

  /**
   * Start polling loop. Emits events when significant state changes detected.
   */
  startPolling(
    onSnapshot: (data: AllGameData) => void,
    onEvent: (events: GameEvent[]) => void,
    snapshotIntervalMs: number = 15000,
    eventIntervalMs: number = 5000
  ): void {
    // Poll full snapshot less frequently
    setInterval(async () => {
      try {
        const data = await this.getAllGameData();
        onSnapshot(data);
      } catch {
        // Game might have ended — that's fine
      }
    }, snapshotIntervalMs);

    // Poll events more frequently for timely triggers
    setInterval(async () => {
      try {
        const eventData = await this.getEventData();
        const newEvents = eventData.Events.filter(
          (e: GameEvent) => e.EventID > this.eventIndex
        );
        if (newEvents.length > 0) {
          this.eventIndex = Math.max(...newEvents.map((e: GameEvent) => e.EventID));
          onEvent(newEvents);
        }
      } catch {
        // Game might have ended
      }
    }, eventIntervalMs);
  }

  private async fetch(endpoint: string): Promise<any> {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      // Self-signed cert — disable verification for localhost only
    });
    if (!response.ok) throw new Error(`Live Client ${response.status}`);
    return response.json();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
```

### 5.3 Key Response Types

```typescript
// Relevant types for Live Client Data API

interface AllGameData {
  activePlayer: ActivePlayer;
  allPlayers: Player[];
  events: { Events: GameEvent[] };
  gameData: GameStats;
}

interface ActivePlayer {
  championName: string;
  level: number;
  currentGold: number;
  summonerName: string;
  abilities: Record<string, Ability>;
  championStats: ChampionStats;  // AD, AP, armor, MR, etc.
  fullRunes: RuneData;
}

interface Player {
  championName: string;
  isBot: boolean;
  isDead: boolean;
  items: Item[];
  level: number;
  position: string;            // "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"
  respawnTimer: number;
  scores: {
    assists: number;
    creepScore: number;
    deaths: number;
    kills: number;
    wardScore: number;
  };
  skinID: number;
  summonerName: string;
  summonerSpells: SummonerSpells;
  team: "ORDER" | "CHAOS";    // Blue side / Red side
}

interface GameEvent {
  EventID: number;
  EventName: string;           // "GameStart", "ChampionKill", "DragonKill",
                               // "BaronKill", "TurretKilled", "InhibKilled", etc.
  EventTime: number;           // Game time in seconds
  // Event-specific fields vary:
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  DragonType?: string;         // "Fire", "Water", "Earth", "Air", "Elder"
  TurretKilled?: string;
  Stolen?: string;             // "True" / "False" for objectives
}

interface GameStats {
  gameMode: string;
  gameTime: number;            // Current game time in seconds
  mapName: string;
  mapNumber: number;
  mapTerrain: string;          // Rift terrain type (Chemtech, Hextech, etc.)
}
```

---

## 6. AGENT SPECIFICATIONS

### 6.1 Agent 1: Drafting Oracle

**Purpose:** During champion select, analyze the enemy team's champion pools, current patch meta, and team composition synergies to recommend bans, picks, and counter-strategies.

**Trigger Condition:** Orchestrator detects `CHAMP_SELECT` phase via LCU WebSocket.

**Data Inputs:**
| Source | Endpoint | Data |
|--------|----------|------|
| Riot API | `/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}` | Enemy champion mastery scores |
| Riot API | `/lol/match/v5/matches/by-puuid/{puuid}/ids` + match details | Recent match history (last 20 games) |
| Riot API | `/lol/league/v4/entries/by-summoner/{summonerId}` | Rank and LP of all players |
| LCU API | `/lol-champ-select/v1/session` (polled or via WebSocket) | Real-time picks/bans as they happen |
| Static Data | Local cache (updated per patch via Data Dragon) | Champion win rates, tier lists, synergy data |

**Claude Tool Definitions:**
```typescript
const draftingOracleTools = [
  {
    name: "get_enemy_champion_pools",
    description: "Retrieve champion mastery and recent pick history for a specific enemy summoner",
    input_schema: {
      type: "object",
      properties: {
        summoner_puuid: { type: "string", description: "The PUUID of the enemy summoner" },
        top_n: { type: "number", description: "Number of top champions to return", default: 5 }
      },
      required: ["summoner_puuid"]
    }
  },
  {
    name: "get_meta_tier_list",
    description: "Get current patch tier list for a specific role",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["top", "jungle", "mid", "adc", "support"] },
        patch: { type: "string", description: "Patch version, e.g. '14.10'" }
      },
      required: ["role"]
    }
  },
  {
    name: "analyze_team_composition",
    description: "Analyze current team composition for synergies, win conditions, and weaknesses",
    input_schema: {
      type: "object",
      properties: {
        ally_champions: { type: "array", items: { type: "string" } },
        enemy_champions: { type: "array", items: { type: "string" } }
      },
      required: ["ally_champions", "enemy_champions"]
    }
  },
  {
    name: "suggest_ban",
    description: "Output a ban recommendation to the user overlay",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        reason: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["champion", "reason", "confidence"]
    }
  },
  {
    name: "suggest_pick",
    description: "Output a pick recommendation to the user overlay",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        role: { type: "string" },
        reason: { type: "string" },
        counters: { type: "array", items: { type: "string" }, description: "Which enemy champs this pick counters" },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["champion", "role", "reason", "confidence"]
    }
  }
];
```

**System Prompt (Core Intent — expand during implementation):**
```
You are the Drafting Oracle, an elite League of Legends draft analyst.
Your job is to analyze champion select in real time and provide
actionable draft intelligence.

RULES:
- Always consider the PLAYER's champion pool, not just meta picks
- Weight enemy one-trick patterns heavily (mastery score > 100k = likely pick)
- Consider team composition archetypes: teamfight, pick, split-push, poke
- Never recommend a champion the player hasn't played in ranked
- Provide confidence scores honestly — 0.5 means "coin flip"
- Update recommendations as each pick/ban is locked in
```

**Output Format (sent via IPC to Draft Overlay):**
```typescript
interface DraftRecommendation {
  phase: "ban_phase_1" | "ban_phase_2" | "pick_phase";
  recommendations: Array<{
    action: "ban" | "pick";
    champion: string;
    championId: number;
    role?: string;
    reason: string;
    confidence: number;
    threat_level?: "low" | "medium" | "high" | "critical";
  }>;
  team_comp_analysis?: {
    ally_win_condition: string;
    enemy_win_condition: string;
    draft_advantage: "ally" | "enemy" | "even";
  };
}
```

---

### 6.2 Agent 2: Macro Strategist

**Purpose:** During a live game, passively monitor game state and surface macro-level strategic suggestions via the macro overlay window.

**Trigger Condition:** Orchestrator detects `IN_GAME` phase. Live Client Data API becomes available.

**Data Source:** Live Client Data API at `https://127.0.0.1:2999/liveclientdata/` (see Section 5).

**Polling Strategy:**
- Poll `/allgamedata` every **15 seconds**
- Poll `/eventdata` every **5 seconds**
- Only invoke Claude when a **significant state change** is detected (see triggers below)

**Significant State Change Triggers (invoke Claude):**
```typescript
enum MacroTrigger {
  GOLD_SWING = "gold_diff_change_gt_1500_in_60s",
  OBJECTIVE_SPAWNING = "dragon_baron_elder_spawning_in_90s",
  OBJECTIVE_TAKEN = "major_objective_killed",
  TOWER_DESTROYED = "tower_destroyed",
  ACE = "team_ace",
  POWER_SPIKE = "level_6_11_16_reached",
  DEATH_TIMER_LONG = "enemy_death_timer_gt_30s",
  ITEM_COMPLETION = "major_item_completed",
}
```

**Claude Tool Definitions:**
```typescript
const macroStrategistTools = [
  {
    name: "get_game_snapshot",
    description: "Get current game state including gold, objectives, and player stats",
    input_schema: {
      type: "object",
      properties: {
        include_items: { type: "boolean", default: true },
        include_events: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "calculate_power_spikes",
    description: "Determine which team has upcoming power spikes based on items and levels",
    input_schema: {
      type: "object",
      properties: {
        ally_team: { type: "array", items: { type: "object" } },
        enemy_team: { type: "array", items: { type: "object" } }
      },
      required: ["ally_team", "enemy_team"]
    }
  },
  {
    name: "emit_macro_call",
    description: "Send a strategic recommendation to the player overlay",
    input_schema: {
      type: "object",
      properties: {
        call_type: {
          type: "string",
          enum: ["CONTEST_OBJECTIVE", "SPLIT_PUSH", "GROUP_MID", "RESET_NOW",
                 "PLAY_SAFE", "FORCE_FIGHT", "SET_UP_VISION", "TAKE_TOWER",
                 "INVADE_JUNGLE", "BARON_CALL"]
        },
        urgency: { type: "string", enum: ["info", "suggestion", "urgent"] },
        reasoning: { type: "string", maxLength: 120 },
        window_seconds: { type: "number", description: "How long this call is relevant" }
      },
      required: ["call_type", "urgency", "reasoning"]
    }
  }
];
```

**System Prompt (Core Intent):**
```
You are the Macro Strategist, a high-elo League of Legends macro coach.
You observe game state snapshots and surface strategic calls.

RULES:
- You are a PASSIVE advisor. Keep calls SHORT (< 120 chars).
- Only emit a call when there is a CLEAR strategic window.
- Never spam — max 1 call per 45 seconds unless urgency is critical.
- Frame calls as opportunities, not commands: "Baron window — 3 dead, push now"
- Consider the game timer: early game (0-14m), mid game (14-25m), late game (25m+)
- Track dragon soul progress — 3rd dragon is always urgent.
- If the player is behind, prioritize safe/scaling calls over aggressive ones.
```

**Output Format (sent via IPC to Macro Overlay):**
```typescript
interface MacroCall {
  id: string;
  timestamp: number;
  game_time: number;
  call_type: string;
  urgency: "info" | "suggestion" | "urgent";
  message: string;            // Short display text (< 60 chars)
  reasoning: string;          // Longer explanation (< 120 chars)
  window_seconds?: number;    // Auto-dismiss timer
  objective_context?: {
    next_dragon_type: string;
    dragon_soul_status: string;
    baron_alive: boolean;
  };
}
```

**Overlay UX:**
- Toasts appear at configurable screen position (default: top-right)
- Auto-dismiss after `window_seconds` (default 15s)
- Urgency → color: info=blue, suggestion=yellow, urgent=red with pulse animation
- Click-through enabled so it NEVER blocks gameplay
- History log accessible from main dashboard window

---

### 6.3 Agent 3: Tilt Guard

**Purpose:** After each match, analyze performance trends and behavioral patterns to detect "tilt." When tilt is detected, recommend a physical cooldown activity.

**Trigger Condition:** Orchestrator detects `POST_GAME` phase.

**Data Inputs:**
| Source | Endpoint | Data |
|--------|----------|------|
| Riot API | `/lol/match/v5/matches/{matchId}` | Full match details |
| Riot API | `/lol/match/v5/matches/{matchId}/timeline` | Minute-by-minute timeline |
| LCU API | `/lol-end-of-game/v1/eog-stats-block` | Immediate post-game stats |
| Local DB | Session log | Current session win/loss streak, performance trend |
| Local DB | Historical tilt metrics | Past tilt scores and recovery patterns |

**Tilt Detection Metrics (calculated locally, fed to Claude):**
```typescript
interface TiltMetrics {
  // Session metrics
  session_games_played: number;
  session_win_rate: number;
  current_loss_streak: number;
  current_win_streak: number;

  // Performance trend (last 3 games vs session average)
  kda_trend: "improving" | "stable" | "declining";
  cs_per_min_trend: "improving" | "stable" | "declining";
  vision_score_trend: "improving" | "stable" | "declining";
  death_timing_trend: "improving" | "stable" | "declining";

  // Behavioral signals
  avg_time_between_games: number;  // Shorter = rage queueing
  surrender_votes: number;
  champion_diversity: number;

  // Current game specific
  last_game_result: "win" | "loss";
  last_game_kda: number;
  last_game_death_count: number;
  last_game_duration_minutes: number;
  role_consistency: boolean;
}
```

**Tilt Score Algorithm (pre-Claude, deterministic):**
```typescript
function calculateTiltScore(metrics: TiltMetrics): number {
  let score = 0; // 0-100, higher = more tilted

  // Loss streak (heaviest weight)
  score += Math.min(metrics.current_loss_streak * 12, 36);

  // Performance decline
  if (metrics.kda_trend === "declining") score += 10;
  if (metrics.cs_per_min_trend === "declining") score += 5;
  if (metrics.death_timing_trend === "declining") score += 10;

  // Behavioral signals
  if (metrics.avg_time_between_games < 60) score += 15; // Rage queueing
  score += metrics.surrender_votes * 5;

  // Recent game impact
  if (metrics.last_game_death_count > 8) score += 8;
  if (metrics.last_game_kda < 1.0) score += 5;

  // Session fatigue
  if (metrics.session_games_played > 5) score += 5;
  if (metrics.session_games_played > 8) score += 10;

  return Math.min(score, 100);
}
```

**Tilt Thresholds:**
| Score | State | Action |
|-------|-------|--------|
| 0-25 | ✅ **Cool** | No intervention. Optional "nice session" summary. |
| 26-50 | ⚠️ **Warming** | Gentle nudge: "Consider a 5-min break." |
| 51-75 | 🔥 **Tilted** | Active suggestion: Specific calisthenics/stretching routine. |
| 76-100 | 🚨 **Danger Zone** | Strong recommendation: Full cooldown routine + session analysis. |

**Claude Tool Definitions:**
```typescript
const tiltGuardTools = [
  {
    name: "get_session_summary",
    description: "Retrieve current gaming session summary including all tilt metrics",
    input_schema: {
      type: "object",
      properties: {
        include_match_details: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "get_historical_tilt_patterns",
    description: "Retrieve past tilt episodes and what helped recovery",
    input_schema: {
      type: "object",
      properties: {
        lookback_days: { type: "number", default: 30 }
      }
    }
  },
  {
    name: "emit_wellness_recommendation",
    description: "Send a wellness/cooldown recommendation to the player",
    input_schema: {
      type: "object",
      properties: {
        tilt_level: { type: "string", enum: ["cool", "warming", "tilted", "danger_zone"] },
        headline: { type: "string", maxLength: 80 },
        message: { type: "string", maxLength: 500 },
        activity: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["stretch", "calisthenics", "breathing", "walk", "full_routine"] },
            duration_minutes: { type: "number" },
            exercises: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  reps_or_duration: { type: "string" },
                  description: { type: "string" }
                }
              }
            }
          }
        },
        session_analysis: {
          type: "string",
          description: "Brief analysis of what went wrong and patterns observed"
        }
      },
      required: ["tilt_level", "headline", "message"]
    }
  }
];
```

**System Prompt (Core Intent):**
```
You are the Tilt Guard, a performance psychologist and physical wellness coach
for competitive gamers. You specialize in HYROX-style functional fitness
and calisthenics recovery routines.

RULES:
- Never be condescending. Frame breaks as PERFORMANCE OPTIMIZATION, not weakness.
- Use sports psychology language: "mental reset", "recovery window", "peak state"
- Scale activity intensity to tilt level:
  - Warming: 5-min desk stretches, box breathing
  - Tilted: 10-min calisthenics circuit (push-ups, squats, hanging)
  - Danger Zone: 15-20 min full routine (burpees, pull-ups, core work, cool-down)
- Reference specific HYROX movements when suggesting exercises:
  - Wall balls, sled push simulation, burpee broad jumps, farmers carry
- Always include a breathing component (box breathing or 4-7-8 technique)
- Provide a brief, non-judgmental session analysis focusing on PATTERNS, not blame
- If the player is on a win streak and performing well, celebrate it briefly
```

**Cooldown Routine Library (seed data):**
```typescript
const cooldownRoutines = {
  desk_stretch: {
    duration: 5,
    exercises: [
      { name: "Neck Rolls", reps_or_duration: "30s each direction" },
      { name: "Wrist Circles & Extensions", reps_or_duration: "20s each" },
      { name: "Seated Spinal Twist", reps_or_duration: "20s each side" },
      { name: "Standing Forward Fold", reps_or_duration: "30s" },
      { name: "Box Breathing", reps_or_duration: "4 cycles (4-4-4-4)" }
    ]
  },
  calisthenics_circuit: {
    duration: 10,
    exercises: [
      { name: "Push-ups", reps_or_duration: "15 reps" },
      { name: "Air Squats", reps_or_duration: "20 reps" },
      { name: "Dead Hang", reps_or_duration: "30s" },
      { name: "Plank Hold", reps_or_duration: "45s" },
      { name: "Burpees", reps_or_duration: "8 reps" },
      { name: "4-7-8 Breathing", reps_or_duration: "4 cycles" }
    ]
  },
  hyrox_reset: {
    duration: 18,
    exercises: [
      { name: "Wall Ball Simulation (Squat + Overhead Press)", reps_or_duration: "15 reps" },
      { name: "Burpee Broad Jumps", reps_or_duration: "10 reps" },
      { name: "Farmers Carry (grab anything heavy)", reps_or_duration: "60s walk" },
      { name: "Push-up to Down Dog", reps_or_duration: "10 reps" },
      { name: "Hollow Body Hold", reps_or_duration: "30s" },
      { name: "Lunges", reps_or_duration: "12 each leg" },
      { name: "Cool-down: Standing Forward Fold", reps_or_duration: "60s" },
      { name: "Cool-down: Box Breathing", reps_or_duration: "6 cycles" }
    ]
  }
};
```

---

## 7. ORCHESTRATOR DESIGN

### 7.1 Game Phase State Machine

```typescript
enum GamePhase {
  IDLE = "IDLE",
  LOBBY = "LOBBY",
  CHAMP_SELECT = "CHAMP_SELECT",    // Agent 1 active
  LOADING = "LOADING",
  IN_GAME = "IN_GAME",             // Agent 2 active
  POST_GAME = "POST_GAME",         // Agent 3 active
}

const LCU_PHASE_MAP: Record<string, GamePhase> = {
  "None": GamePhase.IDLE,
  "Lobby": GamePhase.LOBBY,
  "Matchmaking": GamePhase.LOBBY,
  "ReadyCheck": GamePhase.LOBBY,
  "ChampSelect": GamePhase.CHAMP_SELECT,
  "GameStart": GamePhase.LOADING,
  "InProgress": GamePhase.IN_GAME,
  "WaitingForStats": GamePhase.POST_GAME,
  "PreEndOfGame": GamePhase.POST_GAME,
  "EndOfGame": GamePhase.POST_GAME,
};

const transitions: Record<GamePhase, GamePhase[]> = {
  [GamePhase.IDLE]: [GamePhase.LOBBY],
  [GamePhase.LOBBY]: [GamePhase.CHAMP_SELECT, GamePhase.IDLE],
  [GamePhase.CHAMP_SELECT]: [GamePhase.LOADING, GamePhase.LOBBY],  // Dodge
  [GamePhase.LOADING]: [GamePhase.IN_GAME],
  [GamePhase.IN_GAME]: [GamePhase.POST_GAME],
  [GamePhase.POST_GAME]: [GamePhase.IDLE, GamePhase.LOBBY],
};
```

### 7.2 Orchestrator Implementation

```typescript
// src/main/orchestrator/orchestrator.ts

export class Orchestrator {
  private currentPhase: GamePhase = GamePhase.IDLE;
  private activeAgents: Map<string, BaseAgent> = new Map();

  constructor(
    private lcu: LCUConnector,
    private overlayManager: OverlayManager,
    private eventBus: EventBus,
  ) {}

  start(): void {
    // Listen for LCU connection
    this.lcu.on("connected", async (creds) => {
      logger.info("League client detected", { port: creds.port });
      this.updateTrayStatus("Connected to League Client");
      
      // Get current phase in case we launched mid-game
      const phase = await this.lcu.getCurrentPhase();
      this.handlePhaseChange(LCU_PHASE_MAP[phase] || GamePhase.IDLE);
    });

    this.lcu.on("disconnected", () => {
      logger.info("League client disconnected");
      this.updateTrayStatus("Waiting for League Client...");
      this.deactivateAllAgents();
      this.currentPhase = GamePhase.IDLE;
    });

    // Listen for real-time phase changes via LCU WebSocket
    this.lcu.on("phase-changed", (lcuPhase: string) => {
      const newPhase = LCU_PHASE_MAP[lcuPhase] || GamePhase.IDLE;
      this.handlePhaseChange(newPhase);
    });

    // Start LCU polling
    this.lcu.start();
  }

  private handlePhaseChange(newPhase: GamePhase): void {
    if (newPhase === this.currentPhase) return;

    const validTransitions = transitions[this.currentPhase];
    if (!validTransitions.includes(newPhase)) {
      logger.warn("Invalid phase transition", {
        from: this.currentPhase,
        to: newPhase,
      });
      // Force transition anyway — LCU is the source of truth
    }

    logger.info("Phase transition", { from: this.currentPhase, to: newPhase });
    const previousPhase = this.currentPhase;
    this.currentPhase = newPhase;

    // Deactivate agents from previous phase
    this.deactivateAgentsForPhase(previousPhase);

    // Activate agents for new phase
    switch (newPhase) {
      case GamePhase.CHAMP_SELECT:
        this.activateAgent("drafting-oracle");
        this.overlayManager.show("draft");
        break;

      case GamePhase.IN_GAME:
        this.activateAgent("macro-strategist");
        this.overlayManager.show("macro");
        this.overlayManager.hide("draft");
        break;

      case GamePhase.POST_GAME:
        this.activateAgent("tilt-guard");
        this.overlayManager.show("tilt");
        this.overlayManager.hide("macro");
        break;

      case GamePhase.IDLE:
      case GamePhase.LOBBY:
        this.overlayManager.hideAll();
        break;
    }

    // Notify all renderers
    this.overlayManager.broadcastPhaseChange(newPhase);
  }

  private activateAgent(agentId: string): void {
    if (this.activeAgents.has(agentId)) return;
    
    // Agent factory — create the right agent based on ID
    const agent = AgentFactory.create(agentId, {
      lcu: this.lcu,
      claudeClient: this.claudeClient,
      db: this.db,
      eventBus: this.eventBus,
      overlayManager: this.overlayManager,
    });

    agent.start();
    this.activeAgents.set(agentId, agent);
    logger.info("Agent activated", { agent: agentId });
  }

  private deactivateAgent(agentId: string): void {
    const agent = this.activeAgents.get(agentId);
    if (agent) {
      agent.stop();
      this.activeAgents.delete(agentId);
      logger.info("Agent deactivated", { agent: agentId });
    }
  }

  private deactivateAllAgents(): void {
    for (const [id] of this.activeAgents) {
      this.deactivateAgent(id);
    }
  }

  private deactivateAgentsForPhase(phase: GamePhase): void {
    switch (phase) {
      case GamePhase.CHAMP_SELECT:
        this.deactivateAgent("drafting-oracle");
        break;
      case GamePhase.IN_GAME:
        this.deactivateAgent("macro-strategist");
        break;
      case GamePhase.POST_GAME:
        this.deactivateAgent("tilt-guard");
        break;
    }
  }

  shutdown(): void {
    this.deactivateAllAgents();
    this.lcu.shutdown();
  }
}
```

---

## 8. RIOT GAMES API INTEGRATION (REMOTE)

### 8.1 Required Endpoints

| Endpoint | Rate Limit | Used By |
|----------|-----------|---------|
| `/lol/summoner/v4/summoners/by-name/{name}` | 1600/min | Setup |
| `/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}` | 2000/min | Agent 1 |
| `/lol/match/v5/matches/by-puuid/{puuid}/ids` | 2000/min | Agent 1, 3 |
| `/lol/match/v5/matches/{matchId}` | 2000/min | Agent 1, 3 |
| `/lol/match/v5/matches/{matchId}/timeline` | 2000/min | Agent 3 |
| `/lol/league/v4/entries/by-summoner/{id}` | 2000/min | Agent 1 |

### 8.2 Rate Limiter Design

```typescript
// Token bucket rate limiter respecting Riot's dual-header system
// X-App-Rate-Limit: 20:1,100:120 → 20 requests per 1s, 100 per 120s
// X-Method-Rate-Limit: varies per endpoint

interface RateLimiter {
  canRequest(endpoint: string): boolean;
  consumeToken(endpoint: string): void;
  waitForToken(endpoint: string): Promise<void>;
  updateLimits(headers: Record<string, string>): void;
}
```

### 8.3 API Key & Environment

```env
# .env.example
RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
RIOT_REGION=na1
RIOT_ROUTING=americas
ANTHROPIC_API_KEY=sk-ant-xxxxx
SUMMONER_NAME=YourSummonerName
SUMMONER_TAG=NA1
```

**Important:** Riot Development keys expire every 24 hours. Apply for a Personal or Production key early for sustained development.

---

## 9. DATA PERSISTENCE (SQLite)

### 9.1 Schema

```sql
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  game_creation INTEGER NOT NULL,
  game_duration INTEGER NOT NULL,
  game_mode TEXT NOT NULL,
  champion_id INTEGER NOT NULL,
  champion_name TEXT NOT NULL,
  role TEXT,
  win BOOLEAN NOT NULL,
  kills INTEGER,
  deaths INTEGER,
  assists INTEGER,
  cs INTEGER,
  vision_score INTEGER,
  gold_earned INTEGER,
  data_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at DATETIME NOT NULL,
  ended_at DATETIME,
  games_played INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  avg_kda REAL,
  tilt_score_final INTEGER,
  notes TEXT
);

CREATE TABLE tilt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  match_id TEXT REFERENCES matches(id),
  tilt_score INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  recommendation_given TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  game_phase TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  claude_model TEXT,
  tokens_used INTEGER,
  latency_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User settings (summoner name, overlay positions, enabled agents, etc.)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 10. BUILD, PACKAGE & RUN

### 10.1 Prerequisites

- Node.js 20+
- npm 10+
- League of Legends client installed (for LCU API and Live Client Data API)
- Riot Games Developer API key: https://developer.riotgames.com/
- Anthropic API key

### 10.2 Development

```bash
# Clone and install
git clone <repo>
cd rift-architect
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Run in development (hot-reload via electron-vite or similar)
npm run dev

# Run tests
npm test
```

### 10.3 Package.json Scripts

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron .",
    "package:win": "electron-builder --win",
    "package:mac": "electron-builder --mac",
    "package:linux": "electron-builder --linux",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --ext .ts"
  }
}
```

### 10.4 Electron Builder Config

```yaml
# electron-builder.yml
appId: com.riftarchitect.app
productName: Rift Architect
directories:
  output: dist-electron
files:
  - "out/**/*"
  - "resources/**/*"
win:
  target: [nsis]
  icon: resources/icon.ico
mac:
  target: [dmg]
  icon: resources/icon.icns
  category: public.app-category.games
linux:
  target: [AppImage]
  icon: resources/icon.png
nsis:
  oneClick: true
  perMachine: false
  allowToChangeInstallationDirectory: false
```

---

## 11. IMPLEMENTATION PRIORITY (BUILD ORDER)

### Phase 1: Foundation (Week 1)
1. ☐ Initialize Electron + TypeScript project with electron-vite
2. ☐ Implement LCU Connector (process detection, lockfile parsing, WebSocket)
3. ☐ Implement game phase state machine + orchestrator skeleton
4. ☐ Create system tray app with status display
5. ☐ Create overlay window manager (frameless, always-on-top, transparent)
6. ☐ Verify: app detects League client and shows correct phase in tray
7. ☐ Write mock fixtures for all LCU and Live Client API responses

### Phase 2: Integration Layer (Week 2)
8. ☐ Implement Riot remote API client with token-bucket rate limiter
9. ☐ Implement Live Client Data API poller
10. ☐ Implement Claude API client with tool-use support
11. ☐ Set up SQLite database with schema and migrations
12. ☐ Build base agent abstract class with common lifecycle methods
13. ☐ Write integration tests with mock fixtures

### Phase 3: Agent 1 — Drafting Oracle (Week 3)
14. ☐ Implement champ select data pipeline (LCU session → enemy PUUIDs → Riot API lookups)
15. ☐ Build Drafting Oracle agent with tools and prompt
16. ☐ Build draft overlay renderer (ban/pick recommendations UI)
17. ☐ Wire up: LCU champ select events → Agent 1 → IPC → Draft Overlay
18. ☐ Test with mock champ select data, then live

### Phase 4: Agent 2 — Macro Strategist (Week 4)
19. ☐ Build state change trigger detection system from Live Client Data
20. ☐ Build Macro Strategist agent with tools and prompt
21. ☐ Build macro overlay renderer (toast notifications with auto-dismiss)
22. ☐ Wire up: Live Client Data polling → Trigger Detection → Agent 2 → IPC → Macro Overlay
23. ☐ Test with mock game data, then in a bot game

### Phase 5: Agent 3 — Tilt Guard (Week 5)
24. ☐ Implement tilt metrics calculator
25. ☐ Build session tracking system (auto-detect session start/end)
26. ☐ Build Tilt Guard agent with tools and prompt
27. ☐ Build tilt overlay renderer (score display, cooldown routines with exercise cards)
28. ☐ Wire up: Post-game stats → Metrics → Agent 3 → IPC → Tilt Overlay

### Phase 6: Polish & Ship (Week 6)
29. ☐ End-to-end integration testing through a full game cycle
30. ☐ Error handling: LCU disconnect/reconnect, API failures, Claude timeouts
31. ☐ Settings UI in main window (summoner name, overlay positions, agent toggles)
32. ☐ Auto-launch on system startup option
33. ☐ Package with electron-builder for Windows + macOS
34. ☐ Write README with screenshots and architecture diagram
35. ☐ Record demo video of full game cycle

---

## 12. KEY DEPENDENCIES

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "better-sqlite3": "^11.5.0",
    "electron-log": "^5.2.0",
    "electron-store": "^10.0.0",
    "zod": "^3.23.0",
    "ws": "^8.18.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.1.0",
    "electron-vite": "^2.4.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/ws": "^8.5.0",
    "eslint": "^9.12.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0"
  }
}
```

---

## 13. RESUME TALKING POINTS

1. **Desktop Application Architecture** — Built a multi-window Electron app with frameless transparent overlays, system tray integration, and IPC-based inter-process communication.

2. **Multi-Agent Orchestration** — Designed a three-agent system with distinct reasoning domains, lifecycle management via a game-phase state machine, and shared context coordination.

3. **Local API Integration** — Reverse-engineered the League Client Update (LCU) protocol: process detection, lockfile credential parsing, WebSocket event subscription, and self-signed certificate handling.

4. **Restricted Remote API Integration** — Integrated Riot Games' rate-limited API with token-bucket rate limiting and dual-header parsing.

5. **Real-Time Data Pipelines** — Built polling and event-driven pipelines processing live game data with intelligent trigger detection to minimize unnecessary AI calls.

6. **Claude Tool-Use Architecture** — Designed structured tool schemas for three distinct agents, each with domain-specific tools and reasoning constraints.

7. **Cross-Domain Intelligence** — Bridged gaming analytics and physical wellness, demonstrating systems thinking across problem domains.

8. **Production Desktop Patterns** — SQLite persistence, structured logging, auto-update, cross-platform packaging, error recovery, and reconnection logic.

---

## 14. NOTES FOR CLAUDE CODE

- **Start with Phase 1 Foundation.** The LCU Connector is the backbone — nothing works without it.
- **Test against the actual League client early.** Phase 1 should end with you seeing game phase changes in the system tray status.
- **Build mock fixtures first** (`tests/fixtures/`) for all API responses. Use these for all unit and integration tests.
- **The LCU API uses a self-signed TLS cert.** In Node.js, you need to either set `NODE_TLS_REJECT_UNAUTHORIZED=0` (development only) or use a custom https agent that accepts the Riot Games root cert.
- **The Live Client Data API (port 2999) also uses self-signed certs.** Same approach needed.
- **Rate limiting is CRITICAL.** Riot will blacklist your API key if you exceed limits. Implement the rate limiter before any remote API calls.
- **Claude API calls should be LAZY.** Only invoke Claude when there's a meaningful state change. Never poll Claude on a timer.
- **Keep overlay renderers SIMPLE.** Vanilla HTML/CSS/TS. No framework. Keep the bundle small and startup fast. Use IPC for all data — renderers are pure display.
- **Electron security:** Use `contextIsolation: true`, `nodeIntegration: false`, and a preload script for all renderer processes.
- **Log everything.** Every agent invocation, every API call, every state transition. Use `electron-log` for structured logging that works in both main and renderer processes.
- **electron-vite** is recommended for the build toolchain — it handles main/renderer/preload compilation cleanly.

---

*End of specification. Build it phase by phase. Ship it. Put it on the resume.*
