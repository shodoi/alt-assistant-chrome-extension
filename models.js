// models.js
//
// Shared model definitions for background/options.
// Loaded via `importScripts()` in the MV3 service worker and via <script> in the options page.

const GEMINI_MODEL_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'gemini-3-flash-preview', label: '3.0 Flash Preview' }),
  Object.freeze({ id: 'gemini-2.5-flash', label: '2.5 Flash' }),
  Object.freeze({ id: 'gemini-2.5-pro', label: '2.5 Pro' }),
  Object.freeze({ id: 'gemini-3-pro-preview', label: '3.0 Pro Preview' }),
  Object.freeze({ id: 'gemini-2.5-flash-lite', label: '2.5 Flash-Lite' }),
]);

const GEMINI_MODEL_BY_ID = new Map(GEMINI_MODEL_DEFINITIONS.map((model) => [model.id, model]));

const GEMINI_DEFAULT_MODEL_ORDER = Object.freeze(GEMINI_MODEL_DEFINITIONS.map((model) => model.id));

function normalizeGeminiModelOrder(orderIds) {
  const seen = new Set();
  const normalized = [];

  if (Array.isArray(orderIds)) {
    for (const modelId of orderIds) {
      if (!GEMINI_MODEL_BY_ID.has(modelId)) continue;
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      normalized.push(modelId);
    }
  }

  for (const modelId of GEMINI_DEFAULT_MODEL_ORDER) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    normalized.push(modelId);
  }

  return normalized;
}

function getGeminiModelsByOrder(orderIds) {
  const normalized = normalizeGeminiModelOrder(orderIds);
  return normalized.map((modelId) => GEMINI_MODEL_BY_ID.get(modelId)).filter(Boolean);
}

