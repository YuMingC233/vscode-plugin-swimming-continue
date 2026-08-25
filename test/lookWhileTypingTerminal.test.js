const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getLookWhileTypingTerminalInputSequence,
    getLookWhileTypingTerminalScrollCommand,
} = require('../out/lookWhileTyping');

test('maps Look While Typing terminal scrolling to VS Code terminal commands', () => {
    assert.equal(
        getLookWhileTypingTerminalScrollCommand(-1),
        'workbench.action.terminal.scrollUp'
    );
    assert.equal(
        getLookWhileTypingTerminalScrollCommand(1),
        'workbench.action.terminal.scrollDown'
    );
});

test('uses w3m screen scrolling keys instead of moving its link cursor', () => {
    assert.equal(
        getLookWhileTypingTerminalInputSequence(-1, 'w3m', 3),
        'KKK'
    );
    assert.equal(
        getLookWhileTypingTerminalInputSequence(1, 'w3m', 2),
        'JJ'
    );
});

test('maps terminal cursor and page navigation in the requested direction', () => {
    assert.equal(
        getLookWhileTypingTerminalInputSequence(-1, 'cursorKeys', 2),
        '\x1b[A\x1b[A'
    );
    assert.equal(
        getLookWhileTypingTerminalInputSequence(1, 'applicationCursorKeys', 2),
        '\x1bOB\x1bOB'
    );
    assert.equal(
        getLookWhileTypingTerminalInputSequence(-1, 'pageKeys', 5),
        '\x1b[5~'
    );
});
