# AGENTS.md

## Tickets

Work from `.scratch/alt-assistant-fixes/issues/` (local, gitignored). Each `NN-*.md` has `Blocked by`, `Status`, and acceptance checkboxes. Implement blockers-first, one ticket per session, and record evidence in the ticket before setting `Status: done`.

## Checks

- Tests: `node --test test/`
- Syntax: `node --check` on every tracked `.js` / `.mjs`
- CI: `.github/workflows/ci.yml` runs both on push and pull request.

## Browser verification

Load the unpacked extension with Edge 157+ and run the smoke harness. See `BROWSER-TESTING.md`. Command-line `--load-extension` is unreliable in branded Chrome (observed in 157); use Edge or Chrome for Testing.

## `content.js` map

`content.js` is a single ~96KB IIFE. Navigate by function name, not line number:

- Styles: `GEMINI_SHADOW_STYLES`
- Shadow DOM: `getShadowRoot`, `getGeminiElement`
- A11y / live regions: `announceStatus`, `announceAlert`, `announceSuccess`, `attachDialogAccessibility`
- Background messages: `chrome.runtime.onMessage` listener
- Dialogs: `showInstructionDialog`, `showAltTextDialog`, `addMessageToChat`
- Errors: `showRateLimitDialog`, `showApiKeyErrorDialog`, `showNetworkErrorDialog`, `showGeneralErrorDialog`
- Images / status: `handleExtractImageFromDom`, `findImageElement`, `showStatus`
