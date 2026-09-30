import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSmtp2goWebhookRouter } from "../endpoints/smtp2goWebhook.js";

const originalSecret = process.env.SMTP2GO_WEBHOOK_SECRET;
afterEach(() => {
    if (originalSecret === undefined) delete process.env.SMTP2GO_WEBHOOK_SECRET;
    else process.env.SMTP2GO_WEBHOOK_SECRET = originalSecret;
});

const invoke = async (body, authorization = "Bearer test-secret", databaseError = null) => {
    const updates = [];
    const database = {
        from(table) {
            assert.equal(table, "Companies");
            return { update(values) {
                return { async ilike(column, pattern) {
                    updates.push({ values, column, pattern });
                    return { error: databaseError };
                } };
            } };
        },
    };
    const router = createSmtp2goWebhookRouter(database);
    const handler = router.stack[0].route.stack[0].handle;
    const response = {
        code: 200,
        status(code) { this.code = code; return this; },
        json() { return this; },
        sendStatus(code) { this.code = code; return this; },
    };
    await handler({ body, headers: { authorization } }, response);
    return { code: response.code, updates };
};

test("requires configured, valid webhook authorization before database access", async () => {
    delete process.env.SMTP2GO_WEBHOOK_SECRET;
    assert.equal((await invoke({})).code, 503);
    process.env.SMTP2GO_WEBHOOK_SECRET = "test-secret";
    assert.deepEqual(await invoke({}, "Bearer wrong"), { code: 401, updates: [] });
});

test("suppresses hard bounces, spam and unsubscribes for the exact recipient", async () => {
    process.env.SMTP2GO_WEBHOOK_SECRET = "test-secret";
    for (const event of ["bounce", "spam", "unsubscribe"]) {
        const result = await invoke({ event, bounce: "hard", rcpt: "Carrier_one@example.com" });
        assert.equal(result.code, 204);
        assert.deepEqual(result.updates, [{
            values: { unsubscribed: true }, column: "emailAddress", pattern: "carrier\\_one@example.com",
        }]);
    }
});

test("soft bounces and unrelated events do not unsubscribe companies", async () => {
    process.env.SMTP2GO_WEBHOOK_SECRET = "test-secret";
    for (const event of ["bounce", "delivered", "reject", "resubscribe"]) {
        assert.deepEqual(await invoke({ event, bounce: "soft", rcpt: "a@example.com" }), { code: 204, updates: [] });
    }
});

test("invalid payloads fail and database errors return a retryable status", async () => {
    process.env.SMTP2GO_WEBHOOK_SECRET = "test-secret";
    assert.equal((await invoke({})).code, 400);
    assert.equal((await invoke({ event: "spam" })).code, 400);
    assert.equal((await invoke({ event: "spam", rcpt: "a@example.com" }, "Bearer test-secret", new Error("DB failed"))).code, 500);
});
