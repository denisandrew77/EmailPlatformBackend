import { ZodError } from "zod";

export class RangeBuddyError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const checkDatabaseError = (error) => {
    if (!error) return;
    const sessionErrors = {
        RB_NO_ACTIVE_SESSION: [409, "Start a session from the admin portal before adding fuel entries"],
        RB_SESSION_ALREADY_ACTIVE: [409, "A session is already active for this van"],
        RB_SESSION_NOT_CURRENT: [409, "This session is no longer the current session"],
        RB_SESSION_START_KMS: [400, "start_kms must be at least the van's last_kms"],
    };
    if (["PT400", "PT409"].includes(error.code) && sessionErrors[error.message]) {
        const [status, message] = sessionErrors[error.message];
        throw new RangeBuddyError(status, message, error.message);
    }
    if (error.code === "PT401" && error.message === "RB_INVALID_CODE") {
        throw new RangeBuddyError(401, "Invalid or expired activation code", "RB_INVALID_CODE");
    }
    if (error.code === "PT404" && error.message === "RB_ENTRY_NOT_FOUND") {
        throw new RangeBuddyError(404, "Fuel entry not found", "RB_ENTRY_NOT_FOUND");
    }
    const messages = {
        PT400: [400, error.message === "RB_ODOMETER_NOT_INCREASING"
            ? "current_kms must be strictly greater than the van's last_kms" : "Invalid RangeBuddy input"],
        PT401: [401, "Invalid device token"],
        PT404: [404, "Van not found"],
        "23505": [409, "Licence plate already in use or activation conflict"],
        "23503": [400, "Invalid van reference"],
        "23514": [400, "Invalid RangeBuddy input"],
        PGRST202: [503, "RangeBuddy database functions are not installed"],
        "42883": [503, "RangeBuddy database functions are not installed"],
        "42P01": [503, "RangeBuddy tables are not installed"],
        "": [503, "RangeBuddy database unavailable"],
    };
    const [status, message] = messages[error.code] || [500, "Unable to complete the RangeBuddy request"];
    throw new RangeBuddyError(status, message);
};

export const rangeBuddyErrorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
    }
    if (error.type === "entity.too.large") {
        return res.status(413).json({ error: "Request body is too large" });
    }
    if (error instanceof RangeBuddyError) {
        return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    if (error instanceof ZodError) {
        return res.status(400).json({
            error: "Invalid request",
            fields: error.issues.map(({ path, message }) => ({ field: path.join("."), message })),
        });
    }
    // Database errors can contain SQL and parameters. Never serialize them.
    return res.status(500).json({ error: "Unable to complete the RangeBuddy request" });
};
