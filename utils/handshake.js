/**
 * handshake.js - Service Worker と Content Script 間の健全な通信確立
 *
 * PING/PONG ハンドシェイクを用いて、Content Script の重複注入を防止し、
 * 動的遷移直後や未ロード時でも確実に通信を確立する。
 */

/**
 * 指定時間待機するヘルパー関数
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 対象のタブ／フレームへ PING を送信し、Content Script の応答を確認する
 *
 * @param {number} tabId - 対象タブID
 * @param {number} frameId - 対象フレームID
 * @param {Function} sendMessage - メッセージ送信関数
 * @param {number} timeoutMs - タイムアウト待機時間
 * @returns {Promise<boolean>} 疎通が確認できれば true
 */
async function pingTab(tabId, frameId, sendMessage, timeoutMs = 200) {
    try {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('PING_TIMEOUT')), timeoutMs);
        });

        const sendOptions = typeof frameId === 'number' && frameId > 0 ? { frameId } : {};
        const sendPromise = sendMessage(tabId, { action: 'ping' }, sendOptions);

        const response = await Promise.race([sendPromise, timeoutPromise]);
        return !!(response && response.pong === true);
    } catch {
        return false;
    }
}

/**
 * Content Script との PING 疎通を確認し、未注入時のみ動的ロードを行う
 *
 * 1. PING を送信し、即座に PONG が返れば既存のスクリプトを再利用（二重注入防止）
 * 2. 応答がない場合、chrome.scripting.executeScript で動的注入
 * 3. 注入後、PONG が返るまで短時間リトライして確実に通信を確立する
 *
 * @param {number} tabId - 注入対象のタブID
 * @param {number} [frameId=0] - 注入対象のフレームID
 * @param {object} [options={}] - 依存性注入および設定オプション
 * @param {Function} [options.sendMessage] - chrome.tabs.sendMessage 代替
 * @param {Function} [options.executeScript] - chrome.scripting.executeScript 代替
 * @param {number} [options.pingTimeoutMs=200] - PINGタイムアウト時間
 * @param {number} [options.maxRetries=3] - 注入後の疎通確認リトライ回数
 * @param {number} [options.retryDelayMs=80] - リトライ間隔
 * @returns {Promise<void>}
 */
async function ensureContentScriptReady(tabId, frameId = 0, options = {}) {
    const sendMessage = options.sendMessage || (
        typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage.bind(chrome.tabs)
    );
    const executeScript = options.executeScript || (
        typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript.bind(chrome.scripting)
    );
    const pingTimeoutMs = options.pingTimeoutMs ?? 200;
    const maxRetries = options.maxRetries ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 80;

    // 1. まず PING で既存の Content Script の存在を確認
    const isAlreadyAlive = await pingTab(tabId, frameId, sendMessage, pingTimeoutMs);
    if (isAlreadyAlive) {
        // すでにロード済みの場合は注入をスキップ（リスナー重複や二重実行を防止）
        return;
    }

    // 2. 未注入時は動的スクリプト注入を実行
    const target = { tabId };
    if (typeof frameId === 'number' && frameId > 0) {
        target.frameIds = [frameId];
    }

    try {
        await executeScript({
            target,
            files: ['content.js']
        });
    } catch (error) {
        console.warn(`コンテンツスクリプトの動的注入に失敗しました (tabId: ${tabId}, frameId: ${frameId}):`, error);
        throw new Error('このページでは拡張機能を実行できません（保護されたシステムページ等）。');
    }

    // 3. 注入直後の起動完了を PING リトライで待機・疎通確認
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (retryDelayMs > 0) {
            await sleep(retryDelayMs);
        }
        const isReady = await pingTab(tabId, frameId, sendMessage, pingTimeoutMs);
        if (isReady) {
            return;
        }
    }

    throw new Error('コンテンツスクリプトとの通信を確立できませんでした。ページを再読み込みしてお試しください。');
}

// CommonJS (Node.js テスト用) とブラウザ環境の互換性サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ensureContentScriptReady, pingTab };
}
