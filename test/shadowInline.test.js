const assert = require('node:assert/strict');
const test = require('node:test');

const {
    advanceShadowSession,
    canUseGenericShadowTyping,
    getGhostTextForCursor,
    isShadowPrefixAligned,
} = require('../out/shadowInline');

test('shows the next line ghost text after a line break', () => {
    const session = {
        beforeText: 'first\n\tsecond()',
        index: 5,
        line: 0,
        character: 5,
    };

    advanceShadowSession(session, '\n');

    assert.deepEqual(
        { index: session.index, line: session.line, character: session.character },
        { index: 6, line: 1, character: 0 }
    );
    assert.equal(
        getGhostTextForCursor(session, { line: 1, character: 0 }),
        '\tsecond()'
    );
});

test('shows the next line ghost text after a CRLF line break', () => {
    const session = {
        beforeText: 'first\r\nsecond()',
        index: 5,
        line: 0,
        character: 5,
    };

    advanceShadowSession(session, '\r\n');

    assert.deepEqual(
        { index: session.index, line: session.line, character: session.character },
        { index: 7, line: 1, character: 0 }
    );
    assert.equal(
        getGhostTextForCursor(session, { line: 1, character: 0 }),
        'second()'
    );
});

test('checks alignment against the session prefix instead of a stale editor selection', () => {
    const session = {
        beforeText: 'first\nsecond()',
        index: 6,
        line: 1,
        character: 0,
    };

    assert.equal(isShadowPrefixAligned(session, 'first\n'), true);
    assert.equal(isShadowPrefixAligned(session, 'first'), false);
});

test('blocks generic typing while manual line breaks or indentation are required', () => {
    assert.equal(
        canUseGenericShadowTyping({
            requiresManualProgression: true,
            isExpectingLineBreak: true,
            requiresManualIndentation: false,
        }),
        false
    );
    assert.equal(
        canUseGenericShadowTyping({
            requiresManualProgression: true,
            isExpectingLineBreak: false,
            requiresManualIndentation: true,
        }),
        false
    );
    assert.equal(
        canUseGenericShadowTyping({
            requiresManualProgression: true,
            isExpectingLineBreak: false,
            requiresManualIndentation: false,
        }),
        true
    );
});
