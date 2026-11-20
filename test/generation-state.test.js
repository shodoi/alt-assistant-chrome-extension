// test/generation-state.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    beginChatGeneration,
    endChatGeneration,
    buildModelAwareErrorMessage,
    sendMessageSafely
} = require('../utils/generation-state.js');

/**
 * チャットダイアログの軽量モック。
 * content.js が使用するセレクタと同じものだけを解決する。
 */
function createMockDialog({ hasLoadingBubble = true } = {}) {
    const input = { disabled: false };
    const sendButton = { disabled: false };
    const applyButton = { disabled: false };
    const copyButton = { disabled: false };
    const row = {
        removed: false,
        remove() {
            this.removed = true;
        }
    };
    const bubble = {
        removed: false,
        closest(selector) {
            return selector === '.gemini-chat-row' ? row : null;
        },
        remove() {
            this.removed = true;
        }
    };

    const dialog = {
        querySelector(selector) {
            if (selector === '#gemini-instruction-input') return input;
            if (selector === '.gemini-icon-btn.is-send') return sendButton;
            if (selector === '.chat-bubble-loading') return hasLoadingBubble ? bubble : null;
            return null;
        }
    };

    return { dialog, input, sendButton, applyButton, copyButton, row, bubble };
}

describe('シームS1: チャット生成ライフサイクル (beginChatGeneration / endChatGeneration)', () => {
    it('生成開始時は送信入力と送信ボタンだけを無効化し、コピー・適用ボタンは有効のままにすること', () => {
        const { dialog, input, sendButton, applyButton, copyButton } = createMockDialog();

        beginChatGeneration(dialog);

        assert.equal(input.disabled, true, '入力欄は無効化されること');
        assert.equal(sendButton.disabled, true, '送信ボタンは無効化されること');
        assert.equal(applyButton.disabled, false, '適用ボタンは無効化されないこと');
        assert.equal(copyButton.disabled, false, 'コピーボタンは有効のままであること');
    });

    it('生成終了時にローディング行を取り除き、入力欄と送信ボタンを再度有効化すること', () => {
        const { dialog, input, sendButton, row, bubble } = createMockDialog();

        beginChatGeneration(dialog);
        endChatGeneration(dialog);

        assert.equal(row.removed, true, 'ローディング行が削除されること');
        assert.equal(bubble.removed, false, '行がある場合は行単位で削除すること');
        assert.equal(input.disabled, false, '入力欄が再開すること');
        assert.equal(sendButton.disabled, false, '送信ボタンが再開すること');
    });

    it('ローディング行が存在しない場合でも入力欄と送信ボタンを再開できること (エラー復帰)', () => {
        const { dialog, input, sendButton } = createMockDialog({ hasLoadingBubble: false });

        beginChatGeneration(dialog);
        endChatGeneration(dialog);

        assert.equal(input.disabled, false);
        assert.equal(sendButton.disabled, false);
    });

    it('endChatGeneration を繰り返し呼んでも例外にならないこと (冪等性)', () => {
        const { dialog } = createMockDialog();

        assert.doesNotThrow(() => {
            endChatGeneration(dialog);
            endChatGeneration(dialog);
        });
    });

    it('ダイアログが null / undefined / DOM 非対応でも例外にならないこと', () => {
        assert.doesNotThrow(() => beginChatGeneration(null));
        assert.doesNotThrow(() => beginChatGeneration(undefined));
        assert.doesNotThrow(() => endChatGeneration(null));
        assert.doesNotThrow(() => endChatGeneration({}));
    });
});

describe('シームS2: エラー表示のモデル名 (buildModelAwareErrorMessage)', () => {
    it('モデル名がメッセージに含まれていなければ使用モデルとして付与すること', () => {
        const message = buildModelAwareErrorMessage(
            'Gemini API の利用制限に達しました。',
            'Gemini 4 Hydrogen'
        );

        assert.equal(
            message,
            'Gemini API の利用制限に達しました。（使用モデル: Gemini 4 Hydrogen）'
        );
    });

    it('すでにモデル名を含むメッセージには重複付与しないこと', () => {
        const original = 'Gemini 4 Hydrogen のAPIキーが無効です。';

        assert.equal(
            buildModelAwareErrorMessage(original, 'Gemini 4 Hydrogen'),
            original
        );
    });

    it('モデル名が空の場合はメッセージを変更しないこと', () => {
        const original = 'エラーが発生しました。';

        assert.equal(buildModelAwareErrorMessage(original, ''), original);
        assert.equal(buildModelAwareErrorMessage(original, undefined), original);
    });

    it('メッセージが空の場合はモデル名だけの案内を返すこと', () => {
        assert.equal(
            buildModelAwareErrorMessage('', 'Gemini 4 Hydrogen'),
            '（使用モデル: Gemini 4 Hydrogen）'
        );
    });

    it('前後の空白を正規化すること', () => {
        assert.equal(
            buildModelAwareErrorMessage('  エラーです  ', '  Gemini 4 Hydrogen  '),
            'エラーです（使用モデル: Gemini 4 Hydrogen）'
        );
    });
});

describe('シームS3: メッセージ送信の安全化 (sendMessageSafely)', () => {
    it('送信が成功した場合は { ok: true, response } を返すこと', async () => {
        const result = await sendMessageSafely(async (tabId, message) => {
            assert.equal(tabId, 7);
            assert.deepEqual(message, { action: 'ping' });
            return { pong: true };
        }, 7, { action: 'ping' });

        assert.equal(result.ok, true);
        assert.deepEqual(result.response, { pong: true });
    });

    it('送信 Promise が拒否されても例外を投げず { ok: false } を返すこと (未処理の拒否防止)', async () => {
        const sendError = new Error('Could not establish connection. Receiving end does not exist.');

        const result = await sendMessageSafely(async () => {
            throw sendError;
        }, 1, { action: 'regenerate_with_context' });

        assert.equal(result.ok, false);
        assert.equal(result.error, sendError);
    });

    it('送信関数が同期的に例外を投げても { ok: false } を返すこと', async () => {
        const result = await sendMessageSafely(() => {
            throw new Error('Extension context invalidated.');
        });

        assert.equal(result.ok, false);
        assert.ok(result.error instanceof Error);
    });

    it('送信関数が渡されていない場合も { ok: false } を返すこと', async () => {
        const result = await sendMessageSafely(undefined);

        assert.equal(result.ok, false);
        assert.ok(result.error instanceof Error);
    });
});
