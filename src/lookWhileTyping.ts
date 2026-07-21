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
