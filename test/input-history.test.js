// test/input-history.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    MAX_HISTORY_ENTRIES,
    MAX_HISTORY_CHARS,
    validateInstruction,
    buildBoundedHistory,
    clampHistoryString,
    isRegenerationContext,
    resolveTargetLanguage,
    createInitialPrompt,
    createRegenerationPrompt
} = require('../utils/input-history.js');

function loadBackgroundPromptHarness(overrides = {}) {
    const rootDir = process.cwd();
    const sentMessages = [];
    const geminiBodies = [];
    let showInstructionCalls = 0;

    const noopEvent = () => ({ addListener: () => {} });
    const mockConsole = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    const sandbox = {
        console: mockConsole,
        setTimeout,
        clearTimeout,
        URL,
        Blob,
        Response,
        Headers,
        AbortController,
        atob: globalThis.atob,
        btoa: globalThis.btoa,
        createImageBitmap: async () => ({ width: 64, height: 64, close: () => {} }),
        __altAssistantTimeouts: { imageFetchMs: 100, geminiApiMs: 100 },
        __altAssistantRetryOverrides: { maxRetries: 0, baseDelay: 1, maxDelay: 1, jitter: false },
        fetch: async (url, init) => {
            if (url.includes('generativelanguage.googleapis.com')) {
                const parsed = JSON.parse(init.body);
                geminiBodies.push(parsed);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ content: { parts: [{ text: 'A blue sky over calm ocean' }] } }]
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'image/png' }),
                blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
            };
        },
        chrome: {
            runtime: {
                onInstalled: noopEvent(),
                onStartup: noopEvent(),
                onMessage: noopEvent(),
                openOptionsPage: () => {}
            },
            storage: {
                local: { get: async () => ({ geminiApiKey: 'test-key' }), remove: async () => {} },
                sync: { remove: async () => {} },
                onChanged: noopEvent()
            },
            contextMenus: {
                create: () => {},
                update: () => {},
                removeAll: (cb) => cb && cb(),
                onClicked: noopEvent()
            },
            commands: { onCommand: noopEvent() },
            scripting: { executeScript: async () => [] },
            tabs: {
                query: async () => [],
                sendMessage: async (tabId, message, options) => {
                    sentMessages.push({ tabId, message, options });
                    if (message.action === 'ping') return { status: 'ok', pong: true };
                    if (message.action === 'showInstructionDialog') {
                        showInstructionCalls += 1;
                        return { prompt: overrides.instructionPrompt ?? '初回指示' };
                    }
                    return { ok: true };
                }
            }
        }
    };

    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.importScripts = (...relPaths) => {
        for (const relPath of relPaths) {
            const code = fs.readFileSync(path.resolve(rootDir, relPath), 'utf8');
            vm.runInContext(code, context, { filename: relPath });
        }
    };

    const context = vm.createContext(sandbox);
    const bgCode = fs.readFileSync(path.resolve(rootDir, 'background.js'), 'utf8');
    vm.runInContext(bgCode, context, { filename: 'background.js' });

    return {
        context,
        sentMessages,
        geminiBodies,
        getShowInstructionCalls: () => showInstructionCalls
    };
}

describe('シームA: validateInstruction (空・空白のみの Instruction 拒否)', () => {
    it('空文字・空白・タブ・改行のみの入力を拒否し、理由メッセージを返すこと', () => {
        for (const emptyInput of ['', '   ', '\t\n  ', null, undefined]) {
            const result = validateInstruction(emptyInput);
            assert.equal(result.valid, false, `入力 ${JSON.stringify(emptyInput)} は拒否されること`);
            assert.equal(result.value, '');
            assert.equal(typeof result.error, 'string');
            assert.ok(result.error.length > 0, '拒否理由のメッセージが返ること');
        }
    });

    it('有効な指示は前後の空白を除去して許可すること', () => {
        const result = validateInstruction('  この画像を英語で説明して  ');
        assert.deepEqual(result, {
            valid: true,
            value: 'この画像を英語で説明して'
        });
    });
});

