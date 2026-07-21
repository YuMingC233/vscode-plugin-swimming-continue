import {
    CancellationToken,
    commands,
    ExtensionContext,
    InlineCompletionContext,
    InlineCompletionItem,
    InlineCompletionItemProvider,
    languages,
    l10n,
    Position,
    Range,
    Selection,
    TabInputText,
    TextEditor,
    TextEditorEdit,
    TextEditorRevealType,
    TextDocument,
    window,
    workspace,
} from 'vscode';
import {
    canUseGenericShadowTyping as canUseGenericShadowTypingPolicy,
    commitShadowSessionEdit,
    getCurrentShadowLineRemainder,
    getGhostTextForCursor,
    getShadowInputCharacters,
    isShadowPrefixAligned as isTargetPrefixAligned,
    KeyedAsyncQueue,
} from './shadowInline';
import {
    getLookWhileTypingAction,
    getLookWhileTypingScrollLine,
    isLookWhileTypingTarget,
} from './lookWhileTyping';

const TYPE_COMMAND = 'type';
const DEFAULT_TYPE_COMMAND = 'default:type';
const SHADOW_CONTEXT = 'vscodePluginSwimming.shadowActive';
const SHADOW_DELETE_LEFT_COMMAND = 'extension.swimming.shadowDeleteLeft';
const SHADOW_ENTER_COMMAND = 'extension.swimming.shadowEnter';
const SHADOW_TAB_COMMAND = 'extension.swimming.shadowTab';
const LOOK_WHILE_TYPING_CONTEXT = 'vscodePluginSwimming.lookWhileTypingTargetVisible';
const LOOK_WHILE_TYPING_TARGET_STATE_KEY = 'lookWhileTyping.target';
const LOOK_WHILE_TYPING_SELECT_TARGET_COMMAND = 'extension.swimming.selectLookWhileTypingTarget';
const LOOK_WHILE_TYPING_CLEAR_TARGET_COMMAND = 'extension.swimming.clearLookWhileTypingTarget';
const LOOK_WHILE_TYPING_SCROLL_UP_COMMAND = 'extension.swimming.scrollLookWhileTypingUp';
const LOOK_WHILE_TYPING_SCROLL_DOWN_COMMAND = 'extension.swimming.scrollLookWhileTypingDown';
const LOOK_WHILE_TYPING_CLOSE_TARGET_COMMAND = 'extension.swimming.closeLookWhileTypingTarget';
const INLINE_SUGGEST_TRIGGER_COMMAND = 'editor.action.inlineSuggest.trigger';
const INLINE_SUGGEST_HIDE_COMMAND = 'editor.action.inlineSuggest.hide';

type RewriteSession = {
    beforeText: string;
    index: number;
    line: number;
    character: number;
    initLine: number;
    initCharacter: number;
};

