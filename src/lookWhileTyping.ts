export type LookWhileTypingScrollRequest = {
    firstVisibleLine: number;
    lastVisibleLine: number;
    lineCount: number;
    direction: -1 | 1;
    stepLines: number;
};

export type LookWhileTypingTargetReference = {
    documentUri: string;
    viewColumn: number | undefined;
};

export type LookWhileTypingDocumentRename = {
    oldUri: string;
    newUri: string;
};

export type LookWhileTypingControls = {
    scrollUpKey: string;
    scrollDownKey: string;
    closeTargetKey: string;
    reopenTargetKey: string;
};

export type LookWhileTypingAction = 'scrollUp' | 'scrollDown' | 'closeTarget' | 'reopenTarget';

export function getLookWhileTypingAction(
    typedText: string,
    controls: LookWhileTypingControls
) {
    const matchingActions: LookWhileTypingAction[] = [];

    if (typedText === controls.scrollUpKey) {
        matchingActions.push('scrollUp');
    }
    if (typedText === controls.scrollDownKey) {
        matchingActions.push('scrollDown');
    }
    if (typedText === controls.closeTargetKey) {
        matchingActions.push('closeTarget');
    }
    if (typedText === controls.reopenTargetKey) {
        matchingActions.push('reopenTarget');
    }

    return matchingActions.length === 1 ? matchingActions[0] : undefined;
}

export function getLookWhileTypingLabelPattern(relativePath: string) {
    return `**/${relativePath.replaceAll('\\', '/')}`;
}

export function getLookWhileTypingTargetLabel(
    relativePath: string,
    customLabel: string | undefined
) {
    return customLabel || relativePath;
}

export function getLookWhileTypingRenamedDocumentUri(
    documentUri: string,
    renames: LookWhileTypingDocumentRename[]
) {
    let renamedDocumentUri = documentUri;
    let hasChanged = false;

    for (const { oldUri, newUri } of renames) {
        if (renamedDocumentUri === oldUri) {
            renamedDocumentUri = newUri;
            hasChanged = true;
        } else if (renamedDocumentUri.startsWith(`${oldUri}/`)) {
            renamedDocumentUri = `${newUri}${renamedDocumentUri.slice(oldUri.length)}`;
            hasChanged = true;
        }
    }

    return hasChanged ? renamedDocumentUri : undefined;
}

export function isLookWhileTypingTarget(
    candidate: LookWhileTypingTargetReference,
    target: LookWhileTypingTargetReference
) {
    return candidate.documentUri === target.documentUri
        && candidate.viewColumn === target.viewColumn;
}

export function getLookWhileTypingScrollLine({
    firstVisibleLine,
    lastVisibleLine,
    lineCount,
    direction,
    stepLines,
}: LookWhileTypingScrollRequest) {
    if (lineCount <= 0) {
        return 0;
    }

    const lastDocumentLine = lineCount - 1;
    const firstLine = Math.min(Math.max(firstVisibleLine, 0), lastDocumentLine);
    const lastLine = Math.min(Math.max(lastVisibleLine, firstLine), lastDocumentLine);
    const visibleCenterLine = Math.floor((firstLine + lastLine) / 2);
    const normalizedStepLines = Math.max(1, Math.floor(stepLines));
    const nextLine = visibleCenterLine + direction * normalizedStepLines;

    return Math.min(Math.max(nextLine, 0), lastDocumentLine);
}
