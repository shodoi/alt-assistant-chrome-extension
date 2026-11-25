// test/error-presentation.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CATEGORY, resolveErrorCategory } = require('../utils/error-presentation.js');

describe('シームE: エラー表示カテゴリの解決', () => {
    it('構造化された errorType を対応するカテゴリへ変換すること', () => {
        assert.equal(resolveErrorCategory({ errorType: 'RATE_LIMIT' }), 'RATE_LIMIT');
        assert.equal(resolveErrorCategory({ errorType: 'API_KEY_INVALID' }), 'API_KEY');
        assert.equal(resolveErrorCategory({ errorType: 'TIMEOUT' }), 'TIMEOUT');
        assert.equal(resolveErrorCategory({ errorType: 'SERVER_ERROR' }), 'SERVER');
        assert.equal(resolveErrorCategory({ errorType: 'NETWORK_ERROR' }), 'NETWORK');
        assert.equal(resolveErrorCategory({ errorType: 'CORS_RESTRICTED' }), 'CORS');
    });

    it('専用表示を持たない構造化種別は GENERIC にすること', () => {
        assert.equal(resolveErrorCategory({ errorType: 'UNSUPPORTED_IMAGE_FORMAT' }), 'GENERIC');
        assert.equal(resolveErrorCategory({ errorType: 'CONTENT_POLICY' }), 'GENERIC');
        assert.equal(resolveErrorCategory({ errorType: 'CLIENT_ERROR' }), 'GENERIC');
    });

    it('構造化された種別はメッセージ文言より優先されること', () => {
        assert.equal(
            resolveErrorCategory({
                errorType: 'RATE_LIMIT',
                userMessage: 'APIキーが無効です'
            }),
            'RATE_LIMIT'
        );
        assert.equal(
            resolveErrorCategory({
                errorType: 'API_KEY_INVALID',
                userMessage: '429 Too Many Requests'
            }),
            'API_KEY'
        );
    });

    it('UNKNOWN のときは従来の文言からフォールバック分類すること', () => {
        assert.equal(
            resolveErrorCategory({ errorType: 'UNKNOWN', userMessage: '429 Too Many Requests' }),
            'RATE_LIMIT'
        );
        assert.equal(
            resolveErrorCategory({ errorType: 'UNKNOWN', userMessage: 'APIキーが無効です' }),
            'API_KEY'
        );
        assert.equal(
            resolveErrorCategory({ errorType: 'UNKNOWN', userMessage: 'Failed to fetch' }),
            'NETWORK'
        );
        assert.equal(
            resolveErrorCategory({ errorType: 'UNKNOWN', userMessage: 'CORS policy blocked' }),
            'CORS'
        );
    });

    it('種別が未指定でも文言からフォールバック分類すること', () => {
        assert.equal(resolveErrorCategory({ userMessage: 'レート制限に達しました' }), 'RATE_LIMIT');
        assert.equal(resolveErrorCategory({ userMessage: 'ネットワークに接続できません' }), 'NETWORK');
    });

    it('CORS フラグは未分類メッセージでも CORS として扱うこと', () => {
        assert.equal(
            resolveErrorCategory({ errorType: 'UNKNOWN', userMessage: '取得できませんでした', isCorsBlocked: true }),
            'CORS'
        );
    });

    it('明示された構造化種別は CORS フラグより優先されること', () => {
        assert.equal(
            resolveErrorCategory({ errorType: 'RATE_LIMIT', userMessage: '取得できませんでした', isCorsBlocked: true }),
            'RATE_LIMIT'
        );
        assert.equal(
            resolveErrorCategory({ errorType: 'API_KEY_INVALID', isCorsBlocked: true }),
            'API_KEY'
        );
    });

    it('背景側 classifyApiError と同じ語彙を文言フォールバックで扱うこと', () => {
        assert.equal(resolveErrorCategory({ userMessage: 'Too Many Requests' }), 'RATE_LIMIT');
        assert.equal(resolveErrorCategory({ userMessage: 'apikey is missing' }), 'API_KEY');
        assert.equal(resolveErrorCategory({ userMessage: 'Permission denied' }), 'API_KEY');
        assert.equal(resolveErrorCategory({ userMessage: 'UNAUTHENTICATED' }), 'API_KEY');
    });

    it('ERROR_CATEGORY を凍結した語彙として公開すること', () => {
        assert.equal(ERROR_CATEGORY.GENERIC, 'GENERIC');
        assert.equal(ERROR_CATEGORY.CORS, 'CORS');
        assert.equal(Object.isFrozen(ERROR_CATEGORY), true);
    });

    it('情報が欠落していても例外にならず GENERIC を返すこと', () => {
        assert.equal(resolveErrorCategory(), 'GENERIC');
        assert.equal(resolveErrorCategory({}), 'GENERIC');
        assert.equal(resolveErrorCategory({ errorType: null, userMessage: null }), 'GENERIC');
    });
});
