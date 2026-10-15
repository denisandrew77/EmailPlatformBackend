import { createHash, randomBytes } from "node:crypto";
import { verifyPassword } from "../services/passwordService.js";
import { RangeBuddyError, checkDatabaseError } from "./errors.js";
import { vanColumns } from "./data.js";

export const createDeviceToken = () => randomBytes(32).toString("hex");
export const hashDeviceToken = (token) => createHash("sha256").update(token).digest("hex");

export const verifyAdminPassword = (password) => {
    const storedHash = process.env.RANGEBUDDY_ADMIN_PASSWORD_HASH;
    // Do not permit the existing web password verifier's legacy plaintext fallback.
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(storedHash ?? "")) {
        throw new RangeBuddyError(503, "RangeBuddy admin password hash is not configured correctly");
    }
    if (!verifyPassword(password, storedHash)) throw new RangeBuddyError(401, "Invalid admin password");
};

export const createRangeBuddyAuth = ({ database, requireWebAdmin }) => async (req, res, next) => {
    const authorization = req.get("authorization") || "";
    if (/^RangeBuddy(?:\s|$)/i.test(authorization)) {
        const match = authorization.match(/^RangeBuddy ([a-f0-9]{64})$/i);
        if (!match) throw new RangeBuddyError(401, "Invalid device token");
        const tokenHash = hashDeviceToken(match[1]);
        const { data: van, error } = await database.from("Vans").select(vanColumns)
            .eq("token_hash", tokenHash).maybeSingle();
        checkDatabaseError(error);
        if (!van) throw new RangeBuddyError(401, "Invalid device token");
        req.rangeBuddyAuth = { type: "device", vanId: van.id, van, tokenHash };
    } else {
        if (!(await requireWebAdmin(req, res))) return;
        req.rangeBuddyAuth = { type: "admin", user: req.user.user };
    }
    next();
};
