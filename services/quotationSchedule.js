import { DateTime } from "luxon";

const timePattern = /^([01]?\d|2[0-3])[.:]([0-5]\d)$/;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

function scheduleValue(dateValue, timeValue) {
    if (typeof dateValue !== "string" || typeof timeValue !== "string") return null;
    if (!dateOnlyPattern.test(dateValue)) return null;
    const date = DateTime.fromISO(dateValue, { zone: "UTC" });
    const time = timeValue.trim().match(timePattern);
    if (!date.isValid || date.toISODate() !== dateValue || !time) return null;
    return `${dateValue}T${time[1].padStart(2, "0")}:${time[2]}`;
}

export function quotationScheduleError(loading, delivery) {
    const loadingValue = scheduleValue(loading?.date, loading?.time);
    const deliveryValue = scheduleValue(delivery?.date, delivery?.time);
    if (!loadingValue || !deliveryValue) return "Enter valid loading and delivery dates and times";
    if (loadingValue >= deliveryValue) return "Delivery date and time must be after loading date and time";
    return null;
}
