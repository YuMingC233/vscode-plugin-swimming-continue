export type ShadowInlineSession = {
    beforeText: string;
    index: number;
    line: number;
    character: number;
};

export type ShadowCursor = {
    line: number;
    character: number;
};

export type ShadowGenericTypingPolicy = {
    requiresManualProgression: boolean;
    isExpectingLineBreak: boolean;
    requiresManualIndentation: boolean;
};

export function advanceShadowSession(
    session: ShadowInlineSession,
    insertedText: string
) {
    session.index += insertedText.length;

    const insertedLines = insertedText.split(/\r?\n/);
    if (insertedLines.length === 1) {
        session.character += insertedText.length;
        return;
    }

    session.line += insertedLines.length - 1;
    session.character = insertedLines[insertedLines.length - 1].length;
}

export function getCurrentShadowLineRemainder(session: ShadowInlineSession) {
    const fromCurrentLine = session.beforeText.slice(session.index);
    const lineBreakIndex = fromCurrentLine.search(/\r?\n/);
    if (lineBreakIndex === -1) {
        return fromCurrentLine;
    }

    return fromCurrentLine.slice(0, lineBreakIndex);
}

export function getGhostTextForCursor(
    session: ShadowInlineSession,
    cursor: ShadowCursor
) {
    if (session.line !== cursor.line || session.character !== cursor.character) {
        return '';
    }

    return getCurrentShadowLineRemainder(session);
}

export function isShadowPrefixAligned(
    session: ShadowInlineSession,
    actualPrefix: string
) {
    return actualPrefix === session.beforeText.slice(0, session.index);
}

export function canUseGenericShadowTyping(
    policy: ShadowGenericTypingPolicy
) {
    if (!policy.requiresManualProgression) {
        return true;
    }

    return !policy.isExpectingLineBreak && !policy.requiresManualIndentation;
}
