import { RangeBuddyError, checkDatabaseError } from "./errors.js";
import { monthRange } from "./validation.js";
import { createDeviceToken, hashDeviceToken } from "./security.js";
import { entryColumns, serializeEntry, serializeVan, vanColumns, serializeSession } from "./data.js";

export const createRangeBuddyService = (database) => ({
    async listVans() {
        const vans = [];
        while (true) {
            const { data, error, count } = await database.from("Vans")
                .select(vanColumns, { count: "exact" })
                .order("license_plate", { ascending: true }).order("id", { ascending: true })
                .range(vans.length, vans.length + 499);
            checkDatabaseError(error);
            vans.push(...data.map(serializeVan));
            if (!data.length || (count !== null && vans.length >= count)) return vans;
        }
    },
    async startSession(input) {
        const { data, error } = await database.rpc("rangebuddy_start_session", {
            p_van_id: input.van_id, p_start_kms: input.start_kms,
        });
        checkDatabaseError(error);
        return serializeSession(data);
    },

    async stopSession(input) {
        const { data, error } = await database.rpc("rangebuddy_stop_session", {
            p_van_id: input.van_id, p_session_id: input.session_id,
        });
        checkDatabaseError(error);
        return serializeSession(data);
    },

    async currentSession(auth, query) {
        const { data, error } = await database.rpc("rangebuddy_current_session", {
            p_van_id: auth.type === "device" ? auth.vanId : query.van_id,
            p_token_hash: auth.type === "device" ? auth.tokenHash : null,
        });
        checkDatabaseError(error);
        return serializeSession(data);
    },

    async activate({ license_plate, initial_kms }) {
        const token = createDeviceToken();
        const { data, error } = await database.rpc("rangebuddy_activate", {
            p_license_plate: license_plate,
            p_initial_kms: initial_kms,
            p_token_hash: hashDeviceToken(token),
        });
        checkDatabaseError(error);
        return { created: data.created, token, van: serializeVan(data.van) };
    },

    async createEntry(auth, input) {
        const { data, error } = await database.rpc("rangebuddy_create_entry", {
            p_van_id: auth.type === "device" ? auth.vanId : input.van_id,
            p_token_hash: auth.type === "device" ? auth.tokenHash : null,
            p_current_kms: input.current_kms,
            p_litres: input.litres,
            p_price_per_litre: input.price_per_litre,
            p_fuel_date: input.fuel_date,
        });
        checkDatabaseError(error);
        return serializeEntry(data);
    },

    async getEntries(auth, query) {
        const { start, end } = monthRange(query);
        const vanId = auth.type === "device" ? auth.vanId : query.van_id;
        const entries = [];
        // Fetch all monthly results even when the Supabase API caps each response.
        while (true) {
            let request = database.from("FuelEntries")
                .select(`${entryColumns},van:Vans!van_id(${vanColumns})`, { count: "exact" })
                .gte("fuel_date", start.toISOString())
                .lt("fuel_date", end.toISOString())
                .order("fuel_date", { ascending: false })
                .order("id", { ascending: false })
                .range(entries.length, entries.length + 499);
            if (vanId) request = request.eq("van_id", vanId);
            const { data, error, count } = await request;
            checkDatabaseError(error);
            entries.push(...data.map(serializeEntry));
            if (!data.length || (count !== null && entries.length >= count)) return entries;
        }
    },

    async getVan(auth, license_plate) {
        let request = database.from("Vans").select(vanColumns).eq("license_plate", license_plate);
        if (auth.type === "device") request = request.eq("id", auth.vanId);
        const { data, error } = await request.maybeSingle();
        checkDatabaseError(error);
        if (!data) throw new RangeBuddyError(404, "Van not found");
        return serializeVan(data);
    },

    async changeLicensePlate(auth, input) {
        const { data, error } = await database.rpc("rangebuddy_change_license_plate", {
            p_van_id: auth.type === "device" ? auth.vanId : input.van_id,
            p_token_hash: auth.type === "device" ? auth.tokenHash : null,
            p_new_license_plate: input.new_license_plate,
        });
        checkDatabaseError(error);
        return serializeVan(data);
    },
});
