const SYMBOL_REPLACEMENTS = [
    [/\u21D2/g, "\\Rightarrow "],
    [/\u2192/g, "\\to "],
    [/\u2212/g, "-"],
    [/\u2264/g, "\\le "],
    [/\u2265/g, "\\ge "],
    [/\u2260/g, "\\ne "],
    [/\u00D7/g, "\\times "],
    [/\u00B7/g, "\\cdot "],
];

function applySymbolReplacements(value) {
    let normalized = String(value || "").replace(/\r\n/g, "\n");

    for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) {
        normalized = normalized.replace(pattern, replacement);
    }

    return normalized;
}

function normalizeRenderableMessageContent(value) {
    if (typeof value !== "string") {
        return value;
    }

    const normalizer = createMarkdownMathStreamNormalizer();
    return normalizer.pushChunk(value) + normalizer.finish();
}

function normalizeFormulaText(value) {
    return normalizeRenderableMessageContent(value).trim();
}

function normalizeCommentaryText(value) {
    return normalizeRenderableMessageContent(value).trim();
}

function createMarkdownMathStreamNormalizer() {
    let mode = "text";
    let pendingBackticks = "";
    let pendingBackslash = false;

    function normalizeTextChar(char) {
        switch (char) {
            case "\u21D2":
                return "\\Rightarrow ";
            case "\u2192":
                return "\\to ";
            case "\u2212":
                return "-";
            case "\u2264":
                return "\\le ";
            case "\u2265":
                return "\\ge ";
            case "\u2260":
                return "\\ne ";
            case "\u00D7":
                return "\\times ";
            case "\u00B7":
                return "\\cdot ";
            default:
                return char;
        }
    }

    function pushChunk(chunk) {
        const source = String(chunk || "").replace(/\r\n/g, "\n");
        let output = "";

        function resolvePendingBackticks() {
            if (!pendingBackticks) {
                return;
            }

            if (mode === "text") {
                if (pendingBackticks.length >= 3) {
                    output += "```";
                    output += pendingBackticks.slice(3);
                    mode = "fence";
                } else if (pendingBackticks.length === 1) {
                    output += "`";
                    mode = "inline";
                } else {
                    output += pendingBackticks;
                }
            } else if (mode === "inline") {
                if (pendingBackticks.length === 1) {
                    output += "`";
                    mode = "text";
                } else {
                    output += pendingBackticks;
                }
            } else if (mode === "fence") {
                if (pendingBackticks.length >= 3) {
                    output += "```";
                    output += pendingBackticks.slice(3);
                    mode = "text";
                } else {
                    output += pendingBackticks;
                }
            }

            pendingBackticks = "";
        }

        for (const char of source) {
            if (char === "`") {
                if (pendingBackslash) {
                    output += "\\";
                    pendingBackslash = false;
                }
                pendingBackticks += char;
                continue;
            }

            resolvePendingBackticks();

            if (mode === "text") {
                if (pendingBackslash) {
                    if (char === "(" || char === ")") {
                        output += "$";
                    } else if (char === "[" || char === "]") {
                        output += "$$";
                    } else {
                        output += `\\${normalizeTextChar(char)}`;
                    }

                    pendingBackslash = false;
                    continue;
                }

                if (char === "\\") {
                    pendingBackslash = true;
                    continue;
                }

                output += normalizeTextChar(char);
            } else {
                output += char;
            }
        }

        return output;
    }

    function finish() {
        let trailing = "";

        if (pendingBackslash) {
            trailing += "\\";
            pendingBackslash = false;
        }

        if (pendingBackticks) {
            trailing += pendingBackticks;
            pendingBackticks = "";
        }

        return trailing;
    }

    return {
        pushChunk,
        finish,
    };
}

module.exports = {
    createMarkdownMathStreamNormalizer,
    normalizeCommentaryText,
    normalizeFormulaText,
    normalizeRenderableMessageContent,
};
