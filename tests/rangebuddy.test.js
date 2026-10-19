import assert from "node:assert/strict";
import test from "node:test";
import { DateTime } from "luxon";
import { createActivationCode, createDeviceToken, hashActivationCode, hashDeviceToken } from "../rangebuddy/security.js";
import {
    createVanSchema, redeemCodeSchema, adminPlateSchema, adminEntrySchema, adminMonthSchema, deviceEntrySchema,
    deviceEntriesSchema, licensePlate, monthRange,
} from "../rangebuddy/validation.js";

const validEntry = { current_kms: 128450, litres: 53.72, price_per_litre: 7.349, fuel_date: "2026-10-15T16:40:00+03:00" };

test("device tokens are independent random 32-byte secrets stored as SHA-256 hashes", () => {
    const first = createDeviceToken();
    const second = createDeviceToken();
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    assert.notEqual(first, hashDeviceToken(first));
    assert.equal(hashDeviceToken(first).length, 64);
    assert.equal(hashDeviceToken(first), hashDeviceToken(first));
});

test("six-digit codes preserve leading zeros and are hashed before storage", () => {
    for (let i = 0; i < 50; i++) assert.match(createActivationCode(), /^\d{6}$/);
    assert.equal(hashActivationCode("042817").length, 64);
    assert.notEqual(hashActivationCode("042817"), "042817");
    assert(redeemCodeSchema.safeParse({ code: "042817" }).success);
    for (const code of ["42817", 42817, "1234567", "123abc", "123 456"]) {
        assert.equal(redeemCodeSchema.safeParse({ code }).success, false);
    }
});

test("activation and licence plate input is normalized and bounded", () => {
    assert.equal(licensePlate.parse("  bh01abc  "), "BH01ABC");
    const valid = { license_plate: "BH01ABC", initial_kms: 0 };
    assert(createVanSchema.safeParse(valid).success);
    for (const initial_kms of [-1, 1.5, "100", null, 2147483648]) {
        assert.equal(createVanSchema.safeParse({ ...valid, initial_kms }).success, false);
    }
    for (const plate of ["", "   ", "A".repeat(21), "ABC/123"]) assert.equal(licensePlate.safeParse(plate).success, false);
    assert.equal(createVanSchema.safeParse({ ...valid, password: "old" }).success, false);
    assert.equal(adminPlateSchema.safeParse({ new_license_plate: "BH02ABC" }).success, false);
});

test("fuel validation rejects invalid numbers, precision, timezone-less timestamps and impossible dates", () => {
    assert(deviceEntrySchema.safeParse(validEntry).success);
    for (const override of [
        { current_kms: -1 }, { current_kms: 0.5 }, { current_kms: "128450" },
        { litres: 0 }, { litres: -1 }, { litres: 1.2345 }, { litres: 10000000 },
        { price_per_litre: 0 }, { price_per_litre: Infinity }, { price_per_litre: 100000 },
        { fuel_date: "2026-02-30T12:00:00Z" }, { fuel_date: "2026-10-15T12:00:00" }, { fuel_date: "bad" },
    ]) assert.equal(deviceEntrySchema.safeParse({ ...validEntry, ...override }).success, false);
});

test("devices cannot submit van IDs or admin flags; admin writes require a valid van ID", () => {
    assert.equal(deviceEntrySchema.safeParse({ ...validEntry, van_id: 2 }).success, false);
    assert.equal(deviceEntrySchema.safeParse({ ...validEntry, isAdmin: true }).success, false);
    assert.equal(deviceEntriesSchema.safeParse({ van_id: "2" }).success, false);
    assert.equal(deviceEntriesSchema.safeParse({ month: "10", year: "2026" }).success, false);
    assert(deviceEntriesSchema.safeParse({}).success);
    assert.equal(adminEntrySchema.safeParse(validEntry).success, false);
    assert(adminEntrySchema.safeParse({ ...validEntry, van_id: 2 }).success);
    assert.equal(adminEntrySchema.safeParse({ ...validEntry, van_id: -2 }).success, false);
});

test("month query validation rejects invalid, repeated, fractional and nonnumeric parameters", () => {
    assert.deepEqual(adminMonthSchema.parse({ month: "10", year: "2026", van_id: "7" }), { month: 10, year: 2026, van_id: 7 });
    for (const input of [
        { month: "0" }, { month: "13" }, { month: "1.5" }, { month: "" }, { month: ["1", "2"] },
        { year: "1999" }, { year: "2101" }, { year: "year" }, { van_id: "0" }, { van_id: "2foo" },
    ]) assert.equal(adminMonthSchema.safeParse(input).success, false);
});

test("month ranges use Bucharest DST and exclusive next-month boundaries", () => {
    for (const [month, expectedStart, expectedEnd] of [
        [3, "2026-02-28T22:00:00.000Z", "2026-03-31T21:00:00.000Z"],
        [10, "2026-09-30T21:00:00.000Z", "2026-10-31T22:00:00.000Z"],
        [12, "2026-11-30T22:00:00.000Z", "2026-12-31T22:00:00.000Z"],
    ]) {
        const { start, end } = monthRange({ month, year: 2026 });
        assert.equal(start.toISOString(), expectedStart);
        assert.equal(end.toISOString(), expectedEnd);
    }
    const { start, end } = monthRange({}, DateTime.fromISO("2026-10-31T22:30:00Z"));
    assert.equal(start.toISOString(), "2026-10-31T22:00:00.000Z");
    assert.equal(end.toISOString(), "2026-11-30T22:00:00.000Z");
});
