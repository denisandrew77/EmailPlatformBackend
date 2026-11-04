import assert from "node:assert/strict";
import test from "node:test";
import { quotationScheduleError } from "../services/quotationSchedule.js";

const loading = { date: "2026-11-02", time: "10.00" };

test("quotation schedule requires delivery strictly after loading", () => {
    assert.equal(quotationScheduleError(loading, { date: loading.date, time: "10:01" }), null);
    assert.match(quotationScheduleError(loading, { date: loading.date, time: "10:00" }), /after loading/);
    assert.match(quotationScheduleError(loading, { date: loading.date, time: "09.59" }), /after loading/);
    assert.equal(quotationScheduleError(loading, { date: "2026-11-03", time: "08.00" }), null);
});

test("calendar dates are compared without a timezone conversion", () => {
    assert.equal(quotationScheduleError(
        { date: "2026-11-04", time: "11.00" },
        { date: "2026-11-05", time: "08.00" },
    ), null);
});

test("missing and malformed dates or times are rejected", () => {
    assert.match(quotationScheduleError(loading, { date: null, time: "11.00" }), /valid/);
    assert.match(quotationScheduleError(loading, { date: loading.date, time: "24.00" }), /valid/);
    assert.match(quotationScheduleError({ date: "not-a-date", time: "10.00" }, loading), /valid/);
    assert.match(quotationScheduleError({ date: "2026-11-04T22:00:00Z", time: "10.00" }, loading), /valid/);
    assert.match(quotationScheduleError({ date: "2026-02-30", time: "10.00" }, loading), /valid/);
});
