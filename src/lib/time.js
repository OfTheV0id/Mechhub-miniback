const SQLITE_NOW_ISO_EXPRESSION = `STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function toIsoTimestamp(value) {
    if (typeof value !== "string") {
        return value;
    }

    let normalizedValue = value.trim();

    if (!normalizedValue) {
        return normalizedValue;
    }

    if (normalizedValue.includes(" ")) {
        normalizedValue = normalizedValue.replace(" ", "T");
    }

    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedValue)) {
        normalizedValue = `${normalizedValue}Z`;
    }

    const parsedDate = new Date(normalizedValue);

    if (Number.isNaN(parsedDate.getTime())) {
        return normalizedValue;
    }

    return parsedDate.toISOString();
}

module.exports = {
    SQLITE_NOW_ISO_EXPRESSION,
    toIsoTimestamp,
};
