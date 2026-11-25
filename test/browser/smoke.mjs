// Baseline smoke test: loads the unpacked extension in Edge (Chromium),
// stubs the Gemini endpoint, and drives Instruction -> generation -> regeneration
// on a top-level <img>. No real API key or network access to Google is used.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { STATUS_AUTO_HIDE_MS } from '../../options.js';

const edgePath = process.argv[2];
const rawExtPath = process.argv[3];
if (!edgePath || !rawExtPath) {
  console.error('usage: node test/browser/smoke.mjs <edge.exe> <extension-dir>');
  process.exit(2);
}
const extPath = path.resolve(rawExtPath);

// 成功メッセージの自動非表示 + 余裕（options.js の実装と同期させる）
const OPTIONS_STATUS_RACE_WAIT_MS = STATUS_AUTO_HIDE_MS + 300;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(size = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 40;
      raw[o + 1] = 120;
      raw[o + 2] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
const PIXEL_PNG = makePng(64);
const QUOTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2a7"/></svg>';
// 最小の 1x1 GIF89a
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Alt Assistant Smoke</title></head>
<body>
  <h1>Top-level image smoke test</h1>
  <img id="target" src="/pixel.png" alt="">
  <img id="target-2" src="/pixel-2.png" alt="">
  <div style="margin-top: 120px"><img id="same-1" src="/same.png" alt="" width="64" height="64"></div>
  <div style="margin-top: 160px"><img id="same-2" src="/same.png" alt="" width="64" height="64"></div>
  <img id="srcset-target" src="/srcset-fallback.png" srcset="/srcset-displayed.png 1x" alt="" width="64" height="64">
  <img id="quoted-target" src='data:image/svg+xml;utf8,${QUOTED_SVG}' alt="" width="32" height="32">
  <img id="svg-target" src="/logo.svg" alt="" width="32" height="32">
  <img id="blob-target" alt="" width="32" height="32">
  <img id="gif-target" src="/anim.gif" alt="" width="16" height="16">
  <button id="page-button" type="button" style="position: fixed; right: 24px; bottom: 24px; z-index: 1;">page button</button>
  <script>
    window.__pageButtonClicks = 0;
    document.getElementById('page-button').addEventListener('click', () => { window.__pageButtonClicks += 1; });
  </script>
</body></html>`;

const imageServer = http.createServer((req, res) => {
  if (req.url === '/logo.svg') {
    const svgBuf = Buffer.from(QUOTED_SVG, 'utf8');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': svgBuf.length });
    res.end(svgBuf);
    return;
  }
  if (req.url === '/anim.gif') {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': PIXEL_GIF.length });
    res.end(PIXEL_GIF);
    return;
  }
  if (
    req.url === '/pixel.png' ||
    req.url === '/pixel-2.png' ||
    req.url === '/same.png' ||
    req.url === '/srcset-fallback.png' ||
    req.url === '/srcset-displayed.png'
  ) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PIXEL_PNG.length });
    res.end(PIXEL_PNG);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${imageServer.address().port}`;
const imageUrl = `${origin}/pixel.png`;
const imageUrl2 = `${origin}/pixel-2.png`;
const sameUrl = `${origin}/same.png`;
const srcsetFallbackUrl = `${origin}/srcset-fallback.png`;
const srcsetDisplayedUrl = `${origin}/srcset-displayed.png`;
const quotedUrl = `data:image/svg+xml;utf8,${QUOTED_SVG}`;
const svgUrl = `${origin}/logo.svg`;
const gifUrl = `${origin}/anim.gif`;

/** スモーク全体で想定する Gemini API 呼び出し回数（シーン追加時はここだけ更新する） */
const EXPECTED_TOTAL_GEMINI_CALLS = 17;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-smoke-profile-'));
const debugPort = 19000 + Math.floor(Math.random() * 900);
const chrome = spawn(
  edgePath,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    `--remote-debugging-port=${debugPort}`,
    origin
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
let chromeStderr = '';
chrome.stderr.on('data', (d) => {
  chromeStderr += d.toString();
  if (chromeStderr.length > 20000) chromeStderr = chromeStderr.slice(-20000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function cdp(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${label} CDP error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      events.push({ type: 'exception', detail: msg.params.exceptionDetails?.text || '' });
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      events.push({
        type: msg.params.type,
        detail: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      });
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(`${label} evaluation failed: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description || '')}`);
    }
    return result.result.value;
  };
  return { ws, send, evaluate, events };
}

const results = { loaded: false, steps: {}, errors: [] };

try {
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return res.ok;
  }, { label: 'Edge debug endpoint', timeout: 20000 });

  const pageTarget = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === 'page' && t.url.startsWith(origin)) || null;
  }, { label: 'page target', timeout: 20000 });

  // Identify our extension's service worker by manifest name. The worker may
  // start lazily after the profile is created, so keep re-checking the target list.
  let swTarget = null;
  let swInfo = null;
  const probed = new Set();
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const list = await res.json();
    for (const worker of list.filter((t) => t.type === 'service_worker')) {
      if (probed.has(worker.id)) continue;
      probed.add(worker.id);
      try {
        const client = await cdp(worker.webSocketDebuggerUrl, 'probe');
        const raw = await waitFor(
          () => client.evaluate('typeof chrome !== "undefined" && chrome.runtime ? JSON.stringify(chrome.runtime.getManifest()) : null'),
          { timeout: 3000, label: 'manifest probe' }
        );
        client.ws.close();
        const manifest = JSON.parse(raw);
        if (manifest.name === 'Gemini Alt Text Generator') {
          swTarget = worker;
          swInfo = { id: worker.url.split('/')[2], name: manifest.name, version: manifest.version };
          return true;
        }
      } catch {
        // ignore non-extension or non-responsive targets
      }
    }
    return false;
  }, { label: 'extension service worker (unpacked load)', timeout: 25000 });
  if (!swTarget) throw new Error('extension service worker not found (unpacked load failed)');
  results.loaded = true;
  results.extension = swInfo;

  const pageClient = await cdp(pageTarget.webSocketDebuggerUrl, 'page');
  const swClient = await cdp(swTarget.webSocketDebuggerUrl, 'sw');

  const tabId = await swClient.evaluate(
    `chrome.tabs.query({ url: ${JSON.stringify(origin + '/*')} }).then(tabs => tabs[0] && tabs[0].id)`,
    { awaitPromise: true }
  );
  if (!tabId) throw new Error('could not resolve tabId');
  results.steps.tabId = tabId;

  await swClient.evaluate(
    `chrome.storage.local.set({ geminiApiKey: 'smoke-test-key' }).then(() => true)`,
    { awaitPromise: true }
  );

  await swClient.evaluate(`
    globalThis.__smoke = { geminiCalls: 0, fetchedImageUrls: [], geminiScriptedResponses: [], lastGeminiPrompt: null };
    const __realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('generativelanguage.googleapis.com')) {
        globalThis.__smoke.geminiCalls += 1;
        try {
          const parsedBody = JSON.parse(init?.body || '{}');
          globalThis.__smoke.lastGeminiPrompt = parsedBody?.contents?.[0]?.parts?.[0]?.text || null;
        } catch {
          globalThis.__smoke.lastGeminiPrompt = null;
          globalThis.__smoke.promptParseErrors = (globalThis.__smoke.promptParseErrors || 0) + 1;
        }
        const scripted = globalThis.__smoke.geminiScriptedResponses.shift();
        if (scripted) {
          if (scripted.hang) {
            return new Promise(() => {});
          }
          return new Response(JSON.stringify(scripted.body ?? { error: { message: scripted.message || 'Mock error' } }), {
            status: scripted.status,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const n = globalThis.__smoke.geminiCalls;
        const text = n === 1 ? 'スモークテスト用の代替テキスト' : '再生成後の代替テキスト';
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.startsWith(${JSON.stringify(origin)})) {
        globalThis.__smoke.fetchedImageUrls.push(url);
      }
      return __realFetch(input, init);
    };
    true;
  `);

  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(imageUrl)}, ${tabId}, 0, null); 'started'`
  );

  const shadow = `document.getElementById('gemini-alt-assistant-host')?.shadowRoot`;

  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!(r && r.getElementById('gemini-instruction-dialog')); })()`),
    { label: 'instruction dialog' }
  );
  results.steps.instructionDialog = true;

  const promptFocusedExpression = `(() => {
    const r = ${shadow};
    const textarea = r.getElementById('gemini-prompt-textarea');
    return Boolean(textarea && r.activeElement === textarea);
  })()`;

  // --- 重ねたダイアログ: 最前面だけが Escape で閉じ、フォーカスが戻る ---
  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, {
      action: 'errorAltTextGeneration',
      imageUrl: ${JSON.stringify(imageUrl)},
      errorMessage: 'テスト用のネットワークエラー',
      errorType: 'NETWORK_ERROR',
      errorDetails: { type: 'NETWORK_ERROR', userMessage: 'テスト用のネットワークエラー' },
      aiProvider: 'Gemini'
    }).then(() => true)
  `, { awaitPromise: true });

  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-error-dialog'); })()`),
    { label: 'stacked error dialog' }
  );

  await pageClient.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);

  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      return !r.getElementById('gemini-error-dialog') && !!r.getElementById('gemini-instruction-dialog');
    })()`),
    { label: 'Escape closes only the topmost dialog' }
  );
  results.steps.stackedEscapeClosedTopOnly = true;

  results.steps.focusRestoredToInstruction = await waitFor(
    () => pageClient.evaluate(promptFocusedExpression),
    { label: 'focus restoration after closing stacked dialog' }
  );

  // --- 実配線での Tab 循環: 最後のフォーカス可能要素から Tab で先頭へ戻る ---
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('submit-auto-model').focus();
    return true;
  })()`);
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  });
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  });
  results.steps.tabCycledInDialog = await waitFor(
    () => pageClient.evaluate(promptFocusedExpression),
    { label: 'Tab focus cycling inside instruction dialog' }
  );

  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const textarea = r.getElementById('gemini-prompt-textarea');
    textarea.value = 'スモークテストの指示';
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);

  const firstText = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length ? areas[areas.length - 1].value : null;
    })()`),
    { label: 'first generated alt text' }
  );
  results.steps.firstAltText = firstText;

  // --- #08 1: AI テキストにキーボードフォーカスすると可視リングが出る ---
  const aiTextFocusState = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r && r.getElementById('gemini-alt-dialog');
    const textarea = dialog && dialog.querySelector('.gemini-ai-text');
    if (!textarea) return null;
    textarea.focus();
    const style = getComputedStyle(textarea);
    return {
      active: r.activeElement === textarea,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor
    };
  })()`);
  results.steps.aiTextFocusRingVisible = Boolean(
    aiTextFocusState &&
    aiTextFocusState.active === true &&
    aiTextFocusState.outlineStyle !== 'none' &&
    parseFloat(aiTextFocusState.outlineWidth) >= 2 &&
    aiTextFocusState.outlineColor !== 'rgba(0, 0, 0, 0)' &&
    aiTextFocusState.outlineColor !== 'transparent'
  );

  // --- #08 2: モーダル表示中は背後のページをクリックできない ---
  const pageButtonPoint = await pageClient.evaluate(`(() => {
    const button = document.getElementById('page-button');
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const clickPageButton = async () => {
    await pageClient.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pageButtonPoint.x,
      y: pageButtonPoint.y,
      button: 'left',
      clickCount: 1
    });
    await pageClient.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pageButtonPoint.x,
      y: pageButtonPoint.y,
      button: 'left',
      clickCount: 1
    });
    await sleep(120);
    return pageClient.evaluate('window.__pageButtonClicks');
  };
  const backdropWhileOpen = await pageClient.evaluate(
    `(() => { const r = ${shadow}; return !!r.getElementById('gemini-modal-backdrop'); })()`
  );
  const clicksWhileModalOpen = await clickPageButton();

  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    dialog.querySelector('#gemini-instruction-input').value = 'もっと短く';
    dialog.querySelector('.gemini-input-area button').click();
    return true;
  })()`);

  const regenerated = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length >= 2 ? areas[areas.length - 1].value : null;
    })()`),
    { label: 'regenerated alt text' }
  );
  results.steps.regeneratedAltText = regenerated;

  const geminiCalls = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.geminiCalls = geminiCalls;
  const pixelFetchCount = await swClient.evaluate(
    `globalThis.__smoke.fetchedImageUrls.filter((u) => u === ${JSON.stringify(imageUrl)}).length`
  );
  results.steps.regenerationReusedImageCache = pixelFetchCount === 1;

  // Apply the latest result and confirm the page image alt attribute changes.
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    const applyButtons = [...dialog.querySelectorAll('.gemini-icon-btn.is-apply')];
    applyButtons[applyButtons.length - 1].click();
    return true;
  })()`);
  const appliedAlt = await waitFor(
    () => pageClient.evaluate(`document.getElementById('target').getAttribute('alt') || null`),
    { label: 'applied alt attribute' }
  );
  results.steps.appliedAlt = appliedAlt;

  results.steps.regenerationDialogClosed = await pageClient.evaluate(
    `(() => { const r = ${shadow}; return !r.getElementById('gemini-alt-dialog'); })()`
  );

  // --- #08 3: 閉じた後に画像へフォーカスが戻り、可視リングが出る ---
  results.steps.focusRestoredToImage = await waitFor(
    () => pageClient.evaluate(`(() => {
      const img = document.getElementById('target');
      if (!img || document.activeElement !== img) return false;
      const style = getComputedStyle(img);
      return img.getAttribute('tabindex') === '-1' &&
        style.outlineStyle !== 'none' &&
        parseFloat(style.outlineWidth) >= 2 &&
        style.outlineColor !== 'rgba(0, 0, 0, 0)' &&
        style.outlineColor !== 'transparent';
    })()`),
    { label: 'focus restored to image with visible ring' }
  );

  // --- #08 4: ダイアログを閉じるとバックドロップが消え、ページを操作できる ---
  const backdropAfterClose = await pageClient.evaluate(
    `(() => { const r = ${shadow}; return !r.getElementById('gemini-modal-backdrop'); })()`
  );
  const clicksAfterClose = await clickPageButton();
  results.steps.modalBackdropBlocksBackground =
    backdropWhileOpen === true &&
    clicksWhileModalOpen === 0 &&
    backdropAfterClose === true &&
    clicksAfterClose === 1;

  // --- 連続する指示リクエスト: 先のリクエストはハングせずキャンセルされる ---
  await swClient.evaluate(`globalThis.__firstInstruction = null; 'reset'`);
  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, { action: 'showInstructionDialog' })
      .then((choice) => { globalThis.__firstInstruction = choice == null ? 'null' : 'value'; });
    'sent-first'
  `);

  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'first instruction dialog' }
  );

  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, { action: 'showInstructionDialog' })
      .then((choice) => { globalThis.__secondInstruction = choice == null ? 'null' : 'value'; });
    'sent-second'
  `);

  results.steps.supersededInstructionCancelled = await waitFor(
    () => swClient.evaluate('globalThis.__firstInstruction'),
    { label: 'superseded instruction response' }
  ) === 'null';

  results.steps.singleInstructionDialog = await pageClient.evaluate(
    `(() => { const r = ${shadow}; return r.querySelectorAll('#gemini-instruction-dialog').length === 1; })()`
  );

  await pageClient.evaluate(`(() => { const r = ${shadow}; r.getElementById('cancel-instruction-dialog').click(); return true; })()`);
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'second instruction dialog cancelled' }
  );

  // --- 閉じたチャットへの遅延結果: 再表示せず、次の生成結果は表示する ---
  const sendAltResult = (altText, url = imageUrl) => swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, {
      action: 'updateAltText',
      imageUrl: ${JSON.stringify(url)},
      altText: ${JSON.stringify(altText)},
      aiProvider: 'Gemini'
    }).then(() => true)
  `, { awaitPromise: true });

  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, { action: 'startAltTextGeneration', imageUrl: ${JSON.stringify(imageUrl)} })
      .then(() => true)
  `, { awaitPromise: true });

  await sendAltResult('破棄テスト前の結果');
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-alt-dialog'); })()`),
    { label: 'chat dialog opened for result gate' }
  );

  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !r.getElementById('gemini-alt-dialog'); })()`),
    { label: 'chat dialog closed before late result' }
  );

  await sendAltResult('閉じた後の遅延結果');
  await sleep(300);
  results.steps.lateResultSuppressed = await pageClient.evaluate(
    `(() => { const r = ${shadow}; return !r.getElementById('gemini-alt-dialog'); })()`
  );

  await sendAltResult('再表示される次の結果');
  results.steps.lateResultSuppressionConsumed = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length ? areas[0].value : null;
    })()`),
    { label: 'next result delivered after suppressed one' }
  ) === '再表示される次の結果';

  // --- 別画像によるダイアログ置き換え: invokeOnClose: false により元画像の次回結果が破棄されない ---
  await sendAltResult('2枚目画像の結果', imageUrl2);
  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      return dialog && dialog.dataset.imageSrc === ${JSON.stringify(imageUrl2)};
    })()`),
    { label: 'chat dialog replaced by second image' }
  );

  await sendAltResult('置き換え後も届く結果', imageUrl);
  results.steps.replacedImageResultDelivered = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      if (!dialog || dialog.dataset.imageSrc !== ${JSON.stringify(imageUrl)}) return null;
      const areas = [...dialog.querySelectorAll('.chat-bubble-ai textarea')];
      return areas.length ? areas[0].value : null;
    })()`),
    { label: 'original image result delivered after dialog replacement' }
  ) === '置き換え後も届く結果';

  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // --- #05 1: 同一URLの2枚目画像を右クリックし、状態位置・生成・Regenerationが2枚目に紐づく ---
  await pageClient.evaluate(`(() => {
    const img2 = document.getElementById('same-2');
    img2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    img2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);

  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(sameUrl)}, ${tabId}, 0, null); 'started-same-2'`
  );
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for same-2' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('gemini-prompt-textarea').value = '2枚目の同じURL画像';
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);

  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-alt-dialog'); })()`),
    { label: 'alt dialog for same-2' }
  );

  // Regeneration で対象要素が変わらず same-2 に維持されること
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    dialog.querySelector('#gemini-instruction-input').value = '2枚目のまま再生成';
    dialog.querySelector('.gemini-input-area button').click();
    return true;
  })()`);

  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length >= 2;
    })()`),
    { label: 'regenerated alt text for same-2' }
  );

  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    const applyButtons = [...dialog.querySelectorAll('.gemini-icon-btn.is-apply')];
    applyButtons[applyButtons.length - 1].click();
    return true;
  })()`);

  const sameStatusCheck = await waitFor(
    () => pageClient.evaluate(`(() => {
      const alt1 = document.getElementById('same-1').getAttribute('alt') || '';
      const alt2 = document.getElementById('same-2').getAttribute('alt') || '';
      const r = ${shadow};
      const badge = r && r.querySelector('.gemini-alt-status.is-success');
      if (!alt2 || !badge) return null;
      const rect1 = document.getElementById('same-1').getBoundingClientRect();
      const rect2 = document.getElementById('same-2').getBoundingClientRect();
      const badgeTop = parseFloat(badge.style.insetBlockStart);
      return {
        alt1,
        alt2,
        nearSecond: Math.abs(badgeTop - (rect2.top + window.scrollY - 36)) < Math.abs(badgeTop - (rect1.top + window.scrollY - 36))
      };
    })()`),
    { label: 'applied alt and status position on same-2' }
  );
  results.steps.sameUrlSecondImageTargeted =
    sameStatusCheck.alt1 === '' &&
    sameStatusCheck.alt2 === '再生成後の代替テキスト' &&
    sameStatusCheck.nearSecond === true;

  // --- #05 2: srcset 画像で実際に表示中の currentSrc が生成対象になる ---
  await pageClient.evaluate(`(() => {
    const srcsetImg = document.getElementById('srcset-target');
    srcsetImg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    srcsetImg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);

  await swClient.evaluate(`globalThis.__smoke.fetchedImageUrls = []; true;`);
  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(srcsetFallbackUrl)}, ${tabId}, 0, null); 'started-srcset'`
  );
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for srcset' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const d = r && r.getElementById('gemini-alt-dialog');
      return d && d.dataset.imageSrc === ${JSON.stringify(srcsetDisplayedUrl)};
    })()`),
    { label: 'srcset dialog bound to currentSrc' }
  );
  const fetchedForSrcset = await swClient.evaluate(`globalThis.__smoke.fetchedImageUrls`);
  results.steps.srcsetUsedCurrentSrc =
    fetchedForSrcset.includes(srcsetDisplayedUrl) && !fetchedForSrcset.includes(srcsetFallbackUrl);
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // --- #05 3: 引用符を含む URL でも状態表示・結果更新が壊れない ---
  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, {
      action: 'startAltTextGeneration',
      imageUrl: ${JSON.stringify(quotedUrl)},
      targetElementId: 'quoted-target',
      requestId: 'smoke-quoted-req'
    }).then(() => true)
  `, { awaitPromise: true });
  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const badge = r && r.querySelector('.gemini-alt-status.is-loading');
      return badge && badge.dataset.requestId === 'smoke-quoted-req';
    })()`),
    { label: 'loading status badge for quoted URL' }
  );
  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, {
      action: 'updateAltText',
      imageUrl: ${JSON.stringify(quotedUrl)},
      targetElementId: 'quoted-target',
      requestId: 'smoke-quoted-req',
      altText: '引用符付きURLの結果',
      aiProvider: 'Gemini'
    }).then(() => true)
  `, { awaitPromise: true });
  results.steps.quotedUrlHandledSafely = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const d = r && r.getElementById('gemini-alt-dialog');
      const areas = d ? [...d.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length && areas[0].value === '引用符付きURLの結果';
    })()`),
    { label: 'alt dialog opened for quoted URL' }
  );
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // --- #06 1: SVG 画像でラスタライズ経由の生成ができる ---
  await pageClient.evaluate(`(() => {
    const svgImg = document.getElementById('svg-target');
    svgImg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    svgImg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(svgUrl)}, ${tabId}, 0, 'svg-target'); 'started-svg'`
  );
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for SVG image' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  results.steps.svgImageGenerated = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const d = r && r.getElementById('gemini-alt-dialog');
      const areas = d ? [...d.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return d && d.dataset.imageSrc === ${JSON.stringify(svgUrl)} && areas.length > 0;
    })()`),
    { label: 'alt dialog opened for SVG image' }
  );
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // --- #06 2: blob: 画像で DOM 抽出フォールバック経由の生成ができる ---
  const blobUrl = await pageClient.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#36c';
    ctx.fillRect(0, 0, 32, 32);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    const img = document.getElementById('blob-target');
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return url;
  })()`, { awaitPromise: true });
  await pageClient.evaluate(`(() => {
    const blobImg = document.getElementById('blob-target');
    blobImg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    blobImg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(blobUrl)}, ${tabId}, 0, 'blob-target'); 'started-blob'`
  );
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for blob image' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  results.steps.blobImageGenerated = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const d = r && r.getElementById('gemini-alt-dialog');
      const areas = d ? [...d.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return d && d.dataset.imageSrc === ${JSON.stringify(blobUrl)} && areas.length > 0;
    })()`),
    { label: 'alt dialog opened for blob image' }
  );
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // --- #06 3: 未対応形式 (GIF) は Gemini API を呼ばず分かりやすいエラーダイアログを出す ---
  const geminiCallsBeforeGif = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  await pageClient.evaluate(`(() => {
    const gifImg = document.getElementById('gif-target');
    gifImg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    gifImg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  await swClient.evaluate(
    `startGenerationProcess(${JSON.stringify(gifUrl)}, ${tabId}, 0, 'gif-target'); 'started-gif'`
  );
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for GIF image' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  const gifErrorText = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const errDialog = r && r.getElementById('gemini-error-dialog');
      if (!errDialog) return null;
      const desc = errDialog.querySelector('.gemini-dialog-description');
      return desc ? desc.textContent : null;
    })()`),
    { label: 'error dialog for unsupported GIF image' }
  );
  const geminiCallsAfterGif = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.unsupportedGifRejected =
    Boolean(gifErrorText && gifErrorText.includes('GIF') && gifErrorText.includes('未対応')) &&
    geminiCallsAfterGif === geminiCallsBeforeGif;
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-error-dialog button').click(); return true; })()`);

  // --- #07: ネットワークタイムアウトとリトライ検証 (429->200 / 5xx上限 / 401即時失敗 / タイムアウト復帰 / options検証タイムアウト) ---
  await swClient.evaluate(`
    globalThis.__altAssistantTimeouts = { imageFetchMs: 250, geminiApiMs: 250 };
    globalThis.__altAssistantRetryOverrides = { maxRetries: 2, baseDelay: 20, maxDelay: 50, jitter: false };
    true;
  `);

  async function triggerImageGeneration(id, label) {
    await pageClient.evaluate(`(() => {
      const img = document.getElementById(${JSON.stringify(id)});
      img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      return true;
    })()`);
    await swClient.evaluate(`startGenerationProcess(${JSON.stringify(imageUrl)}, ${tabId}, 0, ${JSON.stringify(id)}); 'started'`);
    await waitFor(
      () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
      { label: `instruction dialog for ${label}` }
    );
    await pageClient.evaluate(`(() => { const r = ${shadow}; r.getElementById('submit-auto-model').click(); return true; })()`);
  }

  // #07-1: 429 -> 200 で自動再試行して成功する
  const callsBefore429 = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { status: 429, message: 'Rate limit exceeded (429)' },
      { status: 200, body: { candidates: [{ content: { parts: [{ text: '429再試行後に生成されたテキスト' }] } }] } }
    ];
    true;
  `);
  await triggerImageGeneration('target', '#07 429->200');
  const textAfter429Retry = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const d = r && r.getElementById('gemini-alt-dialog');
      const areas = d ? [...d.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length ? areas[areas.length - 1].value : null;
    })()`),
    { label: 'alt dialog opened after 429->200 retry' }
  );
  const callsAfter429 = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.retry429Succeeded = textAfter429Retry === '429再試行後に生成されたテキスト' && (callsAfter429 - callsBefore429) === 2;

  // #07-2: チャットからの再生成中にタイムアウトした場合、タイムアウトダイアログが出てチャットUIが復帰する
  const callsBeforeTimeout = callsAfter429;
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { hang: true }
    ];
    true;
  `);
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    dialog.querySelector('#gemini-instruction-input').value = 'タイムアウトテスト';
    dialog.querySelector('.gemini-input-area button').click();
    return true;
  })()`);

  // --- #08 5: 生成中は polite、エラーは assertive のライブリージョンで通知される ---
  const politeLiveRegion = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const node = r && r.querySelector('#gemini-announcer-container [aria-live="polite"]');
    return node ? node.textContent : '';
  })()`);
  results.steps.liveRegionAnnouncesGeneration =
    typeof politeLiveRegion === 'string' && politeLiveRegion.includes('生成中');

  const timeoutErrorText = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const errDialog = r && r.getElementById('gemini-error-dialog');
      if (!errDialog) return null;
      const desc = errDialog.querySelector('.gemini-dialog-description');
      return desc ? desc.textContent : null;
    })()`),
    { label: 'timeout error dialog' }
  );
  const assertiveLiveRegion = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const node = r && r.querySelector('#gemini-announcer-container [aria-live="assertive"]');
    return node ? node.textContent : '';
  })()`);
  results.steps.liveRegionAnnouncesError =
    typeof assertiveLiveRegion === 'string' &&
    assertiveLiveRegion.includes('エラー') &&
    assertiveLiveRegion.includes('タイムアウト');
  const chatRecoveredAfterTimeout = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const d = r.getElementById('gemini-alt-dialog');
    if (!d) return false;
    const loading = d.querySelector('.chat-bubble-loading');
    const input = d.querySelector('#gemini-instruction-input');
    const sendBtn = d.querySelector('.gemini-icon-btn.is-send');
    return !loading && Boolean(input && !input.disabled) && Boolean(sendBtn && !sendBtn.disabled);
  })()`);
  const callsAfterTimeout = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.timeoutRecoveredUi =
    Boolean(timeoutErrorText && timeoutErrorText.includes('タイムアウト')) &&
    chatRecoveredAfterTimeout === true &&
    (callsAfterTimeout - callsBeforeTimeout) === 1;
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-error-dialog button').click(); return true; })()`);
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);

  // #07-3: 5xx が続く場合は上限回数で停止し分かりやすいサーバーエラーになる
  const callsBefore5xx = callsAfterTimeout;
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { status: 503, message: 'Service Unavailable' },
      { status: 503, message: 'Service Unavailable' },
      { status: 503, message: 'Service Unavailable' }
    ];
    true;
  `);
  await triggerImageGeneration('target', '#07 5xx');
  const server5xxText = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const errDialog = r && r.getElementById('gemini-error-dialog');
      if (!errDialog) return null;
      const desc = errDialog.querySelector('.gemini-dialog-description');
      return desc ? desc.textContent : null;
    })()`),
    { label: '5xx server error dialog' }
  );
  const callsAfter5xx = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.server5xxStoppedAndExplained =
    Boolean(server5xxText && server5xxText.includes('サーバー') && server5xxText.includes('再度お試し')) &&
    (callsAfter5xx - callsBefore5xx) === 3;
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-error-dialog button').click(); return true; })()`);

  // #07-4: 401 は再試行せず即時失敗する
  const callsBefore401 = callsAfter5xx;
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { status: 401, message: 'API key not valid' }
    ];
    true;
  `);
  await triggerImageGeneration('target', '#07 401');
  const auth401Info = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const errDialog = r && r.getElementById('gemini-error-dialog');
      if (!errDialog) return null;
      const desc = errDialog.querySelector('.gemini-dialog-description')?.textContent || '';
      const hasOptionsBtn = [...errDialog.querySelectorAll('button')].some((b) => b.textContent.includes('設定を開く'));
      return { desc, hasOptionsBtn };
    })()`),
    { label: '401 error dialog' }
  );
  const callsAfter401 = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.auth401ImmediateFailure =
    Boolean(auth401Info && auth401Info.hasOptionsBtn && auth401Info.desc.includes('APIキー')) &&
    (callsAfter401 - callsBefore401) === 1;
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-error-dialog .gemini-btn-cancel').click(); return true; })()`);

  // #11-1: 状態トーストは pointer-events: none で下の要素のクリックを遮らない
  results.steps.toastDoesNotBlockClicks = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const toast = r && r.querySelector('.gemini-alt-status');
    if (!toast) return false;
    return getComputedStyle(toast).pointerEvents === 'none';
  })()`);

  // #11-2: 構造化された errorType はメッセージ文言より優先される（文言がAPIキーでもレート制限表示）
  await swClient.evaluate(`
    chrome.tabs.sendMessage(${tabId}, {
      action: 'errorAltTextGeneration',
      imageUrl: ${JSON.stringify(imageUrl)},
      errorMessage: 'APIキーが無効です',
      errorType: 'RATE_LIMIT',
      errorDetails: { type: 'RATE_LIMIT', userMessage: 'APIキーが無効です' },
      aiProvider: 'Gemini'
    }).then(() => true)
  `, { awaitPromise: true });
  const structuredErrorDialog = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const errDialog = r && r.getElementById('gemini-error-dialog');
      if (!errDialog) return null;
      return {
        title: errDialog.querySelector('.gemini-dialog-title-large')?.textContent || '',
        hasWarningStyle: errDialog.classList.contains('is-warning'),
        hasOptionsBtn: [...errDialog.querySelectorAll('button')].some((b) => b.textContent.includes('設定を開く'))
      };
    })()`),
    { label: 'structured rate-limit dialog' }
  );
  results.steps.structuredErrorTypeWinsOverWording =
    Boolean(structuredErrorDialog) &&
    structuredErrorDialog.hasWarningStyle === true &&
    structuredErrorDialog.title.includes('利用制限') &&
    structuredErrorDialog.hasOptionsBtn === false;
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-error-dialog .gemini-btn-warning')?.click(); return true; })()`);

  // #07-5: options.html の API キー検証にもタイムアウトが適用され UI が復帰する
  await swClient.evaluate(`chrome.runtime.openOptionsPage(); true;`);
  const optionsTarget = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === 'page' && t.url.includes('options.html')) || null;
  }, { label: 'options.html target', timeout: 15000 });
  const optionsClient = await cdp(optionsTarget.webSocketDebuggerUrl, 'options');
  await waitFor(
    () => optionsClient.evaluate(`Boolean(document.getElementById('saveButton') && globalThis.AltAssistantRetry)`),
    { label: 'options page ready' }
  );
  await optionsClient.evaluate(`(() => {
    globalThis.__altAssistantTimeouts = { apiKeyValidationMs: 120 };
    globalThis.fetch = () => new Promise(() => {});
    document.getElementById('geminiApiKey').value = 'smoke-timeout-key';
    document.getElementById('saveButton').click();
    return true;
  })()`);
  const optionsTimeoutState = await waitFor(
    () => optionsClient.evaluate(`(() => {
      const btn = document.getElementById('saveButton');
      const status = document.getElementById('statusMessage');
      if (!btn || !status) return null;
      if (btn.disabled || !status.textContent.includes('タイムアウト')) return null;
      return { disabled: btn.disabled, buttonText: btn.textContent, statusText: status.textContent };
    })()`),
    { label: 'options validation timeout recovery' }
  );
  results.steps.optionsValidationTimedOut = Boolean(
    optionsTimeoutState &&
    optionsTimeoutState.disabled === false &&
    optionsTimeoutState.buttonText === 'APIキーを保存' &&
    optionsTimeoutState.statusText.includes('タイムアウト')
  );

  // #10-1: 成功表示の直後に検証エラーが起きても、成功用タイマーがエラーを消さない
  await optionsClient.evaluate(`(() => {
    globalThis.__altAssistantTimeouts = { apiKeyValidationMs: 5000 };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    document.getElementById('geminiApiKey').value = 'smoke-success-key';
    document.getElementById('saveButton').click();
    return true;
  })()`);
  await waitFor(
    () => optionsClient.evaluate(`(() => {
      const status = document.getElementById('statusMessage');
      return Boolean(status && status.textContent.includes('保存されました'));
    })()`),
    { label: 'options success message' }
  );
  await optionsClient.evaluate(`(() => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'API key not valid' } })
    });
    document.getElementById('geminiApiKey').value = 'smoke-invalid-key';
    document.getElementById('saveButton').click();
    return true;
  })()`);
  await waitFor(
    () => optionsClient.evaluate(`(() => {
      const status = document.getElementById('statusMessage');
      return Boolean(status && status.textContent.includes('APIキーが無効'));
    })()`),
    { label: 'options error message after success' }
  );
  // 成功メッセージの自動非表示 (3秒) を超えても、後から出したエラーが残ること
  await sleep(OPTIONS_STATUS_RACE_WAIT_MS);
  results.steps.optionsSuccessErrorRace = await optionsClient.evaluate(`(() => {
    const status = document.getElementById('statusMessage');
    return Boolean(status && status.style.display === 'block' && status.textContent.includes('APIキーが無効'));
  })()`);

  // #10-2: 通信失敗（オフライン相当）は「APIキーが無効」ではなく通信エラーとして表示する
  await optionsClient.evaluate(`(() => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    document.getElementById('geminiApiKey').value = 'smoke-offline-key';
    document.getElementById('saveButton').click();
    return true;
  })()`);
  const optionsOfflineState = await waitFor(
    () => optionsClient.evaluate(`(() => {
      const status = document.getElementById('statusMessage');
      const btn = document.getElementById('saveButton');
      if (!status || !btn) return null;
      if (btn.disabled || !status.textContent.includes('ネットワークエラー')) return null;
      return { statusText: status.textContent, disabled: btn.disabled };
    })()`),
    { label: 'options offline network error' }
  );
  results.steps.optionsOfflineNetworkError = Boolean(
    optionsOfflineState &&
    optionsOfflineState.disabled === false &&
    optionsOfflineState.statusText.includes('ネットワークエラー') &&
    !optionsOfflineState.statusText.includes('APIキーが無効')
  );
  optionsClient.ws.close();

  // --- #08 6: 復帰先の画像がDOMから消えても、代替要素へフォーカスを戻す ---
  await pageClient.evaluate(`(() => {
    const img = document.getElementById('target');
    img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  await sendAltResult('フォールバック確認用', imageUrl2);
  await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      return Boolean(dialog && dialog.dataset.imageSrc === ${JSON.stringify(imageUrl2)});
    })()`),
    { label: 'chat dialog for detached-image fallback' }
  );
  await pageClient.evaluate(`(() => { document.getElementById('target-2').remove(); return true; })()`);
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);
  results.steps.focusFallbackWhenImageDetached = await waitFor(
    () => pageClient.evaluate(`(() => {
      const target = document.getElementById('target');
      return Boolean(target && document.activeElement === target);
    })()`),
    { label: 'focus fallback when image is detached' }
  );

  // --- #09: 空白入力拒否・英語指定プロンプト・空履歴 Regeneration ---
  const callsBefore09 = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  await pageClient.evaluate(`(() => {
    const img = document.getElementById('target');
    img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  await swClient.evaluate(`startGenerationProcess(${JSON.stringify(imageUrl)}, ${tabId}, 0, 'target'); 'started-09'`);
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-instruction-dialog'); })()`),
    { label: 'instruction dialog for #09' }
  );
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const ta = r.getElementById('gemini-prompt-textarea');
    ta.value = '   \\t\\n  ';
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  const blankInstructionState = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-instruction-dialog');
    const ta = r.getElementById('gemini-prompt-textarea');
    const err = r.getElementById('gemini-instruction-error');
    return {
      dialogOpen: Boolean(dialog),
      ariaInvalid: ta?.getAttribute('aria-invalid'),
      errorHidden: err?.hidden,
      errorText: err?.textContent || ''
    };
  })()`);
  const callsAfterBlankInstruction = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.blankInstructionRejected =
    blankInstructionState.dialogOpen === true &&
    blankInstructionState.ariaInvalid === 'true' &&
    blankInstructionState.errorHidden === false &&
    blankInstructionState.errorText.length > 0 &&
    callsAfterBlankInstruction === callsBefore09;

  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const ta = r.getElementById('gemini-prompt-textarea');
    ta.value = '画像を日本語で説明';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    r.getElementById('submit-auto-model').click();
    return true;
  })()`);
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !!r.getElementById('gemini-alt-dialog'); })()`),
    { label: 'alt dialog opened for #09' }
  );

  // チャット欄での空白入力拒否
  const callsBeforeBlankChat = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    const input = dialog.querySelector('#gemini-instruction-input');
    input.value = '   ';
    dialog.querySelector('.gemini-icon-btn.is-send').click();
    return true;
  })()`);
  const blankChatState = await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const input = r.getElementById('gemini-instruction-input');
    const err = r.getElementById('gemini-chat-input-error');
    return {
      ariaInvalid: input?.getAttribute('aria-invalid'),
      errorHidden: err?.hidden,
      errorText: err?.textContent || ''
    };
  })()`);
  const callsAfterBlankChat = await swClient.evaluate('globalThis.__smoke.geminiCalls');
  results.steps.blankChatInputRejected =
    blankChatState.ariaInvalid === 'true' &&
    blankChatState.errorHidden === false &&
    blankChatState.errorText.length > 0 &&
    callsAfterBlankChat === callsBeforeBlankChat;

  // 「英語で」再生成で英語プロンプトが送られ英語が返る
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { status: 200, body: { candidates: [{ content: { parts: [{ text: 'A blue square graphic' }] } }] } }
    ];
    true;
  `);
  await pageClient.evaluate(`(() => {
    const r = ${shadow};
    const dialog = r.getElementById('gemini-alt-dialog');
    const input = dialog.querySelector('#gemini-instruction-input');
    input.value = '英語で';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector('.gemini-icon-btn.is-send').click();
    return true;
  })()`);
  const englishAlt = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length >= 2 ? areas[areas.length - 1].value : null;
    })()`),
    { label: 'english alt text after regeneration' }
  );
  const lastPrompt09 = await swClient.evaluate('globalThis.__smoke.lastGeminiPrompt');
  results.steps.englishRegenerationPrompt =
    englishAlt === 'A blue square graphic' &&
    typeof lastPrompt09 === 'string' &&
    lastPrompt09.includes('Output in English.') &&
    !lastPrompt09.includes('Output in Japanese');

  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn').click(); return true; })()`);
  await waitFor(
    () => pageClient.evaluate(`(() => { const r = ${shadow}; return !r.getElementById('gemini-alt-dialog'); })()`),
    { label: 'alt dialog closed before empty-history regeneration test' }
  );

  // 履歴が空文字でも Regeneration が初回扱いにならず showInstructionDialog を開かない
  await swClient.evaluate(`
    globalThis.__smoke.geminiScriptedResponses = [
      { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Empty history regen result' }] } }] } }
    ];
    startGenerationProcess(${JSON.stringify(imageUrl)}, ${tabId}, 0, 'target', {
      history: '',
      additionalInstruction: '英語で',
      requestId: 'smoke-empty-history-req'
    });
    'started-empty-history'
  `);
  const emptyHistoryAlt = await waitFor(
    () => pageClient.evaluate(`(() => {
      const r = ${shadow};
      if (r && r.getElementById('gemini-instruction-dialog')) return '__UNEXPECTED_INSTRUCTION__';
      const dialog = r && r.getElementById('gemini-alt-dialog');
      const areas = dialog ? [...dialog.querySelectorAll('.chat-bubble-ai textarea')] : [];
      return areas.length ? areas[areas.length - 1].value : null;
    })()`),
    { label: 'empty-history regeneration alt dialog' }
  );
  results.steps.emptyHistoryRegenerationSucceeded = emptyHistoryAlt === 'Empty history regen result';
  await pageClient.evaluate(`(() => { const r = ${shadow}; r.querySelector('#gemini-alt-dialog .gemini-close-btn')?.click(); return true; })()`);

  results.steps.totalGeminiCalls = await swClient.evaluate('globalThis.__smoke.geminiCalls');

  if (results.steps.stackedEscapeClosedTopOnly !== true) {
    results.errors.push('Escape closed more than the topmost dialog');
  }
  if (results.steps.focusRestoredToInstruction !== true) {
    results.errors.push('focus was not restored to the underlying instruction dialog');
  }
  if (results.steps.tabCycledInDialog !== true) {
    results.errors.push('Tab key did not cycle focus back to the first focusable element inside the dialog');
  }
  if (results.steps.aiTextFocusRingVisible !== true) {
    results.errors.push('AI text did not show a visible keyboard focus ring');
  }
  if (results.steps.modalBackdropBlocksBackground !== true) {
    results.errors.push('modal backdrop did not block background interaction or was not removed after close');
  }
  if (results.steps.focusRestoredToImage !== true) {
    results.errors.push('focus was not restored to the image with a visible ring');
  }
  if (results.steps.focusFallbackWhenImageDetached !== true) {
    results.errors.push('focus did not fall back to an alternative when the image was detached');
  }
  if (results.steps.liveRegionAnnouncesGeneration !== true) {
    results.errors.push('generation state was not announced in the polite live region');
  }
  if (results.steps.liveRegionAnnouncesError !== true) {
    results.errors.push('error state was not announced in the assertive live region');
  }
  if (results.steps.toastDoesNotBlockClicks !== true) {
    results.errors.push('status toast intercepted pointer events instead of letting clicks through');
  }
  if (results.steps.structuredErrorTypeWinsOverWording !== true) {
    results.errors.push('structured error type did not win over error message wording');
  }
  if (results.steps.supersededInstructionCancelled !== true) {
    results.errors.push('superseded instruction request was not cancelled (possible hang)');
  }
  if (results.steps.singleInstructionDialog !== true) {
    results.errors.push('more than one instruction dialog remained open');
  }
  if (results.steps.lateResultSuppressed !== true) {
    results.errors.push('late result reopened a closed chat dialog');
  }
  if (results.steps.lateResultSuppressionConsumed !== true) {
    results.errors.push('result after a suppressed one was not delivered');
  }
  if (results.steps.replacedImageResultDelivered !== true) {
    results.errors.push('replacing chat dialog marked the replaced image closed and dropped its next result');
  }
  if (results.steps.sameUrlSecondImageTargeted !== true) {
    results.errors.push('same-URL second image was not targeted consistently across status, dialog, and regeneration');
  }
  if (results.steps.srcsetUsedCurrentSrc !== true) {
    results.errors.push('srcset image did not use displayed currentSrc as generation target');
  }
  if (results.steps.quotedUrlHandledSafely !== true) {
    results.errors.push('quoted URL broke status badge or alt dialog handling');
  }
  if (results.steps.regenerationReusedImageCache !== true) {
    results.errors.push('regeneration re-fetched the image instead of reusing cached image data');
  }
  if (results.steps.svgImageGenerated !== true) {
    results.errors.push('SVG image did not complete alt text generation');
  }
  if (results.steps.blobImageGenerated !== true) {
    results.errors.push('blob: image did not complete alt text generation');
  }
  if (results.steps.unsupportedGifRejected !== true) {
    results.errors.push('unsupported GIF image did not show a clear unsupported-format error');
  }
  if (results.steps.retry429Succeeded !== true) {
    results.errors.push('429 -> 200 retry did not succeed');
  }
  if (results.steps.timeoutRecoveredUi !== true) {
    results.errors.push('timeout did not show timeout error or recover chat UI');
  }
  if (results.steps.server5xxStoppedAndExplained !== true) {
    results.errors.push('5xx persisting did not stop at maxRetries with clear server error');
  }
  if (results.steps.auth401ImmediateFailure !== true) {
    results.errors.push('401 error was retried or did not show API key error dialog');
  }
  if (results.steps.optionsValidationTimedOut !== true) {
    results.errors.push('options API key validation did not timeout and recover saveButton');
  }
  if (results.steps.optionsSuccessErrorRace !== true) {
    results.errors.push('success message auto-hide timer erased a later validation error');
  }
  if (results.steps.optionsOfflineNetworkError !== true) {
    results.errors.push('offline validation was not shown as a network error');
  }
  if (results.steps.blankInstructionRejected !== true) {
    results.errors.push('blank instruction was not rejected with visible reason');
  }
  if (results.steps.blankChatInputRejected !== true) {
    results.errors.push('blank chat regeneration input was not rejected with visible reason');
  }
  if (results.steps.englishRegenerationPrompt !== true) {
    results.errors.push('regeneration with 英語で did not produce English output directive without Japanese override');
  }
  if (results.steps.emptyHistoryRegenerationSucceeded !== true) {
    results.errors.push('regeneration with empty history fell back to initial instruction dialog or failed');
  }

  if (results.steps.firstAltText !== 'スモークテスト用の代替テキスト') {
    results.errors.push(`unexpected first alt text: ${results.steps.firstAltText}`);
  }
  if (results.steps.regeneratedAltText !== '再生成後の代替テキスト') {
    results.errors.push(`unexpected regenerated alt text: ${results.steps.regeneratedAltText}`);
  }
  if (results.steps.geminiCalls !== 2) {
    results.errors.push(`expected 2 Gemini calls, got ${results.steps.geminiCalls}`);
  }
  if (results.steps.totalGeminiCalls !== EXPECTED_TOTAL_GEMINI_CALLS) {
    results.errors.push(`expected ${EXPECTED_TOTAL_GEMINI_CALLS} total Gemini calls, got ${results.steps.totalGeminiCalls}`);
  }
  if (results.steps.appliedAlt !== '再生成後の代替テキスト') {
    results.errors.push(`unexpected applied alt: ${results.steps.appliedAlt}`);
  }
  if (!results.steps.regenerationDialogClosed) {
    results.errors.push('chat dialog stayed open after applying alt text');
  }

  results.steps.promptParseErrors = await swClient.evaluate('globalThis.__smoke.promptParseErrors || 0');
  if (results.steps.promptParseErrors > 0) {
    results.errors.push(`failed to parse ${results.steps.promptParseErrors} Gemini request bodies`);
  }

  const swProblems = swClient.events.filter((e) => e.type === 'exception' || e.type === 'error');
  if (swProblems.length) results.errors.push(...swProblems.map((e) => `SW ${e.type}: ${e.detail}`));
  results.swConsole = swClient.events.slice(-20);

  pageClient.ws.close();
  swClient.ws.close();
} catch (err) {
  results.errors.push(err.message);
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  imageServer.close();
}

results.pass = results.loaded && results.errors.length === 0;
if (!results.pass) {
  results.chromeStderrTail = chromeStderr.slice(-3000);
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
