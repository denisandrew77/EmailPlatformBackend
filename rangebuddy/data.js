export const vanColumns = "id,license_plate,activation_date,initial_kms,last_kms";
export const entryColumns = "id,van_id,current_kms,litres,price_per_litre,fuel_date,current_consumption,session_id";
export const sessionColumns = "id,van_id,start_kms,started_at,ended_at,is_active,average_consumption,average_fuel_price";
export const serializeSession = (session) => session
    ? Object.fromEntries(sessionColumns.split(",").map((key) => [key, session[key]])) : null;

export const serializeVan = (van) => Object.fromEntries(vanColumns.split(",").map((key) => [key, van[key]]));
export const serializeEntry = (entry) => ({
    ...Object.fromEntries(entryColumns.split(",").map((key) => [key, entry[key]])),
    ...(entry.van ? { van: serializeVan(entry.van) } : {}),
});
