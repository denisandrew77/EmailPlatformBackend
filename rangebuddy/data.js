export const vanColumns = "id,license_plate,activation_date,initial_kms,last_kms";
export const entryColumns = "id,van_id,current_kms,litres,price_per_litre,fuel_date";

export const serializeVan = (van) => Object.fromEntries(vanColumns.split(",").map((key) => [key, van[key]]));
export const serializeEntry = (entry) => ({
    ...Object.fromEntries(entryColumns.split(",").map((key) => [key, entry[key]])),
    ...(entry.van ? { van: serializeVan(entry.van) } : {}),
});
