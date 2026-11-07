# Contributing to CilamAI

Thank you for your interest in contributing to **CilamAI**! We welcome bug reports, feature requests, localization additions, and code contributions.

---

## 1. Getting Started

### Prerequisites
- **Node.js**: v20.x or later
- **npm**: v10.x or later
- **Git**

### Setup
1. **Fork & Clone** the repository:
   ```bash
   git clone https://github.com/CilamAI/CilamAI.git
   cd CilamAICode
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Run in development mode** (hot-reload):
   ```bash
   npm run dev
   ```

---

## 2. Project Structure

- `src/main/index.js` — Electron main process (IPC handlers, window state, credits, session storage).
- `src/preload/index.js` — Context bridge exposing secure APIs to renderer.
- `src/renderer/index.html` — Main desktop layout, sidebar, settings, and modal dialogs.
- `src/renderer/src/main.js` — Application frontend controller.
- `src/renderer/src/style.css` — Design system, themes, and animations.
- `src/renderer/public/lang/` & `lang/` — Multilingual translation JSON files (19 languages).

---

## 3. Localization Guidelines (i18n)

When adding or updating translation strings:
1. Ensure the key is added to **both** `src/renderer/public/lang/` and root `lang/`.
2. Maintain key parity across all 19 language files (`en`, `ko`, `tr`, `ru`, `zh`, `zh-TW`, `ja`, `es`, `fr`, `de`, `pt`, `it`, `ar`, `hi`, `vi`, `id`, `pl`, `uk`, `nl`).
3. For UI elements, use `data-i18n="key"` or `data-i18n-placeholder="key"`.
4. In JavaScript, use the localization helper:
   ```javascript
   tf('keyName', 'Fallback English Text')
   ```

---

## 4. Design & Theme Guidelines

- Use CSS custom properties defined in `:root` and theme data attributes:
  - Backgrounds: `var(--bg)`, `var(--surface)`, `var(--surface-2)`
  - Borders: `var(--border)`, `var(--border-focus)`
  - Text & Accents: `var(--text)`, `var(--text-dim)`, `var(--accent)`, `var(--accent-text)`
- Always use `var(--accent-text)` for text over `var(--accent)` backgrounds to guarantee contrast in dark and light themes.
- Add custom scrollbars to overflowing containers via `::-webkit-scrollbar` with `var(--scrollbar-thumb)`.

---

## 5. Building & Packaging

Before submitting a pull request, verify that the application compiles without errors:

```bash
# Build production bundle
npm run build

# Test Portable Windows executable
npm run dist:portable

# Test Windows Installer
npm run dist:nsis
```

---

## 6. Commit Message Conventions

We follow standard conventional commit message formats:
- `feat:` New features or UI components
- `fix:` Bug fixes and corrections
- `docs:` Documentation updates
- `style:` CSS, theme, or design system changes
- `refactor:` Code refactoring without behavioral changes
- `chore:` Dependency or build system updates

---

## 7. Submitting a Pull Request

1. Create a descriptive feature branch:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with clear messages.
3. Push to your branch and open a Pull Request against the `main` branch.
4. Describe the problem, solution, and test steps in your PR description.
