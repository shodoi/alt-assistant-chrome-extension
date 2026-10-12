const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateImageUrl } = require('../utils/validation.js');

describe('validateImageUrl (シームA: 画像URLバリデーション)', () => {
    describe('正常系: 許可されるプロトコル', () => {
        it('https: URLを許可すること', () => {
            const result = validateImageUrl('https://example.com/images/cat.png');
            assert.equal(result.valid, true);
            assert.equal(result.protocol, 'https:');
        });

        it('http: URLを許可すること', () => {
            const result = validateImageUrl('http://example.com/photo.jpg?size=large');
            assert.equal(result.valid, true);
            assert.equal(result.protocol, 'http:');
        });

        it('data:image/* 形式の Data URI を許可すること', () => {
            const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const result = validateImageUrl(dataUrl);
            assert.equal(result.valid, true);
            assert.equal(result.protocol, 'data:');
        });

        it('data:image/jpeg や data:image/webp 形式も許可すること', () => {
            const jpegResult = validateImageUrl('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/');
            assert.equal(jpegResult.valid, true);

            const webpResult = validateImageUrl('data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=');
            assert.equal(webpResult.valid, true);
        });
    });

    describe('異常系: 危険または非想定なプロトコルの拒否', () => {
        it('javascript: プロトコルを拒否すること', () => {
            const result = validateImageUrl('javascript:alert("XSS")');
            assert.equal(result.valid, false);
            assert.match(result.error, /javascript:/i);
        });

        it('file: プロトコルを拒否すること', () => {
            const result = validateImageUrl('file:///etc/passwd');
            assert.equal(result.valid, false);
            assert.match(result.error, /file:/i);
        });

        it('blob: プロトコルを拒否すること', () => {
            const result = validateImageUrl('blob:https://example.com/4a5b7d90-3b98-466d-9721-a48a47eb3d3e');
            assert.equal(result.valid, false);
            assert.match(result.error, /blob:/i);
        });

        it('画像以外の data: URI (data:text/html など) を拒否すること', () => {
            const result = validateImageUrl('data:text/html,<script>alert(1)</script>');
            assert.equal(result.valid, false);
            assert.match(result.error, /data:image/);
        });

        it('ftp: やその他未知のプロトコルを拒否すること', () => {
            const result = validateImageUrl('ftp://example.com/image.png');
            assert.equal(result.valid, false);
        });

        it('空文字、null、undefined、非文字列を拒否すること', () => {
            assert.equal(validateImageUrl('').valid, false);
            assert.equal(validateImageUrl(null).valid, false);
            assert.equal(validateImageUrl(undefined).valid, false);
            assert.equal(validateImageUrl(12345).valid, false);
        });

        it('不正なフォーマットのURL文字列を拒否すること', () => {
            const result = validateImageUrl('ht tp://invalid url with spaces');
            assert.equal(result.valid, false);
        });
    });
});
