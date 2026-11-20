// utils/command-handler.js

/**
 * @fileoverview Service Worker における chrome.commands ショートカット受付・連携ハンドラー
 */

/**
 * サポート対象外または安全上操作できない特殊URLのプレフィックス一覧
 */
const UNSUPPORTED_URL_PREFIXES = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'view-source:'
];

/**
 * URLが拡張機能スクリプトの実行をサポートしているか判定する
 * @param {string} [url='']
 * @returns {boolean}
 */
function isSupportedTabUrl(url = '') {
    if (typeof url !== 'string' || !url) return false;
    return !UNSUPPORTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * chrome.commands から受信したショートカットコマンドを処理し、Alt生成フローを呼び出す
 * 
 * @param {string} command - 受信したコマンドID (例: 'trigger_alt_generator')
 * @param {chrome.tabs.Tab|null} [tab=null] - 対象のタブ情報 (Chromeから渡されたタブ)
 * @param {object} [dependencies={}] - 依存関数インジェクション (テストおよびService Worker用)
 * @param {function} [dependencies.ensureContentScriptReady] - Content Scriptの疎通確認・動的注入関数
 * @param {function} [dependencies.sendMessage] - chrome.tabs.sendMessage
 * @param {function} [dependencies.queryTabs] - chrome.tabs.query
 * @param {function} [dependencies.startGenerationProcess] - Altテキスト生成プロセスメイン関数
 * @returns {Promise<boolean>} 処理が実行された場合は true、スキップされた場合は false
 */
async function handleCommandShortcut(command, tab = null, dependencies = {}) {
    if (command !== 'trigger_alt_generator') {
        return false;
    }

    const {
        ensureContentScriptReady = (typeof globalThis.ensureContentScriptReady === 'function' ? globalThis.ensureContentScriptReady : null),
        sendMessage = (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage ? chrome.tabs.sendMessage.bind(chrome.tabs) : null),
        queryTabs = (typeof chrome !== 'undefined' && chrome.tabs?.query ? chrome.tabs.query.bind(chrome.tabs) : null),
        startGenerationProcess = (typeof globalThis.startGenerationProcess === 'function' ? globalThis.startGenerationProcess : null)
    } = dependencies;

    // 1. 対象タブの解決
    let targetTab = tab;
    if (!targetTab && typeof queryTabs === 'function') {
        try {
            const tabs = await queryTabs({ active: true, currentWindow: true });
            targetTab = tabs?.[0] || null;
        } catch (e) {
            console.warn('[Shortcut] アクティブタブの取得に失敗しました:', e);
            return false;
        }
    }

    if (!targetTab || !targetTab.id) {
        console.warn('[Shortcut] 有効な対象タブが見つかりませんでした。');
        return false;
    }

    // 2. 特殊URL等の除外
    if (!isSupportedTabUrl(targetTab.url)) {
        console.info(`[Shortcut] サポートされていないURL (${targetTab.url}) のためスキップします。`);
        return false;
    }

    // 3. Content Script の疎通確認
    if (typeof ensureContentScriptReady === 'function') {
        try {
            await ensureContentScriptReady(targetTab.id, 0);
        } catch (err) {
            console.warn('[Shortcut] Content Script の準備中にエラーが発生しました:', err);
            return false;
        }
    }

    // 4. Content Script へフォーカス画像検出メッセージを送信
    if (typeof sendMessage !== 'function') {
        return false;
    }

    let detectionResponse = null;
    try {
        detectionResponse = await sendMessage(targetTab.id, {
            action: 'detectFocusedImageForShortcut'
        });
    } catch (err) {
        console.warn('[Shortcut] フォーカス画像検出メッセージの送信に失敗しました:', err);
        return false;
    }

    // 5. 画像が正常に検出された場合、生成プロセスを開始
    if (detectionResponse && detectionResponse.success && detectionResponse.imageUrl) {
        if (typeof startGenerationProcess === 'function') {
            startGenerationProcess(
                detectionResponse.imageUrl,
                targetTab.id,
                0,
                detectionResponse.targetElementId || null
            );
            return true;
        }
    }

    return false;
}

// Service Worker (self/globalThis) 環境向けの公開
if (typeof self !== 'undefined') {
    self.handleCommandShortcut = handleCommandShortcut;
    self.isSupportedTabUrl = isSupportedTabUrl;
}

// CommonJS (Node.js テスト用) サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        handleCommandShortcut,
        isSupportedTabUrl
    };
}
