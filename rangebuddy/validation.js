import { z } from "zod";
import { DateTime } from "luxon";

export const BUSINESS_TIMEZONE = "Europe/Bucharest";
const integer = z.number().int().min(0).max(2147483647);
const vanId = integer.min(1);
const activationCode = z.string().regex(/^\d{6}$/, "Enter the six-digit activation code");
export const licensePlate = z.string().trim().toUpperCase().min(1).max(20)
    .regex(/^[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/, "Invalid licence plate");
const fuelDate = z.iso.datetime({ offset: true })
    .refine((value) => DateTime.fromISO(value, { setZone: true }).isValid, "Invalid fuel date");

export const createVanSchema = z.object({ license_plate: licensePlate, initial_kms: integer }).strict();
export const redeemCodeSchema = z.object({ code: activationCode }).strict();
export const vanActionSchema = z.object({ van_id: vanId }).strict();
const entryFields = {
    current_kms: integer,
    litres: z.number().positive().max(9999999.999).multipleOf(0.001),
    price_per_litre: z.number().positive().max(99999.999).multipleOf(0.001),
    fuel_date: fuelDate,
};
export const deviceEntrySchema = z.object(entryFields).strict();
export const adminEntrySchema = deviceEntrySchema.extend({ van_id: vanId });
export const adminPlateSchema = z.object({ new_license_plate: licensePlate, van_id: vanId }).strict();
export const startSessionSchema = z.object({ van_id: vanId, start_kms: integer }).strict();
export const stopSessionSchema = z.object({ van_id: vanId, session_id: vanId }).strict();

const queryInteger = (min, max) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));
export const deviceSessionQuerySchema = z.object({}).strict();
export const adminSessionQuerySchema = z.object({ van_id: queryInteger(1, 2147483647) }).strict();
export const deviceEntriesSchema = z.object({}).strict();
export const adminMonthSchema = z.object({
    month: queryInteger(1, 12).optional(),
    year: queryInteger(2000, 2100).optional(),
    van_id: queryInteger(1, 2147483647).optional(),
}).strict();

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
