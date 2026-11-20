// utils/generation-state.js

/**
 * @fileoverview チャットダイアログの生成中状態とエラー復帰を一貫させるユーティリティ
 *
 * 主な機能:
 * 1. 生成中の操作ロックを「送信入力・送信ボタン」だけに限定 (beginChatGeneration)
 * 2. 成功・エラーのどちらの結末でもローディング表示を除去し入力を再開 (endChatGeneration)
 * 3. エラー通知へ使用モデル名を一度だけ付与 (buildModelAwareErrorMessage)
 * 4. 送信先タブ/ポート消失時も未処理の Promise 拒否を発生させない送信 (sendMessageSafely)
 */

/** チャットの追加指示入力欄セレクタ */
const CHAT_INPUT_SELECTOR = '#gemini-instruction-input';

/** チャットの送信ボタンセレクタ (適用ボタン `.is-apply` と区別する) */
const CHAT_SEND_BUTTON_SELECTOR = '.gemini-icon-btn.is-send';

/** 生成中を示すローディングバブルセレクタ */
const CHAT_LOADING_BUBBLE_SELECTOR = '.chat-bubble-loading';

/** チャットメッセージ行セレクタ */
const CHAT_ROW_SELECTOR = '.gemini-chat-row';

/**
 * ダイアログ配下の要素を安全に取得する
 * @param {HTMLElement|null|undefined} dialog
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function queryChatElement(dialog, selector) {
    if (!dialog || typeof dialog.querySelector !== 'function') return null;
    return dialog.querySelector(selector);
}

/**
 * チャットの送信入力欄と送信ボタンだけを有効/無効化する
 * コピー・Alt適用など、生成結果に対する操作は生成中も使えるようにする
 * @param {HTMLElement|null|undefined} dialog
 * @param {boolean} enabled
 * @returns {{ inputField: HTMLElement|null, sendButton: HTMLElement|null }}
 */
function setChatSendControlsEnabled(dialog, enabled) {
    const isEnabled = enabled !== false;
    const inputField = queryChatElement(dialog, CHAT_INPUT_SELECTOR);
    const sendButton = queryChatElement(dialog, CHAT_SEND_BUTTON_SELECTOR);

    if (inputField) inputField.disabled = !isEnabled;
    if (sendButton) sendButton.disabled = !isEnabled;

    return { inputField, sendButton };
}

/**
 * 生成中のローディングメッセージ行を取り除く
 * @param {HTMLElement|null|undefined} dialog
 * @returns {boolean} 取り除いた場合は true
 */
function removeChatLoadingMessage(dialog) {
    const bubble = queryChatElement(dialog, CHAT_LOADING_BUBBLE_SELECTOR);
    if (!bubble) return false;

    const row = typeof bubble.closest === 'function' ? bubble.closest(CHAT_ROW_SELECTOR) : null;
    const target = row || bubble;
    if (target && typeof target.remove === 'function') {
        target.remove();
    }
    return true;
}

/**
 * 再生成リクエスト送信時にチャットを生成中状態へ遷移させる
 * @param {HTMLElement|null|undefined} dialog
 */
function beginChatGeneration(dialog) {
    setChatSendControlsEnabled(dialog, false);
}

/**
 * 成功・APIエラー・レート制限・ネットワーク断・送信失敗の共通終了遷移
 * ローディング表示を必ず除去し、ユーザーが次の指示を入力できる状態へ戻す
 * @param {HTMLElement|null|undefined} dialog
 */
function endChatGeneration(dialog) {
    removeChatLoadingMessage(dialog);
    setChatSendControlsEnabled(dialog, true);
}

/**
 * エラー案内文に使用モデル名を付与する
 * すでにモデル名を含む場合は重複して付与しない
 * @param {string} userMessage - ユーザー向けエラー案内
 * @param {string} [modelLabel] - 使用モデルの表示名
 * @returns {string}
 */
function buildModelAwareErrorMessage(userMessage, modelLabel) {
    const baseMessage = typeof userMessage === 'string' ? userMessage.trim() : '';
    const label = typeof modelLabel === 'string' ? modelLabel.trim() : '';

    if (!label || baseMessage.includes(label)) return baseMessage;

    const modelSuffix = `（使用モデル: ${label}）`;
    return baseMessage ? `${baseMessage}${modelSuffix}` : modelSuffix;
}

/**
 * chrome.tabs.sendMessage / chrome.runtime.sendMessage を安全に呼び出す
 * タブやポートが閉じられた場合でも例外を投げず、結果を { ok, response|error } で返す
 * @param {Function} sendMessage - 送信関数
 * @param {...any} args - 送信関数へ渡す引数
 * @returns {Promise<{ ok: boolean, response?: any, error?: Error }>}
 */
async function sendMessageSafely(sendMessage, ...args) {
    if (typeof sendMessage !== 'function') {
        return { ok: false, error: new Error('sendMessage が関数ではありません。') };
    }

    try {
        const response = await sendMessage(...args);
        return { ok: true, response };
    } catch (error) {
        console.warn('メッセージ送信に失敗しました（タブまたはポートが閉じられた可能性があります）:', error?.message || error);
        return { ok: false, error };
    }
}

// ブラウザ/コンテンツスクリプト環境向けのグローバル公開
if (typeof window !== 'undefined') {
    window.AltAssistantGenerationState = {
        beginChatGeneration,
        endChatGeneration,
        buildModelAwareErrorMessage,
        sendMessageSafely
    };
}

// CommonJS (Node.js テスト用) サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        beginChatGeneration,
        endChatGeneration,
        buildModelAwareErrorMessage,
        sendMessageSafely
    };
}
