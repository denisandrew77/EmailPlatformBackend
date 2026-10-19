import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);
const testUrl = process.env.RANGEBUDDY_TEST_DATABASE_URL;
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);
const codeHash = "c".repeat(64);

test("RangeBuddy Supabase RPC functions on PostgreSQL", { skip: !testUrl }, async (t) => {
    const url = new URL(testUrl);
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/rangebuddy_test", "Only a disposable local rangebuddy_test database may be reset");
    const sql = async (statement) => {
        const { stdout } = await run("psql", [testUrl, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement]);
        return stdout.trim();
    };
    const rpc = async (statement) => JSON.parse(await sql(`set role service_role; select coalesce(${statement}, 'null'::jsonb)`));
    const activate = async (plate = "BH01ABC", hash = firstHash, kms = 100) => {
        const van = await rpc(`public.rangebuddy_create_van('${plate}', ${kms})`);
        await rpc(`public.rangebuddy_issue_code(${van.id}, '${codeHash}')`);
        await rpc(`public.rangebuddy_redeem_code('${codeHash}', '${hash}')`);
        await rpc(`public.rangebuddy_start_session(${van.id}, ${kms})`);
        return { created: true, van };
    };
    const createEntry = (id = 1, hash = firstHash, kms = 200) => rpc(`public.rangebuddy_create_entry(${id}, '${hash}', ${kms}, 53.72, 7.349, '2026-10-15T16:40:00+03:00')`);
    await sql(`do $$ begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    drop table if exists "RangeBuddyActivationCodes", "FuelEntries", "DriverSessions", "Vans" cascade;`);
    await sql(await readFile(new URL("./fixtures/rangebuddy.sql", import.meta.url), "utf8"));
    const migration = await readFile(new URL("../migrations/007_rangebuddy_supabase_functions.sql", import.meta.url), "utf8");
    await sql(migration);
    await sql(migration);
    const consumptionMigration = await readFile(new URL("../migrations/008_rangebuddy_current_consumption.sql", import.meta.url), "utf8");
    await sql(consumptionMigration);
    await sql(consumptionMigration);
    // Verify existing history is not assigned or recalculated by the sessions migration.
    await rpc(`public.rangebuddy_activate('OLD', 100, '${firstHash}')`);
    await createEntry();
    const sessionsMigration = await readFile(new URL("../migrations/009_rangebuddy_driver_sessions.sql", import.meta.url), "utf8");
    await sql(sessionsMigration);
    await sql(sessionsMigration);
    assert.equal(await sql('select count(*) from "FuelEntries" where session_id is null'), "1");
    assert.equal(await sql('select count(*) from "DriverSessions"'), "0");
    const estimateMigration = await readFile(new URL("../migrations/010_rangebuddy_first_refill_estimate.sql", import.meta.url), "utf8");
    await sql(estimateMigration);
    await sql(estimateMigration);
    const activationMigration = await readFile(new URL("../migrations/011_rangebuddy_admin_activation.sql", import.meta.url), "utf8");
    await sql(activationMigration);
    assert.equal(await sql('select count(*) from "Vans" where token_hash is not null'), "0");
    assert.equal(await sql('select count(*) from "FuelEntries" where session_id is null'), "1");
    await assert.rejects(rpc(`public.rangebuddy_activate('OLD', 100, '${firstHash}')`), /does not exist/);
    t.beforeEach(() => sql('truncate "RangeBuddyActivationCodes", "FuelEntries", "DriverSessions", "Vans" restart identity'));

    await t.test("session lifecycle preserves mileage and tokens and requires an active session", async () => {
        await rpc("public.rangebuddy_create_van('BH01ABC', 100)");
        await rpc(`public.rangebuddy_issue_code(1, '${codeHash}')`);
        await rpc(`public.rangebuddy_redeem_code('${codeHash}', '${firstHash}')`);
        assert.equal(await rpc(`public.rangebuddy_current_session(1, '${firstHash}')`), null);
        await assert.rejects(createEntry(), /RB_NO_ACTIVE_SESSION/);
        await assert.rejects(rpc("public.rangebuddy_start_session(1, 99)"), /RB_SESSION_START_KMS/);
        const session = await rpc("public.rangebuddy_start_session(1, 150)");
        assert.equal(session.average_consumption, null);
        assert.equal(session.average_fuel_price, null);
        assert.equal((await rpc(`public.rangebuddy_current_session(1, '${firstHash}')`)).id, session.id);
        await assert.rejects(rpc(`public.rangebuddy_current_session(1, '${secondHash}')`), /RB_INVALID_TOKEN/);
        await assert.rejects(rpc("public.rangebuddy_start_session(1, 150)"), /RB_SESSION_ALREADY_ACTIVE/);
        const first = await createEntry();
        assert.equal(first.session_id, session.id);
        assert.equal(first.current_consumption, 107.44);
        const stopped = await rpc(`public.rangebuddy_stop_session(1, ${session.id})`);
        assert.equal(stopped.is_active, false);
        assert(stopped.ended_at);
        await assert.rejects(createEntry(1, firstHash, 300), /RB_NO_ACTIVE_SESSION/);
        assert.equal(await rpc(`public.rangebuddy_current_session(1, '${firstHash}')`), null);
        const next = await rpc("public.rangebuddy_start_session(1, 500)");
        assert.notEqual(next.id, session.id);
        await assert.rejects(rpc(`public.rangebuddy_stop_session(1, ${session.id})`), /RB_SESSION_NOT_CURRENT/);
        assert.equal((await createEntry(1, firstHash, 600)).current_consumption, 53.72);
        assert.equal(await sql('select initial_kms from "Vans"'), "100");
        assert.equal(await sql('select token_hash from "Vans"'), firstHash);
        assert.equal(await sql('select last_kms from "Vans"'), "600");
    });

    await t.test("session averages use interval litres/distance and simple prices including baseline", async () => {
        await activate();
        const entry = (kms, litres, price) => rpc(`public.rangebuddy_create_entry(1, null, ${kms}, ${litres}, ${price}, now())`);
        const first = await entry(200, 99, 6);
        assert.equal(first.current_consumption, 99);
        let session = await rpc("public.rangebuddy_current_session(1, null)");
        assert.equal(session.average_consumption, 99);
        assert.equal(session.average_fuel_price, 6);
        assert.equal((await entry(300, 10, 7)).current_consumption, 10);
        assert.equal((await rpc("public.rangebuddy_current_session(1, null)")).average_consumption, 10);
        await entry(800, 100, 9);
        session = await rpc("public.rangebuddy_current_session(1, null)");
        assert.equal(session.average_consumption, 18.33);
        assert.equal(session.average_fuel_price, 7.33);
        await rpc("public.rangebuddy_stop_session(1, 1)");
        await rpc("public.rangebuddy_start_session(1, 1000)");
        await entry(1100, 50, 5);
        session = await rpc("public.rangebuddy_current_session(1, null)");
        assert.equal(session.average_consumption, 50);
        assert.equal(session.average_fuel_price, 5);
        assert.equal(await sql('select average_consumption from "DriverSessions" where id = 1'), "18.33");
    });

    await t.test("concurrent starts and stop/refuel races remain consistent", async () => {
        await rpc("public.rangebuddy_create_van('BH01ABC', 100)");
        await rpc(`public.rangebuddy_issue_code(1, '${codeHash}')`);
        await rpc(`public.rangebuddy_redeem_code('${codeHash}', '${firstHash}')`);
        const starts = await Promise.allSettled([
            rpc("public.rangebuddy_start_session(1, 100)"), rpc("public.rangebuddy_start_session(1, 100)"),
        ]);
        assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
        const sessionId = starts.find((r) => r.status === "fulfilled").value.id;
        const results = await Promise.allSettled([
            createEntry(), rpc(`public.rangebuddy_stop_session(1, ${sessionId})`),
        ]);
        assert.equal(results[1].status, "fulfilled");
        const count = Number(await sql('select count(*) from "FuelEntries"'));
        assert.equal(count, results[0].status === "fulfilled" ? 1 : 0);
        assert.equal(await sql('select is_active from "DriverSessions"'), "f");
        assert.equal(await sql('select last_kms from "Vans"'), count ? "200" : "100");
        await assert.rejects(createEntry(1, firstHash, 300), /RB_NO_ACTIVE_SESSION/);
    });

    await t.test("session aggregate failure rolls back entry and mileage", async () => {
        await activate();
        await sql(`create or replace function test_fail_session() returns trigger language plpgsql as $$
            begin raise exception 'session failure'; end $$;
            create trigger test_fail_session before update on "DriverSessions"
            for each row execute function test_fail_session();`);
        try {
            await assert.rejects(createEntry(), /session failure/);
            assert.equal(await sql('select count(*) from "FuelEntries"'), "0");
            assert.equal(await sql('select last_kms from "Vans"'), "100");
        } finally {
            await sql('drop trigger test_fail_session on "DriverSessions"; drop function test_fail_session()');
        }
    });

    await t.test("consumption uses the previous recorded entry for the same van and is persisted", async () => {
        await activate();
        assert.equal((await createEntry()).current_consumption, 53.72);
        await activate("BH02ABC", secondHash);
        await createEntry(2, secondHash, 999);
        const entry = await rpc("public.rangebuddy_create_entry(1, null, 800, 50, 7, '2026-09-01T12:00:00Z')");
        assert.equal(entry.current_consumption, 8.33);
        assert.equal(await sql(`select current_consumption from "FuelEntries" where id = ${entry.id}`), "8.33");
        // Backdated entries still become the baseline for the next recorded refuelling.
        assert.equal((await createEntry(1, firstHash, 1000)).current_consumption, 26.86);
    });

    await t.test("codes are single use and replacing the phone preserves mileage and sessions", async () => {
        const initial = await activate(" bh01abc ");
        assert.equal(initial.van.license_plate, "BH01ABC");
        assert(!JSON.stringify(initial).includes("token_hash"));
        assert.equal(initial.van.activation_date, await sql("select (current_timestamp at time zone 'Europe/Bucharest')::date"));
        await createEntry();
        await assert.rejects(rpc(`public.rangebuddy_redeem_code('${codeHash}', '${secondHash}')`), /RB_INVALID_CODE/);
        const nextCode = "d".repeat(64);
        await rpc(`public.rangebuddy_issue_code(1, '${nextCode}')`);
        assert.equal(await sql('select token_hash from "Vans"'), firstHash);
        const rotated = await rpc(`public.rangebuddy_redeem_code('${nextCode}', '${secondHash}')`);
        assert.equal(rotated.id, initial.van.id);
        assert.equal(rotated.initial_kms, 100);
        assert.equal(rotated.last_kms, 200);
        assert.equal(await sql('select count(*) from "FuelEntries"'), "1");
        assert.equal(await sql('select token_hash from "Vans"'), secondHash);
        assert.equal(await sql('select count(*) from "DriverSessions" where is_active'), "1");
        await assert.rejects(createEntry(1, firstHash, 300), /RB_INVALID_TOKEN/);
    });

    await t.test("concurrent redemption accepts only one phone", async () => {
        await rpc("public.rangebuddy_create_van('BH01ABC', 100)");
        await rpc(`public.rangebuddy_issue_code(1, '${codeHash}')`);
        const results = await Promise.allSettled([
            rpc(`public.rangebuddy_redeem_code('${codeHash}', '${firstHash}')`),
            rpc(`public.rangebuddy_redeem_code('${codeHash}', '${secondHash}')`),
        ]);
        assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
        assert.match(results.find(({ status }) => status === "rejected").reason.message, /RB_INVALID_CODE/);
        assert.equal(await sql('select count(*) from "Vans"'), "1");
        assert.equal(await sql('select count(*) from "RangeBuddyActivationCodes" where consumed_at is not null'), "1");
    });

    await t.test("new codes invalidate unused codes, expire after 24 hours and revocation clears access", async () => {
        await activate();
        const nextCode = "d".repeat(64);
        const lastCode = "e".repeat(64);
        const issued = await rpc(`public.rangebuddy_issue_code(1, '${codeHash}')`);
        assert.equal(await sql(`select expires_at - created_at from "RangeBuddyActivationCodes" where code_hash = '${codeHash}' and consumed_at is null`), "1 day");
        assert(issued.expires_at);
        await rpc(`public.rangebuddy_issue_code(1, '${nextCode}')`);
        await assert.rejects(rpc(`public.rangebuddy_redeem_code('${codeHash}', '${secondHash}')`), /RB_INVALID_CODE/);
        await sql(`update "RangeBuddyActivationCodes" set expires_at = now() - interval '1 second' where code_hash = '${nextCode}'`);
        await assert.rejects(rpc(`public.rangebuddy_redeem_code('${nextCode}', '${secondHash}')`), /RB_INVALID_CODE/);
        await rpc(`public.rangebuddy_issue_code(1, '${lastCode}')`);
        await rpc("public.rangebuddy_revoke_phone(1)");
        assert.equal(await sql('select token_hash is null from "Vans"'), "t");
        assert.equal(await sql('select count(*) from "DriverSessions" where is_active'), "1");
        await assert.rejects(rpc(`public.rangebuddy_redeem_code('${lastCode}', '${secondHash}')`), /RB_INVALID_CODE/);
        await assert.rejects(createEntry(), /RB_INVALID_TOKEN/);
    });

    await t.test("same six-digit code cannot be pending for two vans", async () => {
        await rpc("public.rangebuddy_create_van('BH01ABC', 100)");
        await rpc("public.rangebuddy_create_van('BH02ABC', 100)");
        await rpc(`public.rangebuddy_issue_code(1, '${codeHash}')`);
        await assert.rejects(rpc(`public.rangebuddy_issue_code(2, '${codeHash}')`), /duplicate key/);
        assert.equal(await sql('select count(*) from "RangeBuddyActivationCodes"'), "1");
    });

    await t.test("equal/lower kilometres fail and simultaneous equal refuels cannot both commit", async () => {
        await activate();
        await assert.rejects(createEntry(1, firstHash, 100), /RB_ODOMETER_NOT_INCREASING/);
        await assert.rejects(createEntry(1, firstHash, 99), /RB_ODOMETER_NOT_INCREASING/);
        const results = await Promise.allSettled([createEntry(), createEntry()]);
        assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
        assert.equal(await sql('select count(*) from "FuelEntries"'), "1");
        assert.equal(await sql('select last_kms from "Vans"'), "200");
    });

    await t.test("an odometer write failure rolls back the fuel insert", async () => {
        await activate();
        await sql(`create or replace function test_fail_odometer() returns trigger language plpgsql as $$
            begin raise exception 'test failure'; end $$;
            create trigger test_fail_odometer before update of last_kms on "Vans"
            for each row execute function test_fail_odometer();`);
        try {
            await assert.rejects(createEntry(), /test failure/);
            assert.equal(await sql('select count(*) from "FuelEntries"'), "0");
            assert.equal(await sql('select last_kms from "Vans"'), "100");
        } finally {
            await sql('drop trigger test_fail_odometer on "Vans"; drop function test_fail_odometer()');
        }
    });

    await t.test("a fuel insert failure leaves the odometer unchanged", async () => {
        await activate();
        await sql(`create or replace function test_fail_entry() returns trigger language plpgsql as $$
            begin raise exception 'entry failure'; end $$;
            create trigger test_fail_entry before insert on "FuelEntries"
            for each row execute function test_fail_entry();`);
        try {
            await assert.rejects(createEntry(), /entry failure/);
            assert.equal(await sql('select last_kms from "Vans"'), "100");
        } finally {
            await sql('drop trigger test_fail_entry on "FuelEntries"; drop function test_fail_entry()');
        }
    });

    await t.test("plate updates preserve tokens, reject revoked tokens and prevent duplicates", async () => {
        await activate();
        await activate("BH02ABC", secondHash);
        const rename = (id, hash) => rpc(`public.rangebuddy_change_license_plate(${id}, '${hash}', ' bh99xyz ')`);
        await assert.rejects(rename(1, secondHash), /RB_INVALID_TOKEN/);
        const results = await Promise.allSettled([rename(1, firstHash), rename(2, secondHash)]);
        assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
        assert.equal(await sql('select token_hash from "Vans" where id = 1'), firstHash);
        assert.equal(await sql('select token_hash from "Vans" where id = 2'), secondHash);
        assert(!JSON.stringify(results.find(({ status }) => status === "fulfilled").value).includes("token_hash"));
    });

    await t.test("RPCs validate inputs and allow verified admin calls without device hashes", async () => {
        await assert.rejects(rpc("public.rangebuddy_create_van('', 100)"), /RB_INVALID_INPUT/);
        await assert.rejects(rpc("public.rangebuddy_create_van('BH01ABC', -1)"), /RB_INVALID_INPUT/);
        await activate();
        const entry = await rpc("public.rangebuddy_create_entry(1, null, 200, 10, 2, '2026-10-15T12:00:00Z')");
        assert.equal(entry.van_id, 1);
        const van = await rpc("public.rangebuddy_change_license_plate(1, null, 'BH99XYZ')");
        assert.equal(van.license_plate, "BH99XYZ");
        await assert.rejects(rpc("public.rangebuddy_create_entry(1, null, 300, 0, 2, now())"), /RB_INVALID_INPUT/);
        await assert.rejects(rpc("public.rangebuddy_create_entry(999, null, 300, 10, 2, now())"), /RB_VAN_NOT_FOUND/);
    });

    await t.test("anonymous and authenticated client roles cannot access tables or invoke RPCs", async () => {
        for (const role of ["anon", "authenticated"]) {
            for (const statement of [
                'select * from public."Vans"',
                'select * from public."FuelEntries"',
                'select * from public."DriverSessions"',
                'select public.rangebuddy_start_session(1, 100)',
                'select public.rangebuddy_stop_session(1, 1)',
                'select public.rangebuddy_current_session(1, null)',
                'select * from public."RangeBuddyActivationCodes"',
                "select public.rangebuddy_create_van('BH01ABC', 100)",
                `select public.rangebuddy_issue_code(1, '${codeHash}')`,
                `select public.rangebuddy_redeem_code('${codeHash}', '${secondHash}')`,
                'select public.rangebuddy_revoke_phone(1)',
                "select public.rangebuddy_create_entry(1, null, 200, 10, 2, now())",
                "select public.rangebuddy_change_license_plate(1, null, 'BH99XYZ')",
            ]) await assert.rejects(sql(`set role ${role}; ${statement}`), /permission denied/);
        }
    });
});
