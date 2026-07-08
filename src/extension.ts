import {
    commands,
    ExtensionContext,
    Position,
    Range,
    Selection,
    TextEditor,
    TextEditorEdit,
    TextEditorRevealType,
    window,
    workspace,
} from 'vscode';

const TYPE_COMMAND = 'type';
const DEFAULT_TYPE_COMMAND = 'default:type';
const SHADOW_CONTEXT = 'vscodePluginSwimming.shadowActive';
const SHADOW_DELETE_LEFT_COMMAND = 'extension.swimming.shadowDeleteLeft';
const AUTO_CLOSING_PAIRS: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    '\'': '\'',
    '`': '`',
};

type RewriteSession = {
    beforeText: string;
    index: number;
    line: number;
    character: number;
    initLine: number;
    initCharacter: number;
};

function getReWriteSpeed() {
    const reWriteSpeed = workspace
        .getConfiguration()
        .get<number>('vscodePluginSwimming.reWriteSpeed');

    return typeof reWriteSpeed === 'number' ? reWriteSpeed : 0;
}

function getShadowRequireSymbolKey() {
    const requireSymbolKey = workspace
        .getConfiguration()
        .get<boolean>('vscodePluginSwimming.shadowRequireShiftForSymbols');

    return typeof requireSymbolKey === 'boolean' ? requireSymbolKey : true;
}

enum RewriteMode {
    Cycle = 'cycle',
    Once = 'once',
}

function getRewriteMode(): RewriteMode {
    const nowRewriteMode = workspace
        .getConfiguration()
        .get<RewriteMode>('vscodePluginSwimming.rewriteMode');
    return nowRewriteMode || RewriteMode.Once;
}

function setRewriteMode(nowRewriteMode: RewriteMode) {
    return workspace
        .getConfiguration()
        .update('vscodePluginSwimming.rewriteMode', nowRewriteMode);
}

const isWriteCodePauseMap: Map<string, boolean> = new Map();
const isWritingCodeMap: Map<string, boolean> = new Map();
const shadowSessionMap: Map<string, RewriteSession> = new Map();

function getEditorKey(textEditor: TextEditor) {
    return textEditor.document.uri.toString();
}

function updateShadowContext() {
    void commands.executeCommand('setContext', SHADOW_CONTEXT, shadowSessionMap.size > 0);
}

function finishWriting(editorKey: string) {
    isWritingCodeMap.set(editorKey, false);
    isWriteCodePauseMap.delete(editorKey);
}

function clearShadowSession(editorKey: string) {
    shadowSessionMap.delete(editorKey);
    finishWriting(editorKey);
    updateShadowContext();
}

function clearAllShadowSessions() {
    for (const editorKey of shadowSessionMap.keys()) {
        finishWriting(editorKey);
    }
    shadowSessionMap.clear();
    updateShadowContext();
}

function showPauseinfo(textEditor: TextEditor) {
    if (isWriteCodePauseMap.get(getEditorKey(textEditor))) {
        window.showInformationMessage('pauseWriteCode Now');
    }
}

function getSelectionRangeByStartAndEnd({
    start,
    end,
    textEditor,
}: {
    start: Position;
    end: Position;
    textEditor: TextEditor;
}) {
    let selectionRange = new Range(start, end);

    if (selectionRange.isEmpty) {
        const documentEnd = textEditor.document.lineAt(
            textEditor.document.lineCount - 1
        ).rangeIncludingLineBreak.end;
        selectionRange = new Range(new Position(0, 0), documentEnd);
    }
    return selectionRange;
}

function createRewriteSession(textEditor: TextEditor, selectionRange: Range) {
    return {
        beforeText: textEditor.document.getText(selectionRange),
        index: 0,
        line: selectionRange.start.line,
        character: selectionRange.start.character,
        initLine: selectionRange.start.line,
        initCharacter: selectionRange.start.character,
    };
}

function getWrittenRange(session: RewriteSession) {
    return new Range(
        new Position(session.initLine, session.initCharacter),
        new Position(session.line, session.character)
    );
}

function getSessionPosition(session: RewriteSession) {
    return new Position(session.line, session.character);
}