type LookWhileTypingTarget = {
    documentUri: string;
    viewColumn: number | undefined;
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

function getShadowShowInlineSuggestion() {
    const showInlineSuggestion = workspace
        .getConfiguration()
        .get<boolean>('vscodePluginSwimming.shadowShowInlineSuggestion');

    return typeof showInlineSuggestion === 'boolean' ? showInlineSuggestion : true;
}

function getShadowRequireManualLineBreaksAndIndentation() {
    const requireManualLineBreaks = workspace
        .getConfiguration()
        .get<boolean>('vscodePluginSwimming.shadowRequireManualLineBreaksAndIndentation');

    return typeof requireManualLineBreaks === 'boolean' ? requireManualLineBreaks : false;
}

function getLookWhileTypingStepLines() {
    const configuredStepLines = workspace
        .getConfiguration()
        .get<number>('vscodePluginSwimming.lookWhileTypingStepLines');

    return typeof configuredStepLines === 'number' ? configuredStepLines : 3;
}

function getLookWhileTypingControlKey(
    configurationKey: string,
    fallbackKey: string
) {
    const configuredKey = workspace
        .getConfiguration()
        .get<string>(configurationKey);

    return typeof configuredKey === 'string' && [...configuredKey].length === 1
        ? configuredKey
        : fallbackKey;
}

function getLookWhileTypingControls() {
    return {
        scrollUpKey: getLookWhileTypingControlKey(
            'vscodePluginSwimming.lookWhileTypingScrollUpKey',
            '-'
        ),
        scrollDownKey: getLookWhileTypingControlKey(
            'vscodePluginSwimming.lookWhileTypingScrollDownKey',
            '='
        ),
        closeTargetKey: getLookWhileTypingControlKey(
            'vscodePluginSwimming.lookWhileTypingCloseTargetKey',
            '\\'
        ),
    };
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
const shadowInputQueue = new KeyedAsyncQueue();
let lookWhileTypingTarget: LookWhileTypingTarget | undefined;
let inlineSuggestionRefreshTimer: NodeJS.Timeout | undefined;

function getEditorKey(textEditor: TextEditor) {
    return textEditor.document.uri.toString();
}

function getLookWhileTypingTargetEditor() {
    if (!lookWhileTypingTarget) {
        return undefined;
    }

    return window.visibleTextEditors.find((textEditor) => {
        return getEditorKey(textEditor) === lookWhileTypingTarget?.documentUri
            && textEditor.viewColumn === lookWhileTypingTarget?.viewColumn;
    });
}

function updateLookWhileTypingContext() {
    void commands.executeCommand(
        'setContext',
        LOOK_WHILE_TYPING_CONTEXT,
        Boolean(getLookWhileTypingTargetEditor())
    );
}

async function selectLookWhileTypingTarget(context: ExtensionContext) {
    const activeTextEditor = window.activeTextEditor;
    const targetEditors = window.visibleTextEditors.filter((textEditor) => {
        return textEditor !== activeTextEditor;
    });

    if (!targetEditors.length) {
        return window.showWarningMessage(
            l10n.t('Open the working file beside the typing editor before selecting it.')
        );
    }

    const selectedTarget = await window.showQuickPick(
        targetEditors.map((textEditor) => {
            return {
                label: workspace.asRelativePath(textEditor.document.uri, false),
                description: l10n.t(
                    'Editor group {0}',
                    textEditor.viewColumn ?? l10n.t('unknown')
                ),
                textEditor,
            };
        }),
        { placeHolder: l10n.t('Select the editor to scroll while you type.') }
    );

    if (!selectedTarget) {
        return;
    }

    lookWhileTypingTarget = {
        documentUri: getEditorKey(selectedTarget.textEditor),
        viewColumn: selectedTarget.textEditor.viewColumn,
    };
    await context.workspaceState.update(
        LOOK_WHILE_TYPING_TARGET_STATE_KEY,
        lookWhileTypingTarget
    );
    updateLookWhileTypingContext();
    return window.showInformationMessage(l10n.t('Look While Typing target selected.'));
}

async function clearLookWhileTypingTarget(context: ExtensionContext) {
    lookWhileTypingTarget = undefined;
    await context.workspaceState.update(LOOK_WHILE_TYPING_TARGET_STATE_KEY, undefined);
    updateLookWhileTypingContext();
}

function scrollLookWhileTyping(direction: -1 | 1) {
    const targetTextEditor = getLookWhileTypingTargetEditor();
    if (!targetTextEditor) {
        updateLookWhileTypingContext();
        return;
    }

    const visibleRange = targetTextEditor.visibleRanges[0];
    if (!visibleRange) {
        return;
    }

    const targetLine = getLookWhileTypingScrollLine({
        firstVisibleLine: visibleRange.start.line,
        lastVisibleLine: visibleRange.end.line,
        lineCount: targetTextEditor.document.lineCount,
        direction,
        stepLines: getLookWhileTypingStepLines(),
    });
    const targetPosition = new Position(targetLine, 0);
    targetTextEditor.revealRange(
        new Range(targetPosition, targetPosition),
        TextEditorRevealType.InCenter
    );
}

function getLookWhileTypingTargetTab() {
    const target = lookWhileTypingTarget;
    if (!target) {
        return undefined;
    }

    const targetTabGroup = window.tabGroups.all.find((tabGroup) => {
        return tabGroup.viewColumn === target.viewColumn;
    });

    return targetTabGroup?.tabs.find((tab) => {
        if (!(tab.input instanceof TabInputText)) {
            return false;
        }

        return isLookWhileTypingTarget({
            documentUri: tab.input.uri.toString(),
            viewColumn: tab.group.viewColumn,
        }, target);
    });
}

async function closeLookWhileTypingTarget(context: ExtensionContext) {
    const targetTab = getLookWhileTypingTargetTab();
    if (!targetTab) {
        updateLookWhileTypingContext();
        return;
    }

    const isClosed = await window.tabGroups.close(targetTab, true);
    if (isClosed) {
        await clearLookWhileTypingTarget(context);
    }
}

async function handleLookWhileTypingInput(
    context: ExtensionContext,
    typedText: string
) {
    if (!getLookWhileTypingTargetEditor()) {
        return false;
    }

    const action = getLookWhileTypingAction(typedText, getLookWhileTypingControls());
    if (action === 'scrollUp') {
        scrollLookWhileTyping(-1);
        return true;
    }
    if (action === 'scrollDown') {
        scrollLookWhileTyping(1);
        return true;
    }
    if (action === 'closeTarget') {
        await closeLookWhileTypingTarget(context);
        return true;
    }

    return false;
}

function updateShadowContext() {
    void commands.executeCommand('setContext', SHADOW_CONTEXT, shadowSessionMap.size > 0);
}

function refreshInlineSuggestion() {
    if (inlineSuggestionRefreshTimer) {
        clearTimeout(inlineSuggestionRefreshTimer);
        inlineSuggestionRefreshTimer = undefined;
    }

    if (getShadowShowInlineSuggestion()) {
        inlineSuggestionRefreshTimer = setTimeout(() => {
            inlineSuggestionRefreshTimer = undefined;
            void commands.executeCommand(INLINE_SUGGEST_TRIGGER_COMMAND);
        }, 0);
        return;
    }

    void commands.executeCommand(INLINE_SUGGEST_HIDE_COMMAND);
}

function finishWriting(editorKey: string) {
    isWritingCodeMap.set(editorKey, false);
    isWriteCodePauseMap.delete(editorKey);
}

function clearShadowSession(editorKey: string) {
    shadowSessionMap.delete(editorKey);
    finishWriting(editorKey);
    updateShadowContext();
    refreshInlineSuggestion();
}

function clearAllShadowSessions() {
    for (const editorKey of shadowSessionMap.keys()) {
        finishWriting(editorKey);
    }
    shadowSessionMap.clear();
    updateShadowContext();
    refreshInlineSuggestion();
}

function showPauseinfo(textEditor: TextEditor) {
    if (isWriteCodePauseMap.get(getEditorKey(textEditor))) {
        window.showInformationMessage(l10n.t('Code rewriting is paused.'));
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

function getSessionStartPosition(session: RewriteSession) {
    return new Position(session.initLine, session.initCharacter);
}

function setEditorCursor(textEditor: TextEditor, position: Position) {
    textEditor.selection = new Selection(position, position);
}

function resetRewriteSession(textEditor: TextEditor, session: RewriteSession) {
    const writtenRange = getWrittenRange(session);
    return textEditor.edit((editBuilder) => {
        editBuilder.delete(writtenRange);
    }).then((isEdited) => {
        if (isEdited) {
            session.index = 0;
            session.line = session.initLine;
            session.character = session.initCharacter;
            setEditorCursor(textEditor, getSessionPosition(session));
        }
        return isEdited;
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
    const nowPosition = revealCurrentPosition(textEditor, session);
    let targetText = session.beforeText[session.index];

    if (session.beforeText.startsWith('\r\n', session.index)) {
        targetText = '\r\n';
    } else if (session.beforeText.startsWith('\n', session.index)) {
        targetText = '\n';
    }

    return textEditor.edit((editBuilder) => {
        editBuilder.insert(nowPosition, targetText);
    }).then((isEdited) => {
        if (commitShadowSessionEdit(session, targetText, isEdited)) {
            setEditorCursor(textEditor, getSessionPosition(session));
        }
        return isEdited;
    });
}

function isSymbolCharacter(text: string) {
    return text.length > 0 && !/^[\p{L}\p{N}_\s]$/u.test(text);
}

function getExpectedShadowPrefix(session: RewriteSession) {
    return session.beforeText.slice(0, session.index);
}

function getCurrentShadowLineIndentationRemainder(session: RewriteSession) {
    const currentLineRemainder = getCurrentShadowLineRemainder(session);
    const indentationMatch = currentLineRemainder.match(/^[\t ]+/);
    return indentationMatch ? indentationMatch[0] : '';
}

function getShadowCursorOffset(textEditor: TextEditor, session: RewriteSession) {
    return textEditor.document.offsetAt(getSessionPosition(session));
}

function getActualShadowPrefix(textEditor: TextEditor, session: RewriteSession) {
    const startPosition = getSessionStartPosition(session);
    const actualPosition = textEditor.selection.active;

    if (textEditor.document.offsetAt(actualPosition) < textEditor.document.offsetAt(startPosition)) {
        return '';
    }

    return textEditor.document.getText(new Range(startPosition, actualPosition));
}

function getActualShadowPrefixAtSessionPosition(
    textEditor: TextEditor,
    session: RewriteSession
) {
    return textEditor.document.getText(new Range(
        getSessionStartPosition(session),
        getSessionPosition(session)
    ));
}

function isExpectingLineBreak(session: RewriteSession) {
    return session.beforeText.startsWith('\r\n', session.index)
        || session.beforeText.startsWith('\n', session.index);
}

function getCurrentLineIndentUnit(textEditor: TextEditor, session: RewriteSession) {
    const indentationRemainder = getCurrentShadowLineIndentationRemainder(session);
    if (!indentationRemainder) {
        return '';
    }

    if (indentationRemainder[0] === '\t') {
        return '\t';
    }

    const tabSizeOption = textEditor.options.tabSize;
    const tabSize = typeof tabSizeOption === 'number' ? tabSizeOption : 4;
    if (indentationRemainder.length < tabSize) {
        return '';
    }

    return indentationRemainder.slice(0, tabSize);
}

function requiresManualIndentation(textEditor: TextEditor, session: RewriteSession) {
    if (!getShadowRequireManualLineBreaksAndIndentation()) {
        return false;
    }

    return getCurrentLineIndentUnit(textEditor, session).length > 0;
}

function hasShadowOverflow(textEditor: TextEditor, session: RewriteSession) {
    const expectedPrefix = getExpectedShadowPrefix(session);
    const actualPrefix = getActualShadowPrefix(textEditor, session);
    return actualPrefix.startsWith(expectedPrefix) && actualPrefix.length > expectedPrefix.length;
}

function isShadowPrefixAligned(textEditor: TextEditor, session: RewriteSession) {
    return isTargetPrefixAligned(session, getActualShadowPrefix(textEditor, session));
}

function canAdvanceShadowSession(textEditor: TextEditor, session: RewriteSession) {
    return isShadowPrefixAligned(textEditor, session)
        && textEditor.document.offsetAt(textEditor.selection.active) === getShadowCursorOffset(textEditor, session);
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

function insertTargetText(textEditor: TextEditor, session: RewriteSession, targetText: string) {
    if (!targetText) {
        return Promise.resolve(false);
    }

    const nowPosition = revealCurrentPosition(textEditor, session);
    return textEditor.edit((editBuilder) => {
        editBuilder.insert(nowPosition, targetText);
    }).then((isEdited) => {
        if (commitShadowSessionEdit(session, targetText, isEdited)) {
            setEditorCursor(textEditor, getSessionPosition(session));
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

function showShadowOutOfSyncMessage(textEditor: TextEditor, session: RewriteSession) {
    if (hasShadowOverflow(textEditor, session)) {
        return window.showWarningMessage(
            l10n.t(
                'Shadow Rewriting detected extra characters. Press Backspace to clean them before continuing.'
            )
        );
    }

    return window.showWarningMessage(
        l10n.t(
            'Shadow Rewriting is out of sync with the target text. Stop and restart this session if needed.'
        )
    );
}

function canUseGenericShadowTyping(textEditor: TextEditor, session: RewriteSession) {
    return canUseGenericShadowTypingPolicy({
        requiresManualProgression: getShadowRequireManualLineBreaksAndIndentation(),
        isExpectingLineBreak: isExpectingLineBreak(session),
        requiresManualIndentation: requiresManualIndentation(textEditor, session),
    });
}

async function advanceShadowWithTypedInput(
    textEditor: TextEditor,
    shadowSession: RewriteSession,
    typedText: string
) {

    if (!canAdvanceShadowSession(textEditor, shadowSession)) {
        return;
    }

    if (!canUseGenericShadowTyping(textEditor, shadowSession)) {
        return;
    }

    if (!canShadowTypeAdvance(typedText, shadowSession)) {
        return;
    }

    const isEdited = await writeNextTargetChunk(textEditor, shadowSession);
    if (!isEdited) {
        return;
    }

    refreshInlineSuggestion();
}

function completeShadowSessionIfNeeded(editorKey: string, shadowSession: RewriteSession) {
    if (shadowSession.index >= shadowSession.beforeText.length
        && getRewriteMode() === RewriteMode.Once) {
        clearShadowSession(editorKey);
    }
}

async function handleShadowLineBreak(textEditor: TextEditor, shadowSession: RewriteSession) {
    if (!canAdvanceShadowSession(textEditor, shadowSession)) {
        return showShadowOutOfSyncMessage(textEditor, shadowSession);
    }

    if (!isExpectingLineBreak(shadowSession)) {
        return;
    }

    const isEdited = await writeNextTargetChunk(textEditor, shadowSession);
    if (!isEdited) {
        return;
    }

    refreshInlineSuggestion();
}

async function handleShadowIndentation(textEditor: TextEditor, shadowSession: RewriteSession) {
    if (!canAdvanceShadowSession(textEditor, shadowSession)) {
        return showShadowOutOfSyncMessage(textEditor, shadowSession);
    }

    const indentUnit = getCurrentLineIndentUnit(textEditor, shadowSession);
    if (!indentUnit) {
        return;
    }

    const isEdited = await insertTargetText(textEditor, shadowSession, indentUnit);
    if (!isEdited) {
        return;
    }

    refreshInlineSuggestion();
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
        return window.showInformationMessage(l10n.t('Code rewriting is already in progress.'));
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
        return window.showInformationMessage(l10n.t('Code rewriting is already in progress.'));
    }

    const selectionRange = getSelectionRangeByStartAndEnd({
        start: textEditor.selection.start,
        end: textEditor.selection.end,
        textEditor,
    });
    const session = createRewriteSession(textEditor, selectionRange);

    if (!session.beforeText) {
        return window.showInformationMessage(l10n.t('No code available for Shadow Rewriting.'));
    }

    edit.delete(selectionRange);
    shadowSessionMap.set(editorKey, session);
    isWritingCodeMap.set(editorKey, true);
    isWriteCodePauseMap.set(editorKey, false);
    updateShadowContext();
    refreshInlineSuggestion();
    window.showInformationMessage(l10n.t('Shadow Rewriting started. Press Esc to exit.'));
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
    window.showInformationMessage(l10n.t('Shadow Rewriting stopped.'));
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
        return window.showInformationMessage(
            l10n.t('Code rewriting is not active, so it cannot be paused.')
        );
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
    window.showInformationMessage(l10n.t('Switched to {0} mode.', getRewriteMode()));
}

async function handleShadowType(
    context: ExtensionContext,
    args: { text?: string }
) {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
    }

    const typedText = typeof args.text === 'string' ? args.text : '';
    if (!typedText) {
        return;
    }

    if (await handleLookWhileTypingInput(context, typedText)) {
        return;
    }

    const editorKey = getEditorKey(textEditor);
    const shadowSession = shadowSessionMap.get(editorKey);

    if (!shadowSession || isWriteCodePauseMap.get(editorKey)) {
        return commands.executeCommand(DEFAULT_TYPE_COMMAND, args);
    }

    return shadowInputQueue.enqueue(editorKey, async () => {
        if (shadowSessionMap.get(editorKey) !== shadowSession
            || isWriteCodePauseMap.get(editorKey)) {
            return;
        }

        if (textEditor.document.isClosed) {
            clearShadowSession(editorKey);
            return;
        }

        const typedCharacters = getShadowInputCharacters(typedText);
        for (let index = 0; index < typedCharacters.length; index += 1) {
            if (shadowSessionMap.get(editorKey) !== shadowSession) {
                return;
            }

            if (shadowSession.index >= shadowSession.beforeText.length) {
                if (getRewriteMode() === RewriteMode.Cycle) {
                    const isReset = await resetRewriteSession(textEditor, shadowSession);
                    if (!isReset) {
                        return;
                    }
                } else {
                    clearShadowSession(editorKey);
                    const remainingText = typedCharacters.slice(index).join('');
                    return commands.executeCommand(DEFAULT_TYPE_COMMAND, { text: remainingText });
                }
            }

            await advanceShadowWithTypedInput(
                textEditor,
                shadowSession,
                typedCharacters[index]
            );
            completeShadowSessionIfNeeded(editorKey, shadowSession);
        }
    });
}

async function handleShadowDeleteLeft() {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return;
    }

    const editorKey = getEditorKey(textEditor);
    const shadowSession = shadowSessionMap.get(editorKey);
    if (!shadowSession) {
        return;
    }

    return shadowInputQueue.enqueue(editorKey, async () => {
        if (shadowSessionMap.get(editorKey) !== shadowSession
            || !hasShadowOverflow(textEditor, shadowSession)) {
            return;
        }

        await deleteShadowOverflow(textEditor, shadowSession);
        refreshInlineSuggestion();
    });
}

async function handleShadowEnter() {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return;
    }

    const editorKey = getEditorKey(textEditor);
    const shadowSession = shadowSessionMap.get(editorKey);
    if (!shadowSession) {
        return;
    }

    return shadowInputQueue.enqueue(editorKey, async () => {
        if (shadowSessionMap.get(editorKey) !== shadowSession) {
            return;
        }

        if (!getShadowRequireManualLineBreaksAndIndentation()) {
            await advanceShadowWithTypedInput(textEditor, shadowSession, '\n');
            completeShadowSessionIfNeeded(editorKey, shadowSession);
            return;
        }

        await handleShadowLineBreak(textEditor, shadowSession);
        completeShadowSessionIfNeeded(editorKey, shadowSession);
    });
}

async function handleShadowTab() {
    const textEditor = window.activeTextEditor;
    if (!textEditor) {
        return;
    }

    const editorKey = getEditorKey(textEditor);
    const shadowSession = shadowSessionMap.get(editorKey);
    if (!shadowSession) {
        return;
    }

    return shadowInputQueue.enqueue(editorKey, async () => {
        if (shadowSessionMap.get(editorKey) !== shadowSession) {
            return;
        }

        if (!getShadowRequireManualLineBreaksAndIndentation()) {
            await advanceShadowWithTypedInput(textEditor, shadowSession, '\t');
            completeShadowSessionIfNeeded(editorKey, shadowSession);
            return;
        }

        await handleShadowIndentation(textEditor, shadowSession);
        completeShadowSessionIfNeeded(editorKey, shadowSession);
    });
}

const shadowInlineCompletionProvider: InlineCompletionItemProvider = {
    provideInlineCompletionItems(
        document: TextDocument,
        position: Position,
        _context: InlineCompletionContext,
        _token: CancellationToken
    ) {
        if (!getShadowShowInlineSuggestion()) {
            return [];
        }

        const textEditor = window.activeTextEditor;
        if (!textEditor || textEditor.document.uri.toString() !== document.uri.toString()) {
            return [];
        }

        const shadowSession = shadowSessionMap.get(getEditorKey(textEditor));
        if (!shadowSession || isWriteCodePauseMap.get(getEditorKey(textEditor))) {
            return [];
        }

        const actualPrefix = getActualShadowPrefixAtSessionPosition(textEditor, shadowSession);
        if (!isTargetPrefixAligned(shadowSession, actualPrefix)) {
            return [];
        }

        const currentLineRemainder = getGhostTextForCursor(shadowSession, position);
        if (!currentLineRemainder) {
            return [];
        }

        const inlineItem = new InlineCompletionItem(
            currentLineRemainder,
            new Range(position, position)
        );

        return [inlineItem];
    },
};

function registerShadowInlineCompletionProvider() {
    const selectors = [
        { scheme: 'file' },
        { scheme: 'untitled' },
    ];

    return languages.registerInlineCompletionItemProvider(
        selectors,
        shadowInlineCompletionProvider
    );
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

    lookWhileTypingTarget = context.workspaceState.get<LookWhileTypingTarget>(
        LOOK_WHILE_TYPING_TARGET_STATE_KEY
    );
    updateShadowContext();
    updateLookWhileTypingContext();

    context.subscriptions.push(
        registerShadowInlineCompletionProvider(),
        window.onDidChangeVisibleTextEditors(updateLookWhileTypingContext),
        ...textEditorCommandMap.map(({ command, callback }) => {
            return commands.registerTextEditorCommand(command, callback);
        }),
        commands.registerCommand('extension.swimming.exitShadowRewrite', exitShadowRewrite),
        commands.registerCommand(
            LOOK_WHILE_TYPING_SELECT_TARGET_COMMAND,
            () => selectLookWhileTypingTarget(context)
        ),
        commands.registerCommand(
            LOOK_WHILE_TYPING_CLEAR_TARGET_COMMAND,
            () => clearLookWhileTypingTarget(context)
        ),
        commands.registerCommand(
            LOOK_WHILE_TYPING_SCROLL_UP_COMMAND,
            () => scrollLookWhileTyping(-1)
        ),
        commands.registerCommand(
            LOOK_WHILE_TYPING_SCROLL_DOWN_COMMAND,
            () => scrollLookWhileTyping(1)
        ),
        commands.registerCommand(
            LOOK_WHILE_TYPING_CLOSE_TARGET_COMMAND,
            () => closeLookWhileTypingTarget(context)
        ),
        commands.registerCommand(SHADOW_DELETE_LEFT_COMMAND, handleShadowDeleteLeft),
        commands.registerCommand(SHADOW_ENTER_COMMAND, handleShadowEnter),
        commands.registerCommand(SHADOW_TAB_COMMAND, handleShadowTab),
        commands.registerCommand(TYPE_COMMAND, (args) => handleShadowType(context, args))
    );
}

export function deactivate() {}
