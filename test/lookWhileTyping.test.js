const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getLookWhileTypingAction,
    getLookWhileTypingScrollLine,
    isLookWhileTypingTarget,
} = require('../out/lookWhileTyping');

test('moves the target editor from the visible center by the configured step', () => {
    assert.equal(
        getLookWhileTypingScrollLine({
            firstVisibleLine: 20,
            lastVisibleLine: 40,
            lineCount: 100,
            direction: 1,
            stepLines: 3,
        }),
        33
    );
    assert.equal(
        getLookWhileTypingScrollLine({
            firstVisibleLine: 20,
            lastVisibleLine: 40,
            lineCount: 100,
            direction: -1,
            stepLines: 3,
        }),
        27
    );
});

test('keeps the target scroll line inside the document', () => {
    assert.equal(
        getLookWhileTypingScrollLine({
            firstVisibleLine: 0,
            lastVisibleLine: 5,
            lineCount: 20,
            direction: -1,
            stepLines: 8,
        }),
        0
    );
    assert.equal(
        getLookWhileTypingScrollLine({
            firstVisibleLine: 15,
            lastVisibleLine: 19,
            lineCount: 20,
            direction: 1,
            stepLines: 8,
        }),
        19
    );
});

test('matches a close target by both document and editor group', () => {
    const target = { documentUri: 'file:///work.md', viewColumn: 2 };

    assert.equal(isLookWhileTypingTarget(target, target), true);
    assert.equal(
        isLookWhileTypingTarget(
            { documentUri: 'file:///work.md', viewColumn: 1 },
            target
        ),
        false
    );
    assert.equal(
        isLookWhileTypingTarget(
            { documentUri: 'file:///other.md', viewColumn: 2 },
            target
        ),
        false
    );
});

test('maps configured single-character controls and rejects conflicting keys', () => {
    const controls = {
        scrollUpKey: '-',
        scrollDownKey: '=',
        closeTargetKey: '\\',
    };

    assert.equal(getLookWhileTypingAction('-', controls), 'scrollUp');
    assert.equal(getLookWhileTypingAction('=', controls), 'scrollDown');
    assert.equal(getLookWhileTypingAction('\\', controls), 'closeTarget');
    assert.equal(getLookWhileTypingAction('x', controls), undefined);
    assert.equal(
        getLookWhileTypingAction('-', { ...controls, scrollDownKey: '-' }),
        undefined
    );
});
