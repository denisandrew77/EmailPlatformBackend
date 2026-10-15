import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);
const testUrl = process.env.RANGEBUDDY_TEST_DATABASE_URL;
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);

test("RangeBuddy Supabase RPC functions on PostgreSQL", { skip: !testUrl }, async (t) => {
    const url = new URL(testUrl);
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/rangebuddy_test", "Only a disposable local rangebuddy_test database may be reset");
    const sql = async (statement) => {
        const { stdout } = await run("psql", [testUrl, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement]);
        return stdout.trim();
    };
    const rpc = async (statement) => JSON.parse(await sql(`set role service_role; select ${statement}`));
    const activate = (plate = "BH01ABC", hash = firstHash, kms = 100) => rpc(`public.rangebuddy_activate('${plate}', ${kms}, '${hash}')`);
    const createEntry = (id = 1, hash = firstHash, kms = 200) => rpc(`public.rangebuddy_create_entry(${id}, '${hash}', ${kms}, 53.72, 7.349, '2026-10-15T16:40:00+03:00')`);
    await sql(`do $$ begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    drop table if exists "FuelEntries", "Vans" cascade;`);
    await sql(await readFile(new URL("./fixtures/rangebuddy.sql", import.meta.url), "utf8"));
    const migration = await readFile(new URL("../migrations/007_rangebuddy_supabase_functions.sql", import.meta.url), "utf8");
    await sql(migration);
    await sql(migration);
    t.beforeEach(() => sql('truncate "FuelEntries", "Vans" restart identity'));

    await t.test("activation is normalized, returns safe data and rotation preserves history", async () => {
        const initial = await activate(" bh01abc ");
        assert.equal(initial.created, true);
        assert.equal(initial.van.license_plate, "BH01ABC");
        assert(!JSON.stringify(initial).includes("token_hash"));
        assert.equal(initial.van.activation_date, await sql("select (current_timestamp at time zone 'Europe/Bucharest')::date"));
        await createEntry();
        const rotated = await activate("BH01ABC", secondHash, 99999);
        assert.equal(rotated.created, false);
        assert.equal(rotated.van.id, initial.van.id);
        assert.equal(rotated.van.initial_kms, 100);
        assert.equal(rotated.van.last_kms, 200);
        assert.equal(await sql('select count(*) from "FuelEntries"'), "1");
        assert.equal(await sql('select token_hash from "Vans"'), secondHash);
        await assert.rejects(createEntry(1, firstHash, 300), /RB_INVALID_TOKEN/);
    });

    await t.test("concurrent first activations create one van and rotate its token", async () => {
        const results = await Promise.all([activate(), activate("BH01ABC", secondHash)]);
        assert.deepEqual(results.map(({ created }) => created).sort(), [false, true]);
        assert.equal(await sql('select count(*) from "Vans"'), "1");
        const activeHash = await sql('select token_hash from "Vans"');
        await createEntry(1, activeHash);
        await assert.rejects(createEntry(1, activeHash === firstHash ? secondHash : firstHash, 300), /RB_INVALID_TOKEN/);
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
        await assert.rejects(activate("", firstHash), /RB_INVALID_INPUT/);
        await assert.rejects(activate("BH01ABC", "plaintext-token"), /RB_INVALID_INPUT/);
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
                `select public.rangebuddy_activate('BH01ABC', 100, '${firstHash}')`,
                "select public.rangebuddy_create_entry(1, null, 200, 10, 2, now())",
                "select public.rangebuddy_change_license_plate(1, null, 'BH99XYZ')",
            ]) await assert.rejects(sql(`set role ${role}; ${statement}`), /permission denied/);
        }
    });
});
