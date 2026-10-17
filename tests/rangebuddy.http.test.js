import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import { createRangeBuddyRouter } from "../rangebuddy/routes.js";
import { hashPassword } from "../services/passwordService.js";
import { hashDeviceToken } from "../rangebuddy/security.js";

test("RangeBuddy HTTP routes using the Supabase client", async (t) => {
    process.env.SUPABASE_URL = "https://web-auth.example.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    process.env.ACCESS_TOKEN_SECRET = "test-only-jwt-secret";
    process.env.RANGEBUDDY_ADMIN_PASSWORD_HASH = hashPassword("test-password");
    const { requireAdmin } = await import("../endpoints/dbService.js");
    const { supabase } = await import("../SupabaseClient/supabaseClient.js");
    t.mock.method(supabase, "from", (table) => {
        assert.equal(table, "Users");
        return { select: () => ({ eq: (key, id) => ({ maybeSingle: async () => ({
            data: id <= 2 ? { id, adminRole: id === 1 } : null, error: null,
        }) }) }) };
    });
    const token = "a".repeat(64);
    const tokenHash = hashDeviceToken(token);
    const van = { id: 1, license_plate: "BH01ABC", activation_date: "2026-10-15", initial_kms: 100, last_kms: 100 };
    const calls = [];
    let error = null;
    let results = [];
    let created = true;
    const activeSession = { id: 3, van_id: 1, start_kms: 100, started_at: "2026-10-17T10:00:00Z",
        ended_at: null, is_active: true, average_consumption: 18.33, average_fuel_price: 7.33 };
    let session = activeSession;
    const database = createClient("https://rangebuddy.example.test", "backend-service-key", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: async (input, init) => {
            const url = new URL(input);
            assert.equal(url.hostname, "rangebuddy.example.test");
            const body = init.body ? JSON.parse(init.body) : undefined;
            calls.push({ url, body, headers: new Headers(init.headers) });
            if (error) return Response.json(error, { status: 400 });
            if (url.pathname === "/rest/v1/Vans") {
                const q = url.searchParams;
                assert(!q.get("select").includes("token_hash"));
                if (!q.has("token_hash") && !q.has("license_plate") && !q.has("id")) {
                    const offset = Number(q.get("offset") || 0);
                    const fleet = [van, { ...van, id: 2, license_plate: "BH02ABC" }, { ...van, id: 3, license_plate: "BH03ABC" }];
                    return Response.json(fleet.slice(offset, offset + 2), { headers: { "Content-Range": `${offset}-${Math.min(offset + 1, 2)}/3` } });
                }
                const matched = (!q.has("token_hash") || q.get("token_hash") === `eq.${tokenHash}`)
                    && (!q.has("license_plate") || q.get("license_plate") === `eq.${van.license_plate}`)
                    && (!q.has("id") || q.get("id") === "eq.1");
                return Response.json(matched ? [van] : []);
            }
            if (url.pathname === "/rest/v1/FuelEntries") {
                const offset = Number(url.searchParams.get("offset") || 0);
                const page = results.slice(offset, offset + 2);
                return Response.json(page, { headers: { "Content-Range": `${offset}-${offset + page.length - 1}/${results.length}` } });
            }
            if (url.pathname === "/rest/v1/rpc/rangebuddy_activate") return Response.json({ created, van });
            if (url.pathname === "/rest/v1/rpc/rangebuddy_current_session") return Response.json(session);
            if (url.pathname === "/rest/v1/rpc/rangebuddy_start_session") return Response.json(activeSession);
            if (url.pathname === "/rest/v1/rpc/rangebuddy_stop_session") return Response.json({ ...activeSession, is_active: false, ended_at: "2026-10-17T12:00:00Z" });
            if (url.pathname === "/rest/v1/rpc/rangebuddy_create_entry") return Response.json({
                id: 1, van_id: body.p_van_id, current_kms: body.p_current_kms,
                litres: body.p_litres, price_per_litre: body.p_price_per_litre, fuel_date: body.p_fuel_date,
                current_consumption: 8.33,
                session_id: 3,
            });
            if (url.pathname === "/rest/v1/rpc/rangebuddy_change_license_plate") return Response.json({ ...van, license_plate: body.p_new_license_plate });
            throw new Error(`Unexpected Supabase request path: ${url.pathname}`);
        } },
    });
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/rangebuddy", createRangeBuddyRouter({ database, requireWebAdmin: requireAdmin }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/rangebuddy`;
    let nextIp = 1;
    const web = (id = 1, extra = {}) => `Bearer ${jwt.sign({ id, ...extra }, process.env.ACCESS_TOKEN_SECRET)}`;
    const device = `RangeBuddy ${token}`;
    const entry = { current_kms: 200, litres: 53.72, price_per_litre: 7.349, fuel_date: "2026-10-15T16:40:00+03:00" };
    const request = async (path, { method = "GET", body, auth, ip } = {}) => {
        const response = await fetch(`${base}${path}`, {
            method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip || `198.51.100.${nextIp++}`, ...(auth ? { Authorization: auth } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
    };
    t.beforeEach(() => { calls.length = 0; error = null; results = []; created = true; session = activeSession; });

    await t.test("fleet listing is admin-only, paged through Supabase and never exposes tokens", async () => {
        assert.equal((await request("/vans", { auth: device })).status, 401);
        assert.equal((await request("/vans", { auth: web(2) })).status, 403);
        assert.equal((await request("/vans")).status, 401);
        assert.equal(calls.length, 0);
        const response = await request("/vans", { auth: web() });
        assert.equal(response.status, 200);
        assert.equal(response.body.length, 3);
        assert.equal(response.body[2].license_plate, "BH03ABC");
        assert(!JSON.stringify(response.body).includes("token_hash"));
        assert.deepEqual(calls.map(c => c.url.searchParams.get("offset")), ["0", "2"]);
    });

    await t.test("only web admins can start and stop sessions", async () => {
        for (const [path, body] of [
            ["/sessions/start", { van_id: 1, start_kms: 100 }],
            ["/sessions/stop", { van_id: 1, session_id: 3 }],
        ]) {
            assert.equal((await request(path, { method: "POST", body, auth: device })).status, 401);
            assert.equal((await request(path, { method: "POST", body, auth: web(2) })).status, 403);
            assert.equal((await request(path, { method: "POST", body })).status, 401);
        }
        assert.equal(calls.length, 0);
        const started = await request("/sessions/start", { method: "POST", auth: web(), body: { van_id: 1, start_kms: 100 } });
        assert.equal(started.status, 201);
        assert.deepEqual(started.body, activeSession);
        assert.deepEqual(calls.at(-1).body, { p_van_id: 1, p_start_kms: 100 });
        const stopped = await request("/sessions/stop", { method: "POST", auth: web(), body: { van_id: 1, session_id: 3 } });
        assert.equal(stopped.status, 200);
        assert.equal(stopped.body.is_active, false);
        assert.deepEqual(calls.at(-1).body, { p_van_id: 1, p_session_id: 3 });
        assert.equal((await request("/sessions/start", { method: "POST", auth: web(), body: { van_id: 1, start_kms: -1 } })).status, 400);
        assert.equal((await request("/sessions/stop", { method: "POST", auth: web(), body: { van_id: 1 } })).status, 400);
    });

    await t.test("devices receive only their current session and no-session is not an authentication error", async () => {
        const response = await request("/sessions/current", { auth: device });
        assert.deepEqual(response.body, { session: activeSession });
        assert.deepEqual(calls.at(-1).body, { p_van_id: 1, p_token_hash: tokenHash });
        assert.equal((await request("/sessions/current?van_id=2", { auth: device })).status, 400);
        assert.equal((await request("/sessions/current", { auth: web() })).status, 400);
        assert.equal((await request("/sessions/current?van_id=1", { auth: web() })).status, 200);
        assert.deepEqual(calls.at(-1).body, { p_van_id: 1, p_token_hash: null });
        session = null;
        assert.deepEqual((await request("/sessions/current", { auth: device })).body, { session: null });
        error = { code: "PT409", message: "RB_NO_ACTIVE_SESSION" };
        const blocked = await request("/entries", { method: "POST", auth: web(), body: { ...entry, van_id: 1 } });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, "RB_NO_ACTIVE_SESSION");
    });

    await t.test("activation verifies the password and sends only the token hash to Supabase", async () => {
        const body = { license_plate: " bh01abc ", initial_kms: 100, password: "wrong" };
        assert.equal((await request("/activate", { method: "POST", body })).status, 401);
        assert.equal(calls.length, 0);
        body.password = "test-password";
        const response = await request("/activate", { method: "POST", body });
        assert.equal(response.status, 201);
        assert.match(response.body.token, /^[a-f0-9]{64}$/);
        assert.deepEqual(calls[0].body, { p_license_plate: "BH01ABC", p_initial_kms: 100, p_token_hash: hashDeviceToken(response.body.token) });
        assert(!JSON.stringify(calls).includes("test-password"));
        assert(!JSON.stringify(response.body).includes("token_hash"));
        assert.equal(response.headers.get("cache-control"), "no-store");
        created = false;
        assert.equal((await request("/activate", { method: "POST", body })).status, 200);
    });

    await t.test("device reads hash the token and enforce the van identity", async () => {
        assert.equal((await request("/vans/bh01abc", { auth: device })).status, 200);
        assert.equal(calls[0].url.searchParams.get("token_hash"), `eq.${tokenHash}`);
        assert.equal(calls[1].url.searchParams.get("id"), "eq.1");
        assert.equal((await request("/vans/BH02ABC", { auth: device })).status, 404);
        assert.equal((await request("/entries?van_id=2", { auth: device })).status, 400);
        assert.equal((await request("/entries", { auth: `RangeBuddy ${"b".repeat(64)}` })).status, 401);
        assert.equal((await request("/entries", { auth: "RangeBuddy invalid" })).status, 401);
        assert.equal((await request("/entries")).status, 401);
    });

    await t.test("fuel writes use one atomic RPC and never trust a mobile van_id", async () => {
        const response = await request("/entries", { method: "POST", auth: device, body: entry });
        assert.equal(response.status, 201);
        assert.equal(calls.at(-1).url.pathname, "/rest/v1/rpc/rangebuddy_create_entry");
        assert.equal(response.body.current_consumption, 8.33);
        assert.equal(response.body.session_id, 3);
        assert.equal(calls.at(-1).body.p_van_id, 1);
        assert.equal(calls.at(-1).body.p_token_hash, tokenHash);
        assert.equal((await request("/entries", { method: "POST", auth: device, body: { ...entry, current_consumption: 1 } })).status, 400);
        assert.equal((await request("/entries", { method: "POST", auth: device, body: { ...entry, session_id: 99 } })).status, 400);
        assert.equal((await request("/entries", { method: "POST", auth: device, body: { ...entry, van_id: 2 } })).status, 400);
        assert.equal((await request("/entries", { method: "POST", auth: device, body: { ...entry, isAdmin: true } })).status, 400);
    });

    await t.test("web access reuses real JWT and database admin validation", async () => {
        assert.equal((await request("/entries", { auth: web(2, { adminRole: true }) })).status, 403);
        assert.equal((await request("/entries", { auth: web(1, { userType: "external" }) })).status, 401);
        assert.equal((await request("/entries", { auth: web(99) })).status, 401);
        assert.equal((await request("/entries", { auth: web(1, { exp: 1 }) })).status, 401);
        assert.equal((await request("/entries", { auth: "Bearer forged" })).status, 401);
        assert.equal((await request("/entries", { method: "POST", auth: web(), body: entry })).status, 400);
        assert.equal((await request("/entries", { method: "POST", auth: web(), body: { ...entry, van_id: 2 } })).status, 201);
        assert.equal(calls.at(-1).body.p_van_id, 2);
        assert.equal(calls.at(-1).body.p_token_hash, null);
    });

    await t.test("monthly reads use DST bounds and fetch beyond Supabase response caps", async () => {
        results = Array.from({ length: 5 }, (_, id) => ({ id, van_id: 1, ...entry, van, current_consumption: id ? 8.33 : null, session_id: id ? 3 : null }));
        const response = await request("/entries?month=10&year=2026", { auth: device });
        assert.equal(response.status, 200);
        assert.equal(response.body.length, 5);
        assert.equal(response.body[0].current_consumption, null);
        assert.equal(response.body[1].current_consumption, 8.33);
        assert.equal(response.body[0].session_id, null);
        assert.equal(response.body[1].session_id, 3);
        const pages = calls.filter(({ url }) => url.pathname.endsWith("/FuelEntries"));
        assert.deepEqual(pages.map(({ url }) => url.searchParams.get("offset")), ["0", "2", "4"]);
        const params = pages[0].url.searchParams;
        assert.deepEqual(params.getAll("fuel_date"), ["gte.2026-09-30T21:00:00.000Z", "lt.2026-10-31T22:00:00.000Z"]);
        assert.equal(params.get("order"), "fuel_date.desc,id.desc");
        assert.equal(params.get("van_id"), "eq.1");
        assert(params.get("select").includes("current_consumption"));
        assert(!params.get("select").includes("token_hash"));
        await request("/entries?month=10&year=2026", { auth: web() });
        assert.equal(calls.at(-1).url.searchParams.has("van_id"), false);
        await request("/entries?month=10&year=2026&van_id=7", { auth: web() });
        assert.equal(calls.at(-1).url.searchParams.get("van_id"), "eq.7");
    });

    await t.test("plate changes require the mobile password and pass the token hash to the RPC", async () => {
        const body = { new_license_plate: " bh99xyz " };
        assert.equal((await request("/vans/license-plate", { method: "PUT", auth: device, body })).status, 400);
        assert.equal((await request("/vans/license-plate", { method: "PUT", auth: device, body: { ...body, password: "wrong" } })).status, 401);
        assert.equal((await request("/vans/license-plate", { method: "PUT", auth: device, body: { ...body, password: "test-password" } })).status, 200);
        assert.deepEqual(calls.at(-1).body, { p_van_id: 1, p_token_hash: tokenHash, p_new_license_plate: "BH99XYZ" });
        assert.equal((await request("/vans/license-plate", { method: "PUT", auth: web(), body: { ...body, van_id: 2 } })).status, 200);
        assert.equal(calls.at(-1).body.p_token_hash, null);
    });

    await t.test("Supabase errors map to safe HTTP responses", async () => {
        for (const [code, message, expectedStatus] of [
            ["PT400", "RB_ODOMETER_NOT_INCREASING", 400], ["PT401", "RB_INVALID_TOKEN", 401],
            ["PT404", "RB_VAN_NOT_FOUND", 404], ["23505", "secret SQL", 409],
            ["PGRST202", "missing function", 503], ["42P01", "missing table", 503], ["", "fetch failed", 503],
            ["unknown", "secret SQL", 500],
        ]) {
            error = { code, message, details: "private-database-details" };
            const response = await request("/entries", { method: "POST", auth: web(), body: { ...entry, van_id: 1 } });
            assert.equal(response.status, expectedStatus);
            assert(!JSON.stringify(response.body).includes("private-database-details"));
            assert(!JSON.stringify(response.body).includes("secret SQL"));
        }
    });

    await t.test("password rate limits are shared across activation and plate changes", async () => {
        const ip = "203.0.113.10";
        for (let i = 0; i < 5; i++) assert.equal((await request("/activate", {
            method: "POST", ip, body: { license_plate: "BH01ABC", initial_kms: 0, password: "wrong" },
        })).status, 401);
        const response = await request("/vans/license-plate", { method: "PUT", ip, auth: device, body: { new_license_plate: "BH99XYZ", password: "test-password" } });
        assert.equal(response.status, 429);
        assert(response.headers.has("retry-after"));
        assert.equal((await request("/entries", { ip, auth: device })).status, 200);
    });

    await t.test("malformed JSON never echoes credential input", async () => {
        const response = await fetch(`${base}/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"private-test-value",' });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
    });
});
