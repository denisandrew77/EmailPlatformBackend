import assert from "node:assert/strict";
import test from "node:test";
import {
    buildUncategorizedCompanyEmailJobs,
    normalizeUncategorizedCompanyMessage,
} from "../services/uncategorizedCompanyEmail.js";
import { createCompanyEmailEligibilityChecker } from "../workers/emailWorker.js";

const uncategorizedCampaign = {
    companyId: 12,
    campaignType: "uncategorized-companies",
};

const createDatabase = ({ data, error = null }) => {
    const calls = [];
    const database = {
        from(table) {
            calls.push({ table });
            return {
                select(columns) {
                    calls.at(-1).columns = columns;
                    return {
                        eq(column, value) {
                            calls.at(-1).filter = { column, value };
                            return {
                                async maybeSingle() { return { data, error }; },
                            };
                        },
                    };
                },
            };
        },
    };
    return { database, calls };
};

test("message validation trims content and enforces the size limit", () => {
    assert.equal(normalizeUncategorizedCompanyMessage("  Update\nDetails  "), "Update\nDetails");
    assert.throws(() => normalizeUncategorizedCompanyMessage("  "), /between 1 and 10000/);
    assert.throws(() => normalizeUncategorizedCompanyMessage("x".repeat(10001)), /between 1 and 10000/);
});

test("campaign creates jobs only for subscribed companies with no categories", () => {
    const companies = [
        { id: 1, name: "Eligible", emailAddress: "eligible@example.com" },
        { id: 2, name: "3.5T", emailAddress: "three@example.com", threeTonnCategory: true },
        { id: 3, name: "7.5T", emailAddress: "seven@example.com", sevenTonnCategory: true },
        { id: 4, name: "Caddy", emailAddress: "caddy@example.com", caddyCategory: true },
        { id: 5, name: "No email", emailAddress: "", threeTonnCategory: false },
        { id: 6, name: "Unsubscribed", emailAddress: "stop@example.com", unsubscribed: true },
        { id: 7, name: "Null flags", emailAddress: "null@example.com", threeTonnCategory: null },
    ];
    const jobs = buildUncategorizedCompanyEmailJobs(
        companies,
        "Please update your vehicle profile.",
        (company) => `https://example.com/unsubscribe/${company.id}`,
    );

    assert.deepEqual(jobs.map(({ to }) => to), ["eligible@example.com", "null@example.com"]);
    assert.deepEqual(jobs[0], {
        to: "eligible@example.com",
        template: "plainMessage",
        templateData: {
            message: "Please update your vehicle profile.",
            unsubscribeUrl: "https://example.com/unsubscribe/1",
        },
        metadata: {
            companyId: 1,
            companyName: "Eligible",
            campaignType: "uncategorized-companies",
        },
    });
});

test("worker blocks deleted, unsubscribed, or newly categorized campaign recipients", async () => {
    for (const data of [
        null,
        { id: 12, unsubscribed: true },
        { id: 12, caddyCategory: true },
        { id: 12, sevenTonnCategory: true },
        { id: 12, threeTonnCategory: true },
    ]) {
        const { database, calls } = createDatabase({ data });
        const checker = createCompanyEmailEligibilityChecker(database, { warn() {}, log() {} });
        assert.equal(await checker({ to: "carrier@example.com", metadata: uncategorizedCampaign }), false);
        assert.deepEqual(calls, [{
            table: "Companies",
            columns: "id, unsubscribed, threeTonnCategory, sevenTonnCategory, caddyCategory",
            filter: { column: "id", value: 12 },
        }]);
    }
});

test("worker allows still-eligible companies and preserves other company campaign behavior", async () => {
    const { database } = createDatabase({ data: { id: 12, unsubscribed: false } });
    const checker = createCompanyEmailEligibilityChecker(database, { warn() {}, log() {} });
    assert.equal(await checker({ to: "carrier@example.com", metadata: uncategorizedCampaign }), true);
    assert.equal(await checker({ to: "carrier@example.com", metadata: { companyId: 12, campaignType: "company" } }), true);
    assert.equal(await checker({ to: "one-off@example.com", metadata: {} }), true);
});

test("worker surfaces database errors so SQS can retry the message", async () => {
    const databaseError = new Error("database unavailable");
    const { database } = createDatabase({ data: null, error: databaseError });
    const checker = createCompanyEmailEligibilityChecker(database, { warn() {}, log() {} });
    await assert.rejects(
        checker({ to: "carrier@example.com", metadata: uncategorizedCampaign }),
        (error) => error === databaseError,
    );
});
