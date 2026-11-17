import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import jwt from 'jsonwebtoken';
import { allowancePeriod, validateAllowance } from '../services/emailAllowanceService.js';
import { sendEmail } from '../services/emailSenderService.js';
const at = iso => DateTime.fromISO(iso, { zone: 'Europe/Bucharest' });
test('monthly reset preserves day through short months and rolls at midnight', () => {
    for (const [now, start, end] of [
        ['2026-02-27T23:59', '2026-01-31', '2026-02-28'],
        ['2026-02-28T00:00', '2026-02-28', '2026-03-31'],
        ['2026-12-31T00:00', '2026-12-31', '2027-01-31'],
        ['2028-02-29T00:00', '2028-02-29', '2028-03-31'],
    ]) {
        const period = allowancePeriod('2026-01-31', at(now));
        assert.equal(period.start.toISODate(), start);
        assert.equal(period.end.toISODate(), end);
    }
});
test('validates integer allowance and real upcoming date', () => {
    const now = at('2026-11-17T12:00');
    assert.equal(validateAllowance({ monthlyLimit: 0, resetDate: '2026-12-17' }, now), null);
    for (const value of [
        { monthlyLimit: -1, resetDate: '2026-12-01' },
        { monthlyLimit: 2.5, resetDate: '2026-12-01' },
        { monthlyLimit: '100', resetDate: '2026-12-01' },
        { monthlyLimit: 100, resetDate: '2026-11-17' },
        { monthlyLimit: 100, resetDate: '2026-12-19' },
        { monthlyLimit: 100, resetDate: '2026-02-30' },
    ]) assert.ok(validateAllowance(value, now));
});
test('partial sends record accepted recipients before reporting failure', async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { succeeded: 1, failed: 1 } }));
    const env = { ...process.env };
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SMTP2GO_FROM_EMAIL = 'sender@example.com';
    t.after(() => { process.env = env; });
    const counts = [];
    await assert.rejects(sendEmail({ to: ['a@example.com', 'b@example.com'], subject: 'test' }, async result => counts.push(result.data.succeeded)));
    assert.deepEqual(counts, [1]);
});
process.env.SUPABASE_URL = 'https://database.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.ACCESS_TOKEN_SECRET = 'test-allowance-secret';
const { dbRouter } = await import('../endpoints/dbService.js');
const route = method => dbRouter.stack.find(layer => layer.route?.path === '/api/v1/internal/email-allowance' && layer.route.methods[method]).route;
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const request = (payload = { id: 1 }) => ({ headers: { authorization: `Bearer ${jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET)}` } });
test('employee can read but cannot edit; external users cannot read', async t => {
    t.mock.method(globalThis, 'fetch', async input => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname.endsWith('/Users')) return Response.json({ id: 1, adminRole: false });
        if (url.pathname.endsWith('/email_allowance')) return Response.json({ monthly_limit: 100, reset_date: '2026-12-01', tracking_since: '2026-11-17T00:00:00Z' });
        if (url.pathname.endsWith('/rpc/email_usage_total')) return Response.json(25);
        assert.fail(`Unexpected request ${url.pathname}`);
    });
    const req = request(), res = response();
    let authorized = false;
    await route('get').stack[0].handle(req, res, () => { authorized = true; });
    assert.equal(authorized, true);
    await route('get').stack[1].handle(req, res);
    assert.equal(res.body.sent, 25);
    assert.equal(res.body.remaining, 75);
    const denied = response();
    await route('put').stack[0].handle(request(), denied);
    assert.equal(denied.code, 403);
    const external = response();
    await route('get').stack[0].handle(request({ id: 1, userType: 'external' }), external, () => assert.fail('External user authorized'));
    assert.equal(external.code, 401);
});
test('admin update persists limit and reset date', async t => {
    const tomorrow = DateTime.now().setZone('Europe/Bucharest').plus({ days: 1 }).toISODate();
    let updated;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname.endsWith('/Users')) return Response.json({ id: 1, adminRole: true });
        if (url.pathname.endsWith('/email_allowance')) {
            if (init.method === 'PATCH') {
                updated = JSON.parse(init.body);
                return new Response(null, { status: 204 });
            }
            return Response.json({ monthly_limit: 200, reset_date: tomorrow, tracking_since: '2026-11-17T00:00:00Z' });
        }
        return Response.json(10);
    });
    const res = response();
    await route('put').stack[0].handle({ ...request(), body: { monthlyLimit: 200, resetDate: tomorrow } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(updated, { monthly_limit: 200, reset_date: tomorrow });
    assert.equal(res.body.remaining, 190);
});
