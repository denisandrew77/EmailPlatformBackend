import { z } from "zod";
import { DateTime } from "luxon";

export const BUSINESS_TIMEZONE = "Europe/Bucharest";
const integer = z.number().int().min(0).max(2147483647);
const vanId = integer.min(1);
const password = z.string().min(1).max(1024);
export const licensePlate = z.string().trim().toUpperCase().min(1).max(20)
    .regex(/^[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/, "Invalid licence plate");
const fuelDate = z.iso.datetime({ offset: true })
    .refine((value) => DateTime.fromISO(value, { setZone: true }).isValid, "Invalid fuel date");

export const activationSchema = z.object({ license_plate: licensePlate, initial_kms: integer, password }).strict();
const entryFields = {
    current_kms: integer,
    litres: z.number().positive().max(9999999.999).multipleOf(0.001),
    price_per_litre: z.number().positive().max(99999.999).multipleOf(0.001),
    fuel_date: fuelDate,
};
export const deviceEntrySchema = z.object(entryFields).strict();
export const adminEntrySchema = deviceEntrySchema.extend({ van_id: vanId });
export const devicePlateSchema = z.object({ new_license_plate: licensePlate, password }).strict();
export const adminPlateSchema = z.object({ new_license_plate: licensePlate, van_id: vanId }).strict();

const queryInteger = (min, max) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));
export const deviceMonthSchema = z.object({
    month: queryInteger(1, 12).optional(),
    year: queryInteger(2000, 2100).optional(),
}).strict();
export const adminMonthSchema = deviceMonthSchema.extend({ van_id: queryInteger(1, 2147483647).optional() });

export const businessNow = () => DateTime.now().setZone(BUSINESS_TIMEZONE);
export const monthRange = ({ month, year }, now = businessNow()) => {
    const localNow = now.setZone(BUSINESS_TIMEZONE);
    const start = DateTime.fromObject({
        year: year ?? localNow.year,
        month: month ?? localNow.month,
        day: 1,
    }, { zone: BUSINESS_TIMEZONE });
    return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
};
