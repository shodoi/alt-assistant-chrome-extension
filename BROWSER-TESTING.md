# Browser verification

Real-browser smoke test for the unpacked extension. No Gemini API key is needed: the harness stubs the Gemini endpoint in the Service Worker, so the extension's own image, UI, messaging, and regeneration code still runs.

## Prerequisites

- Node.js 22+
- Microsoft Edge 157+ (Chromium). Chrome for Testing also works.

## Run

From the repository root:

```powershell
node test/browser/smoke.mjs "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" .
```

The harness:

1. serves a local page with a top-level `<img>`,
2. launches Edge headless with the extension loaded unpacked,
3. drives Instruction → generation → Regeneration → Alt apply,
4. prints JSON and exits non-zero on failure.

A successful run ends with `"pass": true` and includes `firstAltText`, `regeneratedAltText`, `geminiCalls: 2`, and `appliedAlt`.

## Why Edge

Branded Google Chrome can ignore command-line `--load-extension` (observed in Chrome 157), so the extension never starts. Edge 157 still accepts it. If a branded Chrome build rejects it, either load the extension manually from `chrome://extensions` or use Chrome for Testing.

## Scope

- Verifies: unpacked load, MV3 Service Worker startup, top-level image flow, regeneration, message passing, Alt application.
- Does not verify: the live Gemini API, model availability, or real network failures. The Gemini response is a stub; use a real API key in the extension's options page for a manual live check.
- The harness creates and removes an isolated temporary profile. It does not touch the user's browser profile.
