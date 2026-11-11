import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.SUPABASE_URL = "https://database.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ACCESS_TOKEN_SECRET = "test-directory-secret";

const { dbRouter } = await import("../endpoints/dbService.js");
const handler = dbRouter.stack.find(
    (layer) => layer.route?.path === "/getAllCompanies",
).route.stack[0].handle;

test("company directory passes the None category alongside other filters", async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/rest/v1/Users") {
            return Response.json({ id: 1, adminRole: true });
        }
        assert.equal(url.pathname, "/rest/v1/rpc/get_company_directory");
        calls.push(JSON.parse(init.body));
        return Response.json([{ id: 5, name: "No category", total_count: 1 }]);
    });

    const response = {
        code: 200,
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; },
    };
    await handler({
        query: { search: "No category", offset: "0", noneCategory: "true", caddyCategory: "true" },
        headers: { authorization: `Bearer ${jwt.sign({ id: 1 }, process.env.ACCESS_TOKEN_SECRET)}` },
    }, response);

    assert.equal(response.code, 200);
    assert.deepEqual(response.body, {
        items: [{ id: 5, name: "No category" }],
        total: 1,
        hasMore: false,
    });
    assert.deepEqual(calls, [{
        p_search: "No category", p_three_tonn: false, p_seven_tonn: false,
        p_caddy: true, p_none: true, p_limit: 30, p_offset: 0,
    }]);
});