describe('シームB: 会話履歴の境界管理 (MAX_HISTORY_ENTRIES / MAX_HISTORY_CHARS)', () => {
    it('上限値定数 MAX_HISTORY_ENTRIES と MAX_HISTORY_CHARS が正の整数として公開されていること', () => {
        assert.equal(Number.isInteger(MAX_HISTORY_ENTRIES) && MAX_HISTORY_ENTRIES > 0, true);
        assert.equal(Number.isInteger(MAX_HISTORY_CHARS) && MAX_HISTORY_CHARS > 0, true);
    });

    it('発話数が上限を超える場合、古い履歴を落として最新のやり取りを維持すること', () => {
        const entries = [];
        for (let i = 1; i <= MAX_HISTORY_ENTRIES + 6; i += 1) {
            entries.push({
                role: i % 2 === 1 ? 'user' : 'ai',
                text: `メッセージ番号${i}`
            });
        }

        const result = buildBoundedHistory(entries);
        const lines = result.split('\n').filter(Boolean);

        assert.equal(lines.length, MAX_HISTORY_ENTRIES);
        assert.equal(result.includes('メッセージ番号1\n'), false, '最古のメッセージは含まれないこと');
        assert.equal(result.includes(`メッセージ番号${MAX_HISTORY_ENTRIES + 6}`), true, '最新のメッセージは保持されること');
    });

    it('文字数上限を超える場合、合計文字数が MAX_HISTORY_CHARS 以内に収まること', () => {
        const entries = Array.from({ length: 8 }, (_, idx) => ({
            role: idx % 2 === 0 ? 'user' : 'ai',
            text: `turn-${idx}-` + 'あ'.repeat(500)
        }));

        const result = buildBoundedHistory(entries);
        assert.ok(result.length <= MAX_HISTORY_CHARS, `履歴長 ${result.length} が上限 ${MAX_HISTORY_CHARS} 以下であること`);
        assert.equal(result.includes('turn-7-'), true, '最新のターンが保持されること');
        assert.equal(result.includes('turn-0-'), false, '古いターンが落とされること');
    });

    it('単一の最新エントリだけで MAX_HISTORY_CHARS を超える場合も上限内に切り詰めること', () => {
        const result = buildBoundedHistory([
            { role: 'ai', text: 'x'.repeat(MAX_HISTORY_CHARS + 500) }
        ]);

        assert.ok(result.length <= MAX_HISTORY_CHARS);
        assert.equal(result.endsWith('…'), true);
    });

    it('clampHistoryString は長い生テキスト履歴も最新の行を残して上限内に収めること', () => {
        const rawLines = Array.from({ length: 30 }, (_, idx) => `- PREVIOUS_USER_REQUEST: line-${idx}-` + 'a'.repeat(180));
        const clamped = clampHistoryString(rawLines.join('\n'));

        assert.ok(clamped.length <= MAX_HISTORY_CHARS);
        assert.equal(clamped.includes('line-29-'), true);
        assert.equal(clamped.includes('line-0-'), false);
    });
});

describe('シームC: isRegenerationContext (空履歴でも初回扱いしない再生成判定)', () => {
    it('history が空文字でも Regeneration コンテキストと判定すること', () => {
        assert.equal(isRegenerationContext({ history: '', additionalInstruction: '英語で' }), true);
        assert.equal(isRegenerationContext({ history: '', isRegeneration: true }), true);
    });

    it('history も additionalInstruction も isRegeneration もない場合は初回と判定すること', () => {
        assert.equal(isRegenerationContext({}), false);
        assert.equal(isRegenerationContext({ requestId: 'req-1' }), false);
        assert.equal(isRegenerationContext(null), false);
        assert.equal(isRegenerationContext(undefined), false);
    });
});

