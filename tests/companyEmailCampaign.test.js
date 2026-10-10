import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.SUPABASE_URL = "https://database.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ACCESS_TOKEN_SECRET = "test-campaign-secret";
process.env.AWS_REGION = "eu-west-1";
process.env.SQS_EMAIL_QUEUE_URL = "https://sqs.example.test/email";

const { dbRouter } = await import("../endpoints/dbService.js");
const { sqsClient } = await import("../aws/awsClients.js");
const handler = dbRouter.stack.find(
    (layer) => layer.route?.path === "/queueCompanyEmailCampaign",
).route.stack[0].handle;

const invoke = async (t, body, companies = []) => {
    const queries = [];
    const jobs = [];
    t.mock.method(globalThis, "fetch", async (input) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        assert.equal(url.hostname, "database.example.test");
        if (url.pathname === "/rest/v1/Users") {
            return Response.json({ id: 1, userName: "admin", adminRole: true });
        }
        assert.equal(url.pathname, "/rest/v1/Companies");
        queries.push(url.searchParams);
        return Response.json(companies);
    });
    t.mock.method(sqsClient, "send", async (command) => {
        jobs.push(JSON.parse(command.input.MessageBody));
        return { MessageId: `test-${jobs.length}` };
    });

    const response = {
        code: 200,
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; },
    };
    await handler({
        body: { template: "quotationRequest", ...body },
        headers: {
            authorization: `Bearer ${jwt.sign({ id: 1 }, process.env.ACCESS_TOKEN_SECRET)}`,
        },
        protocol: "https",
        get() { return "app.example.test"; },
    }, response);
    return { response, queries, jobs };
};

for (const [name, body] of [
    ["missing categories", {}],
    ["all categories false", { threeTonnCategory: false, sevenTonnCategory: false, caddyCategory: false }],
    ["company IDs without categories", { companyIds: [1, 2] }],
    ["truthy non-boolean category values", { threeTonnCategory: "true", sevenTonnCategory: "false", caddyCategory: 1 }],
]) {
    test(`rejects ${name} before querying recipients or queueing emails`, async (t) => {
        const { response, queries, jobs } = await invoke(t, body);
        assert.equal(response.code, 400);
        assert.deepEqual(response.body, { error: "Select at least one vehicle category" });
        assert.deepEqual(queries, []);
        assert.deepEqual(jobs, []);
    });
}

for (const category of ["threeTonnCategory", "sevenTonnCategory", "caddyCategory"]) {
    test(`filters by ${category} and subscription status before queueing`, async (t) => {
        const company = { id: 1, name: "Carrier", emailAddress: "carrier@example.test", [category]: true };
        const { response, queries, jobs } = await invoke(t, { [category]: true }, [company]);
        assert.equal(response.code, 200);
        assert.equal(response.body.count, 1);
        assert.equal(queries[0].get(category), "eq.true");
        assert.deepEqual(queries[0].getAll("or"), ["(unsubscribed.is.false,unsubscribed.is.null)"]);
        assert.deepEqual(jobs.map((job) => job.to), [company.emailAddress]);
        assert.equal(jobs[0].template, "quotationRequest");
        assert.match(jobs[0].templateData.unsubscribeUrl, /\/unsubscribe\?token=/);
    });
}

test("multiple categories remain required alongside subscription and explicit ID filters", async (t) => {
    const { response, queries, jobs } = await invoke(t, {
        companyIds: [1, 2],
        threeTonnCategory: true,
        caddyCategory: true,
    });
    assert.equal(response.code, 200);
    assert.equal(queries[0].get("id"), "in.(1,2)");
    assert.deepEqual(queries[0].getAll("or"), [
        "(unsubscribed.is.false,unsubscribed.is.null)",
        "(threeTonnCategory.eq.true,caddyCategory.eq.true)",
    ]);
    assert.equal(response.body.count, 0);
    assert.deepEqual(jobs, []);
});

test("explicit IDs cannot bypass a single selected category", async (t) => {
    const { queries } = await invoke(t, { companyIds: [1], caddyCategory: true });
    assert.equal(queries[0].get("id"), "in.(1)");
    assert.equal(queries[0].get("caddyCategory"), "eq.true");
});
