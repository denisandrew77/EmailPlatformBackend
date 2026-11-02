import { DateTime } from "luxon";

const timePattern = /^([01]?\d|2[0-3])[.:]([0-5]\d)$/;
const businessZone = "Europe/Bucharest";

function scheduleValue(dateValue, timeValue) {
    if (typeof dateValue !== "string" || typeof timeValue !== "string") return null;
    const date = DateTime.fromISO(dateValue, { zone: businessZone });
    const time = timeValue.trim().match(timePattern);
    if (!date.isValid || !time) return null;
    return `${date.toISODate()}T${time[1].padStart(2, "0")}:${time[2]}`;
}

export function quotationScheduleError(loading, delivery) {
    const loadingValue = scheduleValue(loading?.date, loading?.time);
    const deliveryValue = scheduleValue(delivery?.date, delivery?.time);
    if (!loadingValue || !deliveryValue) return "Enter valid loading and delivery dates and times";
    if (loadingValue >= deliveryValue) return "Delivery date and time must be after loading date and time";
    return null;
}
