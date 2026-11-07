# Changelog

All notable changes to CilamAI are documented in this file.

## [v0.1.1] - November 7, 2026

### Settings dialog
- **New:** Settings now opens as a focused dialog from the account row in the sidebar footer, replacing the full-page view. General leads with the Current theme card: a live miniature of your window, the theme name, palette swatches and a shortcut straight to the theme picker.

### Settings search
- **New:** Search now filters the real setting rows and theme cards on every page, not just the page names. Matches are highlighted in the page list, and clearing the query returns you to the page you were on.

### Sidebar controls
- **Added:** Two new settings: Hide sidebar starts the app with the sidebar and panel collapsed for a full-width chat area, and Disable sidebar removes the sidebar entirely and locks its toggle until you re-enable it. The splash screen honors both.

### Taskbar badge
- **Added:** When a reply finishes while the window is unfocused or minimized, the app icon gets a small "1" badge in the taskbar. It clears the moment you come back to the window.

### Dialogs
- **New:** About CilamAI and release notes moved from full pages into dialogs you can open anytime from the More menu, and this view was rewritten into a What's New format with plain-language highlights.

### Themes
- **Added:** Two new themes: OpenCode (a neutral grey scale with a warm orange primary and purple accents) and OpenCode Light with a warm paper palette. The Current theme miniature is a real capture of your window, so it always matches the active theme.

### Bug fixes
- **Fixed:** Markdown rendering for fenced code blocks, blockquotes and list numbers; code blocks no longer stretch to viewport width; message images are capped to the bubble and failed sources no longer paint white blocks in dark themes.

## [v0.1.0.1] - August 14, 2026

### Accounts
- **Added:** User account system with sign in, avatar and sign out. Sending chat messages now requires a signed-in account, and the credits menu tracks your spent amount.

### Startup
- **Fixed:** The app opens a fresh new chat on launch, Settings moved to the bottom of the sidebar, and startup fades out smoothly.

## [v0.1.0] - August 12, 2026

### First release
- **New:** The initial release of the CilamAI desktop chat application: real-time streaming responses, file uploads, screenshot capture, session search and history, model selection, credit and usage tracking with a 24-hour reset, notifications, and a help menu with keyboard shortcuts.

### Customization
- **Added:** Multiple themes (Dark, Light, System, Blue, Red, Yellow, Green and Black), adjustable chat text size, customizable hotkeys with reset to defaults, and a launch-on-startup option.

### Multi-language
- **Added:** English, Korean, Turkish and Russian out of the box, with GitHub integration for repository access.
