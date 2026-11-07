# CilamAI - Project Context & Architecture

## 1. Overview
**CilamAI** is a cross-platform, frameless desktop AI chat application built with **Electron**, **Vite** (`electron-vite`), and vanilla JavaScript & CSS. It features local and cloud model streaming, Model Context Protocol (MCP) integrations, credits and usage tracking, and full internationalization supporting 19 languages.

---

## 2. Architecture & File Structure

```
CilamAICode/
├── lang/                       # Root localization JSON files (19 languages)
├── resources/                  # App icons, certificates, installer artwork
├── src/
│   ├── api/                    # API client configurations and endpoints
│   ├── main/
│   │   └── index.js            # Electron Main process (IPC, sessions, window state, credits)
│   ├── preload/
│   │   └── index.js            # Context bridge & secure IPC exposed to renderer
│   └── renderer/
│       ├── index.html          # Single page application structure & dialogs
│       ├── public/
│       │   └── lang/           # Renderer localization JSON files (synced with lang/)
│       └── src/
│           ├── main.js         # Frontend controller (chat, models, credits, MCP, hotkeys)
│           └── style.css       # Unified design system & theme variables
├── package.json                # Project dependencies, build targets & scripts
└── CONTEXT.md                  # This documentation
```

---

## 3. Credits & Account System

### 3.1 Credit Limits & Reset Intervals
- **Default Accounts**:
  - Credit Limit: `100` credits.
  - Reset Cycle: **24 hours** (`24 * 60 * 60 * 1000` ms).
- **VIP Accounts (`kevccx@gmail.com`)**:
  - Credit Limit: `100,000` (`100K`) credits.
  - Reset Cycle: **1 Year** (`365 * 24 * 60 * 60 * 1000` ms).
  - Displays expiration/reset as `Reset in DD/MM/YYYY HH:mm`.

### 3.2 Spent Tracking
- Displays cost calculated from consumed credits (`spent * $0.02`).
- Rendered in `.credit-menu-spent` as `${amount.toFixed(2)}$` (e.g. `0.00$`).

---

## 4. Internationalization (i18n)

The application supports **19 languages** with full key parity:

| Code | Language | Native Name |
| :--- | :--- | :--- |
| `en` | English | English |
| `ko` | Korean | 한국어 |
| `tr` | Turkish | Türkçe |
| `ru` | Russian | Русский |
| `zh` | Simplified Chinese | 简体中文 |
| `zh-TW` | Traditional Chinese | 繁體中文 |
| `ja` | Japanese | 日本語 |
| `es` | Spanish | Español |
| `fr` | French | Français |
| `de` | German | Deutsch |
| `pt` | Portuguese | Português |
| `it` | Italian | Italiano |
| `ar` | Arabic | العربية |
| `hi` | Hindi | हिन्दी |
| `vi` | Vietnamese | Tiếng Việt |
| `id` | Indonesian | Bahasa Indonesia |
| `pl` | Polish | Polski |
| `uk` | Ukrainian | Українська |
| `nl` | Dutch | Nederlands |

- **Attributes**: Elements localized via `data-i18n="key"` and `data-i18n-placeholder="key"`.
- **Dynamic Models**: Model selector buttons and folder headings (e.g. `Auto` / `AUTO`) dynamically localize upon language switch.

---

## 5. Model Context Protocol (MCP) Tools

- **Settings UI**: Manage external tool servers via **Settings > MCP Tools**.
- **Supported Transports**:
  - `stdio`: Local executable command and CLI arguments.
  - `sse`: Server-Sent Events URL endpoints.
- **Quick Templates**:
  - *Filesystem*, *Brave Search*, *GitHub*, *Memory*.
- **Storage**: Persisted locally in `localStorage` under `cilamai-mcp-servers`.

---

## 5b. Agent Project Tools (local file tools in the chat stream)

The assistant can read the user's own project instead of guessing about it. Tools run in
the **main process** and are strictly read-only, sandboxed to one chosen project folder.

- **Modules**:
  - `src/main/agent-tools.js` — path sandbox, `read_file` / `grep_file` / `list_dir`, folder persistence.
  - `src/renderer/src/agent-tools.js` — tool-call detection, real tool chips, the multi-round agent loop.
- **Project folder**: chosen from the composer attach menu (**Project folder**) or `/folder`;
  persisted in `<userData>/agent-root.json`. Without a folder, the old "no local access"
  system prompt is used and no tool is executed.
- **Tool protocol** (text-based, so it works with every provider; native `tool_calls` are also accepted):
  - `grep_file({"pattern":"sendStream","path":"src","glob":"*.js","ignoreCase":true,"fixed":false})`
  - `read_file({"path":"src/main/index.js","offset":1,"limit":200})`
  - `list_dir({"path":"src/renderer"})`
- **Loop**: the streamed reply is scanned outside code fences for complete calls, each call is
  executed for real, a chip (`Read`/`Grep`/`List` + result summary) is rendered in `.agent-tools`
  inside the reply bubble, and the real result is sent back to the model as a follow-up user
  message. Stops after 8 rounds, 24 calls, a repeated call, a user stop, or a plain answer.
- **Limits**: read ≤ 600 numbered lines / 2 MB per file; grep ≤ 120 matches, skips binaries,
  files > 1.5 MB and ignored dirs (`node_modules`, `.git`, `dist`, `out`, `build`, …); results
  are clamped before being sent back to the model.
- **History**: the tool run is stored as `message.toolTrace` and re-rendered as chips when a
  session is reopened; a compact note is added to the next request so earlier real results stay visible.

---

## 6. Design System & Themes

- **Themes Supported**: `Dark` (default), `Light`, `Blue`, `Red`, `Yellow`, `Green`, `Black`, `GitHub Light`, `GitHub Dark`, `System`.
  - `GitHub Light` / `GitHub Dark` use Primer color tokens from `@primer/css` v22.3.3 (light: `#ffffff` / `#f6f8fa` / `#1f2328` / accent `#0969da`; dark: `#0d1117` / `#010409` / `#151b23` / `#f0f6fc` / accent `#1f6feb`).
  - Light-scheme fixes are shared by `light` and `github-light` (`html[data-theme='light'], html[data-theme='github-light'] ...`).
- **Theme Variables**: Full contrast safety using `--bg`, `--surface`, `--border`, `--text`, `--accent`, and `--accent-text`.
- **Scrollable Menus**: Custom webkit scrollbars applied to `.lang-select-menu`, `.font-select-menu`, `.model-menu`, `.commands-menu`, `.user-menu`, `.credit-menu`, `.mcp-dialog`, and `.auth-dialog`.

---

## 7. Packaging & Scripts

- **Development**: `npm run dev`
- **Frontend/Backend Build**: `npm run build`
- **Windows Portable**: `npm run dist:portable` (generates `CilamAIPortable.exe`)
- **Windows Installer**: `npm run dist:nsis` (generates `CilamAISetup.exe`)
- **Directory Build**: `npm run dist:dir`
