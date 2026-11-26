// test/docs-alignment.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

const background = read('background.js');
const readme = read('README.md');
const optionsHtml = read('options.html');

/** background.js の文字列定数を読み取る */
function readStringConstant(source, name) {
    const match = source.match(new RegExp(`const ${name} = '([^']+)'`));
    assert.ok(match, `${name} が background.js に定義されていること`);
    return match[1];
}

describe('シームI: ドキュメントと実装の整合性', () => {
    const modelId = readStringConstant(background, 'GEMINI_MODEL_ID');
    const modelLabel = readStringConstant(background, 'GEMINI_MODEL_LABEL');

    it('README と設定画面のモデル表記が background.js の定数と一致すること', () => {
        for (const [name, doc] of [
            ['README.md', readme],
            ['options.html', optionsHtml]
        ]) {
            assert.ok(doc.includes(modelLabel), `${name} にモデル名 ${modelLabel} が記載されていること`);
        }
        assert.ok(readme.includes(modelId), `README.md にモデルID ${modelId} が記載されていること`);
    });

    it('設定画面が単一モデル構成と一致し、選択肢があるかのような表記をしないこと', () => {
        assert.ok(optionsHtml.includes('単一モデル'), '単一モデルであることを説明すること');
        assert.ok(!optionsHtml.includes('標準モデル'), '選択可能な既定モデルを連想させる表記を残さない');
    });

    it('設定画面が未対応の Vertex AI 取得手順を案内していないこと', () => {
        assert.ok(
            !optionsHtml.includes('Vertex AI'),
            'API 呼び出しは generativelanguage.googleapis.com のみのため、Vertex AI は案内しない'
        );
    });

    it('README のテスト手順が実際のチェックコマンドと一致すること', () => {
        assert.ok(readme.includes('node test/check.mjs'), 'README が node test/check.mjs を案内すること');
    });

    it('README に陳腐化しやすいテスト件数をハードコードしないこと', () => {
        assert.ok(!/\d+\s*テスト/.test(readme), 'テスト件数は増減するため README に固定値で書かない');
    });

    it('プライバシー説明が画像データそのものの送信に言及していること', () => {
        for (const [name, doc] of [
            ['README.md', readme],
            ['options.html', optionsHtml]
        ]) {
            assert.ok(doc.includes('画像データ'), `${name} が画像データの送信に言及していること`);
            assert.ok(doc.includes('送信'), `${name} が送信先について説明していること`);
        }
    });

    it('設定画面がローカルストレージの暗号化を主張していないこと', () => {
        assert.ok(
            !optionsHtml.includes('暗号化・隔離保存'),
            'chrome.storage.local は暗号化されないため、暗号化保存を主張しない'
        );
    });
});
