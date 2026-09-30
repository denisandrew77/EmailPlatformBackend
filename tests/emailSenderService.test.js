import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "../services/emailSenderService.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
});

const configure = () => {
    process.env.SMTP2GO_API_KEY = "test-key";
    process.env.SMTP2GO_FROM_EMAIL = "offers@example.com";
    process.env.SMTP2GO_FROM_NAME = "ByExpress";
};
const email = { to: "carrier@example.com", subject: "Offer", text: "Details", html: "<p>Details</p>" };

test("sends content and credentials using SMTP2GO's contract", async () => {
    configure();
    globalThis.fetch = async (url, options) => {
        assert.equal(url, "https://api.smtp2go.com/v3/email/send");
        assert.equal(options.headers["X-Smtp2go-Api-Key"], "test-key");
        assert.deepEqual(JSON.parse(options.body), {
            sender: '"ByExpress" <offers@example.com>', to: [email.to],
            subject: email.subject, text_body: email.text, html_body: email.html, fastaccept: false,
        });
        return Response.json({ data: { succeeded: 1, failed: 0, failures: [], email_id: "test-id" } });
    };
    assert.equal((await sendEmail(email)).data.email_id, "test-id");
});

test("rejects HTTP errors, HTTP-200 failures, partial acceptance and malformed responses", async () => {
    configure();
    for (const response of [
        Response.json({ data: { error_code: "RATE_LIMIT" } }, { status: 429 }),
        Response.json({ data: { succeeded: 0, failed: 1, failures: ["rejected"] } }),
        Response.json({ data: { succeeded: 1, failed: 1 } }),
        Response.json({ data: {} }),
        new Response("not JSON", { status: 502 }),
    ]) {
        globalThis.fetch = async () => response;
        await assert.rejects(sendEmail({ ...email, to: [email.to, "second@example.com"] }), /SMTP2GO/);
    }
});

test("missing configuration fails before network access", async () => {
    configure();
    globalThis.fetch = () => { assert.fail("Unexpected network access"); };
    delete process.env.SMTP2GO_API_KEY;
    await assert.rejects(sendEmail(email), /SMTP2GO_API_KEY/);
    configure();
    delete process.env.SMTP2GO_FROM_EMAIL;
    await assert.rejects(sendEmail(email), /SMTP2GO_FROM_EMAIL/);
});

test("network failures propagate to the queue worker", async () => {
    configure();
    globalThis.fetch = async () => { throw new Error("Connection failed"); };
    await assert.rejects(sendEmail(email), /Connection failed/);
});
