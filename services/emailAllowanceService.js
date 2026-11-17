import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

export const allowanceZone = "Europe/Bucharest";

export function allowancePeriod(resetDate, now = DateTime.now()) {
    const today = now.setZone(allowanceZone).startOf("day");
    const anchor = resetDate
        ? DateTime.fromISO(resetDate, { zone: allowanceZone })
        : today.startOf("month").plus({ months: 1 });
    let months = (today.year - anchor.year) * 12 + today.month - anchor.month;
    if (anchor.plus({ months }) <= today) months += 1;
    const end = anchor.plus({ months });
    return { start: anchor.plus({ months: months - 1 }), end };
}

export function validateAllowance(value, now = DateTime.now()) {
    const date = typeof value?.resetDate === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(value.resetDate)
        ? DateTime.fromISO(value.resetDate, { zone: allowanceZone }) : null;
    if (!Number.isSafeInteger(value?.monthlyLimit) || value.monthlyLimit < 0 || value.monthlyLimit > 2147483647) {
        return "Enter a whole email allowance between 0 and 2,147,483,647";
    }
    const today = now.setZone(allowanceZone).startOf("day");
    if (!date?.isValid || date <= today || date > today.plus({ days: 31 })) {
        return "Choose the next reset date within the coming month";
    }
    return null;
}

export async function getEmailAllowance(database) {
    const { data: config, error } = await database.from("email_allowance")
        .select("monthly_limit, reset_date, tracking_since").eq("id", true).single();
    if (error) throw error;
    const { start, end } = allowancePeriod(config.reset_date);
    const { data: total, error: countError } = await database.rpc("email_usage_total", {
        p_start: start.toUTC().toISO(), p_end: end.toUTC().toISO(),
    });
    if (countError) throw countError;
    const sent = Number(total);
    return {
        monthlyLimit: config.monthly_limit,
        resetDate: end.toISODate(),
        periodStart: start.toISODate(),
        sent,
        remaining: config.monthly_limit === null ? null : Math.max(0, config.monthly_limit - sent),
        trackingSince: config.tracking_since,
        timezone: allowanceZone,
    };
}

export async function recordEmailUsage(result, { logger = console } = {}) {
    const count = result?.data?.succeeded;
    if (!Number.isSafeInteger(count) || count <= 0) return;
    try {
        const { supabase } = await import("../SupabaseClient/supabaseClient.js");
        const { error } = await supabase.from("email_send_usage").upsert({
            id: result.data.email_id || randomUUID(), recipient_count: count,
        }, { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
    } catch (error) {
        // A tracking outage must not cause the worker to resend an accepted email.
        logger.error("Unable to record accepted email usage", error);
    }
}