describe('シームD: resolveTargetLanguage と createRegenerationPrompt (言語追従と履歴上限)', () => {
    it('「英語で」と指示された場合、英語出力を指示し Output in Japanese を含めないこと', () => {
        const prompt = createRegenerationPrompt({
            history: '- PREVIOUS_AI_RESPONSE: 青い空と白い雲の写真',
            additionalInstruction: '英語で'
        });

        assert.equal(prompt.includes('Output in English.'), true);
        assert.equal(prompt.includes('Output in Japanese'), false);
        assert.equal(prompt.includes('英語で'), true);
    });

    it('「in English」や「フランス語で」など他の言語指定にも追従すること', () => {
        const enPrompt = createRegenerationPrompt({
            history: '- PREVIOUS_AI_RESPONSE: 海岸の写真',
            additionalInstruction: 'Describe it concisely in English'
        });
        assert.equal(enPrompt.includes('Output in English.'), true);
        assert.equal(enPrompt.includes('Output in Japanese'), false);

        const frPrompt = createRegenerationPrompt({
            history: '- PREVIOUS_AI_RESPONSE: 海岸の写真',
            additionalInstruction: 'フランス語でお願いします'
        });
        assert.equal(frPrompt.includes('Output in French.'), true);
        assert.equal(frPrompt.includes('Output in Japanese'), false);

        const ptPrompt = createRegenerationPrompt({
            history: '- PREVIOUS_AI_RESPONSE: 海岸の写真',
            additionalInstruction: 'ポルトガル語で書いて'
        });
        assert.equal(ptPrompt.includes('ポルトガル語'), true);
        assert.equal(ptPrompt.includes('Output in Japanese'), false);
    });

    it('直前のユーザー指示が「英語で」だった場合、次の「もっと短く」でも英語を維持し、「日本語で」で日本語へ戻すこと', () => {
        const historyWithEnglish = [
            '- PREVIOUS_USER_REQUEST: 日本語で説明して',
            '- PREVIOUS_AI_RESPONSE: 青い海',
            '- PREVIOUS_USER_REQUEST: 英語で',
            '- PREVIOUS_AI_RESPONSE: A blue ocean'
        ].join('\n');

        assert.equal(resolveTargetLanguage('もっと短く', historyWithEnglish), 'English');
        const followUpPrompt = createRegenerationPrompt({
            history: historyWithEnglish,
            additionalInstruction: 'もっと短く'
        });
        assert.equal(followUpPrompt.includes('Output in English.'), true);
        assert.equal(followUpPrompt.includes('Output in Japanese'), false);

        assert.equal(resolveTargetLanguage('日本語でお願いします', historyWithEnglish), 'Japanese');
        const backToJaPrompt = createRegenerationPrompt({
            history: historyWithEnglish,
            additionalInstruction: '日本語でお願いします'
        });
        assert.equal(backToJaPrompt.includes('Output in Japanese.'), true);
    });

    it('対象物としての「英語の看板」への言及は出力言語切り替えと誤判定しないこと', () => {
        assert.equal(resolveTargetLanguage('英語の看板の文字も含めて説明して', ''), null);
        const prompt = createRegenerationPrompt({
            history: '',
            additionalInstruction: '英語の看板の文字も含めて説明して'
        });
        assert.equal(prompt.includes('Output in Japanese.'), true);
    });

    it('複数言語が言及された場合は、より後ろで言及された言語（最終指示）を採用すること', () => {
        assert.equal(resolveTargetLanguage('英語の看板を日本語で説明して', ''), 'Japanese');
        assert.equal(resolveTargetLanguage('英語で書かれた看板を日本語で説明して', ''), 'Japanese');
        assert.equal(resolveTargetLanguage('日本語で書かれた本を英語で説明して', ''), 'English');
    });

    it('「3語」「単語」「in Detail」のような非言語表現を言語指定と誤判定しないこと', () => {
        assert.equal(resolveTargetLanguage('3語で説明して', ''), null);
        assert.equal(resolveTargetLanguage('単語で説明して', ''), null);
        assert.equal(resolveTargetLanguage('describe it in Detail', ''), null);
    });

    it('表にない言語名（タイ語など）にも追従すること', () => {
        assert.equal(resolveTargetLanguage('タイ語で説明して', ''), 'タイ語');
        assert.equal(resolveTargetLanguage('describe it in Thai', ''), 'Thai');
    });

    it('createInitialPrompt は言語指定に追従し、未指定なら日本語を指示すること', () => {
        const enPrompt = createInitialPrompt('この画像を英語で説明して');
        assert.equal(enPrompt.includes('# USER_INSTRUCTION\nこの画像を英語で説明して'), true);
        assert.equal(enPrompt.includes('Output in English.'), true);
        assert.equal(enPrompt.includes('Output in Japanese'), false);

        const jaPrompt = createInitialPrompt('この画像を説明して');
        assert.equal(jaPrompt.includes('Output in Japanese.'), true);
        assert.equal(jaPrompt.includes('Output in English'), false);
    });

    it('history が空文字の場合も undefined を出さず整形されたプロンプトを返すこと', () => {
        const prompt = createRegenerationPrompt({
            history: '',
            additionalInstruction: 'もっと短く'
        });

        assert.equal(prompt.includes('undefined'), false);
        assert.equal(prompt.includes('# CONVERSATION_LOG\n(none)'), true);
        assert.equal(prompt.includes('# CURRENT_USER_REQUEST\nもっと短く'), true);
    });

    it('長い history を渡しても createRegenerationPrompt 内の CONVERSATION_LOG が MAX_HISTORY_CHARS 以内に収まること', () => {
        const longHistory = Array.from({ length: 20 }, (_, i) => `- PREVIOUS_AI_RESPONSE: entry-${i}-` + 'あ'.repeat(300)).join('\n');
        const prompt = createRegenerationPrompt({
            history: longHistory,
            additionalInstruction: '短くして'
        });

        const logMatch = prompt.match(/# CONVERSATION_LOG\n([\s\S]*?)\n\n# CURRENT_USER_REQUEST/);
        assert.ok(logMatch, 'CONVERSATION_LOG セクションが存在すること');
        assert.ok(logMatch[1].length <= MAX_HISTORY_CHARS, `CONVERSATION_LOG の長さ ${logMatch[1].length} が ${MAX_HISTORY_CHARS} 以下であること`);
        assert.equal(logMatch[1].includes('entry-19-'), true);
        assert.equal(logMatch[1].includes('entry-0-'), false);
    });
});

describe('シームE: background.js 統合 (空履歴での Regeneration と英語指定プロンプト)', () => {
    it('history が空文字の Regeneration でも showInstructionDialog を開かず、英語指定プロンプトで生成すること', async () => {
        const harness = loadBackgroundPromptHarness();

        await harness.context.startGenerationProcess(
            'https://example.com/sample.png',
            1,
            0,
            'img-1',
            {
                history: '',
                additionalInstruction: '英語で',
                requestId: 'req-empty-history'
            }
        );

        assert.equal(harness.getShowInstructionCalls(), 0, '空履歴でも初回ダイアログを開かないこと');
        assert.equal(harness.geminiBodies.length, 1, 'Gemini API が 1 回呼ばれること');

        const sentPrompt = harness.geminiBodies[0].contents[0].parts[0].text;
        assert.equal(sentPrompt.includes('Output in English.'), true);
        assert.equal(sentPrompt.includes('Output in Japanese'), false);

        const updateMsg = harness.sentMessages.find((m) => m.message.action === 'updateAltText');
        assert.ok(updateMsg, 'updateAltText が送信されること');
        assert.equal(updateMsg.message.altText, 'A blue sky over calm ocean');
    });

    it('Regeneration で空白のみの additionalInstruction が渡された場合、Gemini API を呼ばずエラー通知すること', async () => {
        const harness = loadBackgroundPromptHarness();

        await harness.context.startGenerationProcess(
            'https://example.com/sample.png',
            1,
            0,
            'img-1',
            {
                history: '- PREVIOUS_AI_RESPONSE: 青い空',
                additionalInstruction: '   \t\n ',
                isRegeneration: true,
                requestId: 'req-blank-regen'
            }
        );

        assert.equal(harness.geminiBodies.length, 0, '空白のみの指示では Gemini API を呼ばないこと');
        const errMsg = harness.sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errMsg, 'errorAltTextGeneration が送信されること');
    });

    it('初回 Instruction で「英語で」と指示した場合も、英語出力プロンプトを送ること', async () => {
        const harness = loadBackgroundPromptHarness({ instructionPrompt: 'この画像を英語で説明して' });

        await harness.context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(harness.getShowInstructionCalls(), 1, '初回は指示ダイアログを開くこと');
        assert.equal(harness.geminiBodies.length, 1, 'Gemini API が 1 回呼ばれること');

        const sentPrompt = harness.geminiBodies[0].contents[0].parts[0].text;
        assert.equal(sentPrompt.includes('この画像を英語で説明して'), true, 'ユーザー指示がそのまま含まれること');
        assert.equal(sentPrompt.includes('Output in English.'), true);
        assert.equal(sentPrompt.includes('Output in Japanese'), false);
    });

    it('初回 Instruction が空白のみの場合、Gemini API を呼ばず理由付きでエラー通知すること', async () => {
        const harness = loadBackgroundPromptHarness({ instructionPrompt: '   ' });

        await harness.context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(harness.geminiBodies.length, 0, '空白のみの指示では Gemini API を呼ばないこと');
        const errMsg = harness.sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errMsg, 'errorAltTextGeneration が送信されること');
        assert.ok(errMsg.message.errorMessage.length > 0, '拒否理由が表示されること');
    });
});
