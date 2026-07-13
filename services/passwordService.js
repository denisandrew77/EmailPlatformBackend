import crypto from "crypto";

const HASH_PREFIX = "scrypt";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const hashPassword = (password) => {
    const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
    const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");

    return `${HASH_PREFIX}:${salt}:${hash}`;
};

export const isPasswordHash = (value) => {
    return typeof value === "string" && value.startsWith(`${HASH_PREFIX}:`);
};

export const verifyPassword = (password, storedPassword) => {
    if (typeof password !== "string" || typeof storedPassword !== "string") {
        return false;
    }

    if (!isPasswordHash(storedPassword)) {
        return password === storedPassword;
    }

    const [, salt, storedHash] = storedPassword.split(":");

    if (!salt || !storedHash) {
        return false;
    }

    const candidateHash = crypto.scryptSync(password, salt, KEY_LENGTH);
    const storedHashBuffer = Buffer.from(storedHash, "hex");

    if (candidateHash.length !== storedHashBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(candidateHash, storedHashBuffer);
};
