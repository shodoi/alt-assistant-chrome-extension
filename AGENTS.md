# AGENTS.md

## Tickets

Work from `.scratch/alt-assistant-fixes/issues/` (local, gitignored). Each `NN-*.md` has `Blocked by`, `Status`, and acceptance checkboxes. Implement blockers-first, one ticket per session, and record evidence in the ticket before setting `Status: done`.

## Checks

- All-in-one check: `node test/check.mjs` (runs `node --check` on every tracked `.js`/`.mjs` and `node --test "test/**/*.test.js"`)
- PowerShell UTF-8 output (prevents Japanese garbling): `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; node test/check.mjs`
- CI: `.github/workflows/ci.yml` runs `node test/check.mjs`, Conventional Commits check, and `browser-smoke` (Edge on `windows-latest`) on push and pull request.

## Runtime loading

`utils/handshake.js` injects `['utils/dialog-lifecycle.js', 'utils/image-correlation.js', 'utils/input-history.js', 'utils/error-presentation.js', 'content.js']` into the page (single source: `CONTENT_SCRIPT_FILES`).
`utils/*.js` not in that list run only in `background.js` (`importScripts`) or in tests.
`test/runtime-wiring.test.js` enforces that any `window.AltAssistant*` referenced in `content.js` is in that injection list.
Frame-targeted messages are routed solely by `chrome.tabs.sendMessage(tabId, message, { frameId })`; content scripts must not compare `sender.frameId` (it is absent for extension-sent messages).

## Browser verification

Load the unpacked extension with Edge 157+ and run the smoke harness. See `BROWSER-TESTING.md`. Command-line `--load-extension` is unreliable in branded Chrome (observed in 157); use Edge or Chrome for Testing.

## `content.js` map

`content.js` is a single ~96KB IIFE. Navigate by function name, not line number:

- Styles: `GEMINI_SHADOW_STYLES`
- Shadow DOM: `getShadowRoot`, `getGeminiElement`
- A11y / live regions: `announceStatus`, `announceAlert`, `announceSuccess`, `attachDialogAccessibility`
- Background messages: `chrome.runtime.onMessage` listener
- Dialogs: `showInstructionDialog, showAltTextDialog, addMessageToChat` (close via `closeDialogElement` / dialog stack)
- Errors: `showRateLimitDialog`, `showApiKeyErrorDialog`, `showNetworkErrorDialog`, `showGeneralErrorDialog`
- Images / status: `handleExtractImageFromDom`, `findImageElement`, `showStatus`
