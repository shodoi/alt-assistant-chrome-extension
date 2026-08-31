// models.js
//
// Shared model definitions for background/options.
// Loaded via `importScripts()` in the MV3 service worker and via <script> in the options page.

const GEMINI_MODEL_DEFINITIONS = Object.freeze([
  Object.freeze({ 
    id: 'gemini-3.7-flash', 
    label: '3.7 Flash',
    desc: '高速かつ高性能な最新世代モデル。',
    speed: 4,
    quality: 4
  }),
  Object.freeze({ 
    id: 'gemini-3.1-flash-lite', 
    label: '3.1 Flash Lite',
    desc: '高速モデル。',
    speed: 5,
    quality: 4
  }),
  Object.freeze({ 
    id: 'gemini-3.1-pro-preview', 
    label: '3.1 Pro Preview',
    desc: '最新世代の高性能モデル。最高の推論能力を持ちます。',
    speed: 1,
    quality: 5
  }),
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