function setEditorCursor(textEditor: TextEditor, position: Position) {
    textEditor.selection = new Selection(position, position);
}

function syncSessionCursor(textEditor: TextEditor, session: RewriteSession) {
    const activePosition = textEditor.selection.active;
    session.line = activePosition.line;
    session.character = activePosition.character;
}

function resetRewriteSession(textEditor: TextEditor, session: RewriteSession) {
    return textEditor.edit((editBuilder) => {
        editBuilder.delete(getWrittenRange(session));
        session.index = 0;
        session.line = session.initLine;
        session.character = session.initCharacter;
    });
}

function revealCurrentPosition(textEditor: TextEditor, session: RewriteSession) {
    const nowPosition = new Position(session.line, session.character);
    textEditor.revealRange(
        new Range(nowPosition, nowPosition),
        TextEditorRevealType.InCenter
    );
    return nowPosition;
}

function writeNextTargetChunk(textEditor: TextEditor, session: RewriteSession) {
    return textEditor.edit((editBuilder) => {
        const nowPosition = revealCurrentPosition(textEditor, session);

        if (session.beforeText.startsWith('\r\n', session.index)) {
            session.index += 2;
            session.line += 1;
            session.character = 0;
            editBuilder.insert(nowPosition, '\r\n');
            return;
        }

        if (session.beforeText.startsWith('\n', session.index)) {
            session.index += 1;
            session.line += 1;
            session.character = 0;
            editBuilder.insert(nowPosition, '\n');
            return;
        }

        editBuilder.insert(nowPosition, session.beforeText[session.index]);
        session.index += 1;
        session.character += 1;
    });
}

function isSymbolCharacter(text: string) {
    return text.length > 0 && !/^[\p{L}\p{N}_\s]$/u.test(text);
}

function getNextTargetCharacter(session: RewriteSession) {
    if (session.index >= session.beforeText.length) {
        return '';
    }

    return session.beforeText[session.index];
}

function canUseAutoClosingPair(session: RewriteSession) {
    const nextCharacter = getNextTargetCharacter(session);
    return nextCharacter in AUTO_CLOSING_PAIRS;
}

function shouldStepOverClosingCharacter(textEditor: TextEditor, session: RewriteSession) {
    const nextCharacter = getNextTargetCharacter(session);
    const currentPosition = getSessionPosition(session);
    const currentOffset = textEditor.document.offsetAt(currentPosition);
    const lineEndOffset = textEditor.document.offsetAt(
        textEditor.document.lineAt(currentPosition.line).range.end
    );

    if (!nextCharacter || currentOffset >= lineEndOffset) {
        return false;
    }

    const nextDocumentCharacter = textEditor.document.getText(new Range(
        currentPosition,
        textEditor.document.positionAt(currentOffset + 1)
    ));

    return nextDocumentCharacter === nextCharacter
        && Object.values(AUTO_CLOSING_PAIRS).includes(nextCharacter);
}

async function typeAutoClosingCharacter(textEditor: TextEditor, session: RewriteSession) {
    const nextCharacter = getNextTargetCharacter(session);
    if (!nextCharacter) {
        return false;
    }

    await commands.executeCommand(DEFAULT_TYPE_COMMAND, { text: nextCharacter });
    session.index += 1;
    syncSessionCursor(textEditor, session);
    return true;
}

function stepOverClosingCharacter(textEditor: TextEditor, session: RewriteSession) {
    const currentOffset = textEditor.document.offsetAt(getSessionPosition(session));
    const nextPosition = textEditor.document.positionAt(currentOffset + 1);

    session.index += 1;
    session.line = nextPosition.line;
    session.character = nextPosition.character;
    setEditorCursor(textEditor, nextPosition);
    revealCurrentPosition(textEditor, session);
    return true;
}

function deleteShadowOverflow(textEditor: TextEditor, session: RewriteSession) {
    const expectedOffset = textEditor.document.offsetAt(getSessionPosition(session));
    const actualPosition = textEditor.selection.active;
    const actualOffset = textEditor.document.offsetAt(actualPosition);

    if (actualOffset <= expectedOffset) {
        return false;
    }

    const startPosition = textEditor.document.positionAt(actualOffset - 1);
    return textEditor.edit((editBuilder) => {
        editBuilder.delete(new Range(startPosition, actualPosition));
    }).then((isEdited) => {
        if (isEdited) {
            setEditorCursor(textEditor, startPosition);
        }
        return isEdited;
    });
}

