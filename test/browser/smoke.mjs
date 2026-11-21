// Baseline smoke test: loads the unpacked extension in Edge (Chromium),
// stubs the Gemini endpoint, and drives Instruction -> generation -> regeneration
// on a top-level <img>. No real API key or network access to Google is used.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const edgePath = process.argv[2];
const rawExtPath = process.argv[3];
if (!edgePath || !rawExtPath) {
  console.error('usage: node test/browser/smoke.mjs <edge.exe> <extension-dir>');
  process.exit(2);
}
const extPath = path.resolve(rawExtPath);

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
</body></html>`;

const imageServer = http.createServer((req, res) => {
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
    globalThis.__smoke = { geminiCalls: 0, fetchedImageUrls: [] };
    const __realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('generativelanguage.googleapis.com')) {
        globalThis.__smoke.geminiCalls += 1;
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

  if (results.steps.firstAltText !== 'スモークテスト用の代替テキスト') {
    results.errors.push(`unexpected first alt text: ${results.steps.firstAltText}`);
  }
  if (results.steps.regeneratedAltText !== '再生成後の代替テキスト') {
    results.errors.push(`unexpected regenerated alt text: ${results.steps.regeneratedAltText}`);
  }
  if (results.steps.geminiCalls !== 2) {
    results.errors.push(`expected 2 Gemini calls, got ${results.steps.geminiCalls}`);
  }
  if (results.steps.totalGeminiCalls !== 5) {
    results.errors.push(`expected 5 total Gemini calls, got ${results.steps.totalGeminiCalls}`);
  }
  if (results.steps.appliedAlt !== '再生成後の代替テキスト') {
    results.errors.push(`unexpected applied alt: ${results.steps.appliedAlt}`);
  }
  if (!results.steps.regenerationDialogClosed) {
    results.errors.push('chat dialog stayed open after applying alt text');
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
