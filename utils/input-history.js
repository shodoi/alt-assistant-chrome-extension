// utils/input-history.js

/**
 * @fileoverview ユーザー入力の検証、会話履歴の境界管理、言語追従プロンプト生成ユーティリティ
 *
 * Content Script・Service Worker・Node.js テストのすべてで同一の境界ルールを共有する。
 */

(function initInputHistory(globalScope) {
    'use strict';

    /** 空または空白のみの指示を拒否した際に表示する共通理由メッセージ */
    const EMPTY_INSTRUCTION_ERROR = '指示が入力されていません。空欄や空白のみでは生成を開始できません。';

    /**
     * 再生成プロンプトに含める会話履歴の最大発話数（ユーザー指示と AI 応答の合計メッセージ数）。
     * 長い対話でも直近 5 往復（10 発話）に制限し、プロンプトの無制限な肥大化・古いノイズの混入を防ぐ。
     */
    const MAX_HISTORY_ENTRIES = 10;

    /**
     * 再生成プロンプトの会話履歴（# CONVERSATION_LOG）に許容する最大文字数。
     * トークン消費と API レイテンシを抑えつつ、言語指定や直前の修正意図を保持できる現実的な上限として 2000 文字に設定する。
     */
    const MAX_HISTORY_CHARS = 2000;

    /** 会話履歴でユーザー発話を示す行プレフィックス */
    const USER_REQUEST_PREFIX = '- PREVIOUS_USER_REQUEST: ';

    /** 会話履歴で AI 応答を示す行プレフィックス */
    const AI_RESPONSE_PREFIX = '- PREVIOUS_AI_RESPONSE: ';

    /** 発話者ロールごとの履歴行プレフィックス（整形と解析で単一の定義を共有する） */
    const HISTORY_LINE_PREFIXES = {
        user: USER_REQUEST_PREFIX,
        ai: AI_RESPONSE_PREFIX
    };

    /**
     * 文字列が maxLength を超える場合、末尾を '…' で切り詰める
     * @param {string} text
     * @param {number} maxLength
     * @returns {string}
     */
    function truncateWithEllipsis(text, maxLength) {
        if (typeof text !== 'string') return '';
        if (maxLength <= 0) return '';
        if (text.length <= maxLength) return text;
        if (maxLength === 1) return '…';
        return text.slice(0, maxLength - 1) + '…';
    }

    /**
     * 新しい順（末尾から先頭）に配列を走査し、発話数上限と文字数上限の両方に収まる範囲で結合する
     * @param {string[]} lines - 古い順の行配列
     * @param {number} maxEntries
     * @param {number} maxChars
     * @returns {string}
     */
    function selectRecentLinesWithinBudget(lines, maxEntries, maxChars) {
        if (!Array.isArray(lines) || lines.length === 0 || maxEntries <= 0 || maxChars <= 0) {
            return '';
        }

        const recentLines = lines.slice(-maxEntries);
        const selected = [];
        let totalLength = 0;

        for (let i = recentLines.length - 1; i >= 0; i -= 1) {
            const line = recentLines[i];
            if (!line) continue;

            const separatorLength = selected.length > 0 ? 1 : 0;
            const nextLength = totalLength + separatorLength + line.length;

            if (nextLength <= maxChars) {
                selected.unshift(line);
                totalLength = nextLength;
                continue;
            }

            if (selected.length === 0) {
                selected.unshift(truncateWithEllipsis(line, maxChars));
            }
            break;
        }

        return selected.join('\n');
    }

    /**
     * ユーザー・AI の会話履歴エントリをフォーマットし、件数・文字数上限内に収める
     *
     * @param {Array<{ role: 'user'|'ai', text: string }>} entries - 古い順の会話エントリ配列
     * @returns {string}
     */
    function buildBoundedHistory(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return '';

        const formattedLines = [];
        for (const entry of entries) {
            if (!entry || typeof entry.text !== 'string') continue;
            const cleanText = entry.text.trim();
            if (!cleanText) continue;

            const prefix = HISTORY_LINE_PREFIXES[entry.role] || AI_RESPONSE_PREFIX;
            formattedLines.push(`${prefix}${cleanText}`);
        }

        return selectRecentLinesWithinBudget(formattedLines, MAX_HISTORY_ENTRIES, MAX_HISTORY_CHARS);
    }

    /**
     * すでに文字列化された会話履歴を件数・文字数上限内に収める（古い行から間引く）
     *
     * @param {string} historyText
     * @returns {string}
     */
    function clampHistoryString(historyText) {
        if (typeof historyText !== 'string') return '';
        const trimmed = historyText.trim();
        if (!trimmed) return '';

        const lines = trimmed
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        return selectRecentLinesWithinBudget(lines, MAX_HISTORY_ENTRIES, MAX_HISTORY_CHARS);
    }

    /**
     * 言語名の直前として許容する文字（行頭・空白・句読点・日本語の助詞）
     * 「英語の看板を日本語で」のように助詞を挟んだ文でも出力言語を拾えるようにする
     */
    const LANGUAGE_PREFIX_BOUNDARY = '(?:^|[\\s、。,.「」()（）のはがをにへもとや])';

    /**
     * 日本語名・英語名の表記から言語検出用の正規表現を組み立てる
     * @param {string[]} japaneseNames - 「英語」「英文」などの表記ゆれ
     * @param {string} englishName - 英語表記（小文字）
     * @returns {RegExp}
     */
    function buildLanguagePattern(japaneseNames, englishName) {
        const jaNames = japaneseNames.join('|');
        return new RegExp(
            `${LANGUAGE_PREFIX_BOUNDARY}(?:${jaNames})(?:で|に|へ|版|表記|出力|にして|$)` +
            `|^\\s*(?:${jaNames})\\s*$` +
            `|\\b(?:in|into|to)\\s+${englishName}\\b` +
            `|\\b${englishName}\\s+(?:please|version|output|text|alt)\\b` +
            `|^\\s*${englishName}\\s*$`,
            'i'
        );
    }

    /** 既知の言語キーワードと出力言語名の対応表 */
    const LANGUAGE_PATTERNS = [
        { name: 'English', pattern: buildLanguagePattern(['英語', '英文'], 'english') },
        { name: 'Japanese', pattern: buildLanguagePattern(['日本語', '和文'], 'japanese') },
        { name: 'French', pattern: buildLanguagePattern(['フランス語', '仏語'], 'french') },
        { name: 'Chinese', pattern: buildLanguagePattern(['中国語', '中文', '簡体字', '繁体字'], 'chinese') },
        { name: 'Korean', pattern: buildLanguagePattern(['韓国語', 'ハングル'], 'korean') },
        { name: 'Spanish', pattern: buildLanguagePattern(['スペイン語'], 'spanish') },
        { name: 'German', pattern: buildLanguagePattern(['ドイツ語', '独語'], 'german') },
        { name: 'Italian', pattern: buildLanguagePattern(['イタリア語'], 'italian') },
        { name: 'Portuguese', pattern: buildLanguagePattern(['ポルトガル語'], 'portuguese') }
    ];

    /**
     * 表にない言語名（「タイ語で」など）を拾うための限定パターン
     * 「3語」「単語」のような非言語表現は isPlausibleLanguageName で除外する
     */
    const GENERIC_JAPANESE_LANGUAGE_PATTERN = /([^\s、。,.「」()（）]{1,8}語)(?:で|に|へ|にして|でお願い|で書|で出力|で説明|$)/;

    /** 言語名ではなく語彙の種類を指す表現（汎用パターンの誤検出防止） */
    const NON_LANGUAGE_WORDS = new Set(['単語', '熟語', '用語', '敬語', '造語', '流行語', '標語', '合言葉']);

    /** 日本語の助詞（言語名の途中に現れたら複合語とみなす） */
    const JAPANESE_PARTICLE_PATTERN = /[のはがをにへもとや]/;

    /** 英語表記の言語名ホワイトリスト（"in Detail" のような非言語を弾く） */
    const KNOWN_ENGLISH_LANGUAGE_NAMES = new Set([
        'English', 'Japanese', 'French', 'Chinese', 'Korean', 'Spanish', 'German',
        'Italian', 'Portuguese', 'Thai', 'Russian', 'Arabic', 'Dutch', 'Hindi',
        'Vietnamese', 'Indonesian', 'Turkish', 'Polish', 'Swedish', 'Greek',
        'Hebrew', 'Ukrainian', 'Czech', 'Danish', 'Finnish', 'Norwegian'
    ]);

    /**
     * 汎用パターンが拾った語が言語名として妥当かを判定する
     * @param {string} candidate - 「〜語」形式の候補
     * @returns {boolean}
     */
    function isPlausibleLanguageName(candidate) {
        if (typeof candidate !== 'string' || candidate.length < 2) return false;
        if (NON_LANGUAGE_WORDS.has(candidate)) return false;
        if (/^\d/.test(candidate)) return false;
        return !JAPANESE_PARTICLE_PATTERN.test(candidate);
    }

    /**
     * 英語表記の言語名を表示用の先頭大文字へ正規化する
     * @param {string} name
     * @returns {string}
     */
    function normalizeEnglishLanguageName(name) {
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    /**
     * 単一のユーザー指示文から出力言語指定を抽出する
     * 複数言語が言及された場合は、より後ろで言及された方（最終的な指示）を採用する
     * @param {string} text
     * @returns {string|null}
     */
    function detectLanguageFromText(text) {
        if (typeof text !== 'string') return null;
        const trimmed = text.trim();
        if (!trimmed) return null;

        let detected = null;
        let detectedIndex = -1;
        for (const entry of LANGUAGE_PATTERNS) {
            const match = entry.pattern.exec(trimmed);
            if (!match) continue;
            if (match.index >= detectedIndex) {
                detected = entry.name;
                detectedIndex = match.index;
            }
        }
        if (detected) return detected;

        const genericJaMatch = trimmed.match(GENERIC_JAPANESE_LANGUAGE_PATTERN);
        if (genericJaMatch && isPlausibleLanguageName(genericJaMatch[1])) {
            return genericJaMatch[1];
        }

        const genericEnMatch = trimmed.match(/\b(?:in|into|to)\s+([A-Za-z]{3,20})\b/);
        if (genericEnMatch) {
            const normalized = normalizeEnglishLanguageName(genericEnMatch[1]);
            if (KNOWN_ENGLISH_LANGUAGE_NAMES.has(normalized)) return normalized;
        }

        return null;
    }

    /**
     * 今回の指示と会話履歴（ユーザー発話のみ）から、出力すべき言語を決定する
     *
     * @param {string} additionalInstruction - 今回のユーザー指示
     * @param {string} [history=''] - 会話履歴文字列
     * @returns {string|null} 指定された言語（未指定時は null）
     */
    function resolveTargetLanguage(additionalInstruction, history = '') {
        const directLang = detectLanguageFromText(additionalInstruction);
        if (directLang) return directLang;

        if (typeof history === 'string' && history.trim()) {
            const lines = history.split(/\r?\n/);
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                const line = lines[i].trim();
                if (!line.startsWith(USER_REQUEST_PREFIX)) continue;
                const userText = line.slice(USER_REQUEST_PREFIX.length).trim();
                const histLang = detectLanguageFromText(userText);
                if (histLang) return histLang;
            }
        }

        return null;
    }

    /**
     * 生成コンテキストが「再生成（Regeneration）」かどうかを判定する
     * history が空文字であっても、再生成フラグや履歴/追加指示フィールドがあれば再生成とみなす
     *
     * @param {object|null|undefined} context
     * @returns {boolean}
     */
    function isRegenerationContext(context) {
        if (!context || typeof context !== 'object') return false;
        return (
            context.isRegeneration === true ||
            typeof context.history === 'string' ||
            typeof context.additionalInstruction === 'string'
        );
    }

    /**
     * 再生成用の、対話ログ上限・言語指定追従を考慮したプロンプトを作成する
     *
     * @param {object} context - 会話の文脈情報
     * @param {string} [context.history=''] - これまでの会話履歴文字列
     * @param {string} [context.additionalInstruction=''] - ユーザーからの最後の指示
     * @returns {string}
     */
    function createRegenerationPrompt(context = {}) {
        const safeContext = context && typeof context === 'object' ? context : {};
        const boundedHistory = clampHistoryString(safeContext.history || '');
        const currentRequest = typeof safeContext.additionalInstruction === 'string'
            ? safeContext.additionalInstruction.trim()
            : '';

        const targetLanguage = resolveTargetLanguage(currentRequest, boundedHistory);
        const languageDirective = targetLanguage
            ? `Output in ${targetLanguage}.`
            : 'Output in Japanese.';

        const conversationSection = boundedHistory || '(none)';

        return [
            '# CONVERSATION_LOG',
            conversationSection,
            '',
            '# CURRENT_USER_REQUEST',
            currentRequest,
            '',
            '# YOUR_TASK',
            'Based on the image and the above CONVERSATION_LOG, generate the single, final, complete alt text that fulfills the CURRENT_USER_REQUEST.',
            'Your output must be ONLY the alt text. Do not include any other text.',
            languageDirective,
            '',
            '# FINAL_ALT_TEXT:'
        ].join('\n');
    }

    /**
     * 初回生成用のプロンプトを作成する
     * 指示文そのものを渡すだけでなく、出力形式と言語指定を明示して
     * 「英語で」などの言語指示が初回生成でも守られるようにする
     *
     * @param {string} instruction - ユーザーが入力した初回 Instruction
     * @returns {string}
     */
    function createInitialPrompt(instruction) {
        const currentRequest = typeof instruction === 'string' ? instruction.trim() : '';
        const targetLanguage = detectLanguageFromText(currentRequest);
        const languageDirective = targetLanguage
            ? `Output in ${targetLanguage}.`
            : 'Output in Japanese.';

        return [
            '# USER_INSTRUCTION',
            currentRequest,
            '',
            '# YOUR_TASK',
            'Generate the single, final, complete alt text for the attached image that fulfills the USER_INSTRUCTION.',
            'Your output must be ONLY the alt text. Do not include any other text.',
            languageDirective,
            '',
            '# FINAL_ALT_TEXT:'
        ].join('\n');
    }

    /**
     * ユーザー入力（Instruction / 追加指示）が空や空白のみでないかを検証する
     *
     * @param {string} rawText - 入力テキスト
     * @returns {{ valid: boolean, value: string, error?: string }}
     */
    function validateInstruction(rawText) {
        if (typeof rawText !== 'string') {
            return { valid: false, value: '', error: EMPTY_INSTRUCTION_ERROR };
        }
        const trimmed = rawText.trim();
        if (trimmed.length === 0) {
            return { valid: false, value: '', error: EMPTY_INSTRUCTION_ERROR };
        }
        return { valid: true, value: trimmed };
    }

    const api = {
        EMPTY_INSTRUCTION_ERROR,
        MAX_HISTORY_ENTRIES,
        MAX_HISTORY_CHARS,
        validateInstruction,
        buildBoundedHistory,
        clampHistoryString,
        resolveTargetLanguage,
        isRegenerationContext,
        createInitialPrompt,
        createRegenerationPrompt
    };

    if (globalScope) {
        globalScope.AltAssistantInputHistory = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null)));