function canShadowTypeAdvance(typedText: string, session: RewriteSession) {
    if (session.beforeText.startsWith('\r\n', session.index)) {
        return true;
    }

    if (session.beforeText.startsWith('\n', session.index)) {
        return true;
    }

    const nextCharacter = session.beforeText[session.index];
    if (!isSymbolCharacter(nextCharacter)) {
        return typedText.length > 0;
    }

    if (!getShadowRequireSymbolKey()) {
        return typedText.length > 0;
    }

    return [...typedText].some((character) => isSymbolCharacter(character));
}

function rewriteCodeWithStartAndEnd({
    textEditor,
    edit,
}: {
    textEditor: TextEditor;
    edit: TextEditorEdit;
}) {
    const editorKey = getEditorKey(textEditor);
    const selectionRange = getSelectionRangeByStartAndEnd({
        start: textEditor.selection.start,
        end: textEditor.selection.end,
        textEditor,
    });
    const session = createRewriteSession(textEditor, selectionRange);

    edit.delete(selectionRange);

    const recycleWrite = function(inputTimeout: NodeJS.Timeout) {
        clearTimeout(inputTimeout);
        finishWriting(editorKey);
    };

    const runWrite = function() {
        const inputTimeout: NodeJS.Timeout = setTimeout(() => {
            if (isWriteCodePauseMap.get(editorKey)) {
                return textEditor.edit(() => undefined)
                    .then(() => runWrite(), (reason) => {
                        recycleWrite(inputTimeout);
                        throw new Error(String(reason));
                    });
            }

            if (textEditor.document.isClosed) {
                return recycleWrite(inputTimeout);
            }

            if (session.index >= session.beforeText.length) {
                if (getRewriteMode() === RewriteMode.Cycle) {
                    return resetRewriteSession(textEditor, session)
                        .then(() => runWrite(), (reason) => {
                            recycleWrite(inputTimeout);
                            throw new Error(String(reason));
                        });
                }

                return recycleWrite(inputTimeout);
            }

            writeNextTargetChunk(textEditor, session)
                .then(() => runWrite(), (reason) => {
                    recycleWrite(inputTimeout);
                    throw new Error(String(reason));
                });
        }, getReWriteSpeed());
    };

    runWrite();
}

function rewriteCode(
    textEditor: TextEditor,
    edit: TextEditorEdit,
    _args: any[]
) {
    const editorKey = getEditorKey(textEditor);
    if (isWritingCodeMap.get(editorKey)) {
        return window.showInformationMessage('rewriteCode already in progress');
    }

    isWritingCodeMap.set(editorKey, true);
    isWriteCodePauseMap.set(editorKey, false);
    rewriteCodeWithStartAndEnd({
        textEditor,
        edit,
    });
}

function shadowRewriteCode(
    textEditor: TextEditor,
    edit: TextEditorEdit,
    _args: any[]
) {
    const editorKey = getEditorKey(textEditor);
    if (isWritingCodeMap.get(editorKey)) {
        return window.showInformationMessage('rewriteCode already in progress');
    }

    const selectionRange = getSelectionRangeByStartAndEnd({
        start: textEditor.selection.start,
        end: textEditor.selection.end,
        textEditor,
    });
    const session = createRewriteSession(textEditor, selectionRange);

    if (!session.beforeText) {
        return window.showInformationMessage('No code available for shadow rewriting.');
    }

    edit.delete(selectionRange);
    shadowSessionMap.set(editorKey, session);
    isWritingCodeMap.set(editorKey, true);
    isWriteCodePauseMap.set(editorKey, false);
    updateShadowContext();
    window.showInformationMessage('shadow Rewriting started. Press Esc to exit.');
}

function exitShadowRewrite() {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return;
    }

    const editorKey = getEditorKey(textEditor);
    if (!shadowSessionMap.has(editorKey)) {
        return;
    }

    clearShadowSession(editorKey);
    window.showInformationMessage('shadow Rewriting stopped.');
}

