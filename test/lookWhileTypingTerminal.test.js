const assert = require('node:assert/strict');
const test = require('node:test');

const { getLookWhileTypingTerminalScrollCommand } = require('../out/lookWhileTyping');

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
