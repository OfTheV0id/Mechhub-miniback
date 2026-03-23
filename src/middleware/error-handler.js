function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    const statusCode = err.statusCode || 500;
    const message =
        statusCode >= 500 && !err.expose
            ? "Internal server error"
            : err.message || "Request failed";

    return res.status(statusCode).json({ message });
}

module.exports = {
    errorHandler,
};