function closeWriteCode(
    _textEditor: TextEditor,
    _edit: TextEditorEdit,
    ..._args: any[]
) {
    clearAllShadowSessions();
    isWriteCodePauseMap.clear();
    isWritingCodeMap.clear();
    commands.executeCommand('workbench.action.reloadWindow');
}

function pauseWriteCode(
    textEditor: TextEditor,
    _edit: TextEditorEdit,
    ..._args: any[]
) {
    const editorKey = getEditorKey(textEditor);
    if (!isWritingCodeMap.get(editorKey)) {
        return window.showInformationMessage('rewriteCode not run,cannot pause.');
    }
    isWriteCodePauseMap.set(editorKey, !isWriteCodePauseMap.get(editorKey));
    showPauseinfo(textEditor);
}

async function switchWriteMode(
    _textEditor: TextEditor,
    _edit: TextEditorEdit,
    ..._args: any[]
) {
    let nowRewriteMode = getRewriteMode();
    if (nowRewriteMode === RewriteMode.Once) {
        nowRewriteMode = RewriteMode.Cycle;
    } else {
        nowRewriteMode = RewriteMode.Once;
    }
    await setRewriteMode(nowRewriteMode);
    window.showInformationMessage('switch to :' + getRewriteMode());
}

async function handleShadowType(args: { text?: string }) {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
    }

    const editorKey = getEditorKey(textEditor);
    const shadowSession = shadowSessionMap.get(editorKey);

    if (!shadowSession || isWriteCodePauseMap.get(editorKey)) {
        return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
    }

    if (textEditor.document.isClosed) {
        clearShadowSession(editorKey);
        return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
    }

    if (shadowSession.index >= shadowSession.beforeText.length) {
        if (getRewriteMode() === RewriteMode.Cycle) {
            await resetRewriteSession(textEditor, shadowSession);
        } else {
            clearShadowSession(editorKey);
            return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
        }
    }

    const typedText = typeof args.text === 'string' ? args.text : '';
    if (!typedText) {
        return;
    }

    if (!canShadowTypeAdvance(typedText, shadowSession)) {
        return;
    }

    let isEdited = false;
    if (shouldStepOverClosingCharacter(textEditor, shadowSession)) {
        isEdited = stepOverClosingCharacter(textEditor, shadowSession);
    } else if (canUseAutoClosingPair(shadowSession)) {
        isEdited = await typeAutoClosingCharacter(textEditor, shadowSession);
    } else {
        isEdited = await writeNextTargetChunk(textEditor, shadowSession);
    }

    if (!isEdited) {
        return;
    }

    if (shadowSession.index >= shadowSession.beforeText.length
        && getRewriteMode() === RewriteMode.Once) {
        clearShadowSession(editorKey);
    }
}

async function handleShadowDeleteLeft() {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return;
    }

    const shadowSession = shadowSessionMap.get(getEditorKey(textEditor));
    if (!shadowSession) {
        return;
    }

    await deleteShadowOverflow(textEditor, shadowSession);
}

export function activate(context: ExtensionContext) {
    const textEditorCommandMap = [
        {
            command: 'extension.swimming.rewriteCode',
            callback: rewriteCode,
        },
        {
            command: 'extension.swimming.shadowRewriteCode',
            callback: shadowRewriteCode,
        },
        {
            command: 'extension.swimming.closeWriteCode',
            callback: closeWriteCode,
        },
        {
            command: 'extension.swimming.pauseWriteCode',
            callback: pauseWriteCode,
        },
        {
            command: 'extension.swimming.switchWriteMode',
            callback: switchWriteMode,
        },
    ];

    updateShadowContext();

    context.subscriptions.push(
        ...textEditorCommandMap.map(({ command, callback }) => {
            return commands.registerTextEditorCommand(command, callback);
        }),
        commands.registerCommand('extension.swimming.exitShadowRewrite', exitShadowRewrite),
        commands.registerCommand(SHADOW_DELETE_LEFT_COMMAND, handleShadowDeleteLeft),
        commands.registerCommand(TYPE_COMMAND, handleShadowType)
    );
}

export function deactivate() {}
