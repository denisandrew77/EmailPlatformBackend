import { RangeBuddyError, checkDatabaseError } from "./errors.js";
import { monthRange } from "./validation.js";
import { createActivationCode, createDeviceToken, hashActivationCode, hashDeviceToken } from "./security.js";
import { entryColumns, serializeEntry, serializeVan, vanColumns, serializeSession } from "./data.js";

export const createRangeBuddyService = (database) => ({
    async listVans() {
        const vans = [];
        while (true) {
            const { data, error, count } = await database.from("Vans")
                .select(`${vanColumns},token_hash`, { count: "exact" })
                .order("license_plate", { ascending: true }).order("id", { ascending: true })
                .range(vans.length, vans.length + 499);
            checkDatabaseError(error);
            vans.push(...data.map((van) => ({ ...serializeVan(van), phone_active: !!van.token_hash })));
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

    async updateSessionStart(input) {
        const { data, error } = await database.rpc("rangebuddy_update_session_start", {
            p_van_id: input.van_id, p_session_id: input.session_id, p_start_kms: input.start_kms,
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

    async createVan({ license_plate, initial_kms }) {
        const { data, error } = await database.rpc("rangebuddy_create_van", {
            p_license_plate: license_plate, p_initial_kms: initial_kms,
        });
        checkDatabaseError(error);
        return serializeVan(data);
    },

    async issueCode({ van_id }) {
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = createActivationCode();
            const { data, error } = await database.rpc("rangebuddy_issue_code", {
                p_van_id: van_id, p_code_hash: hashActivationCode(code),
            });
            if (error?.code === "23505" && attempt < 4) continue;
            checkDatabaseError(error);
            return { code, expires_at: data.expires_at };
        }
    },

    async redeemCode({ code }) {
        const token = createDeviceToken();
        const { data, error } = await database.rpc("rangebuddy_redeem_code", {
            p_code_hash: hashActivationCode(code),
            p_token_hash: hashDeviceToken(token),
        });
        checkDatabaseError(error);
        return { token, van: serializeVan(data.van), session: serializeSession(data.session) };
    },

    async revokePhone({ van_id }) {
        const { data, error } = await database.rpc("rangebuddy_revoke_phone", { p_van_id: van_id });
        checkDatabaseError(error);
        return data;
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

    async deleteEntry(entryId) {
        const { data, error } = await database.rpc("rangebuddy_delete_entry", { p_entry_id: entryId });
        checkDatabaseError(error);
        return data;
    },

    async updateEntry(entryId, input) {
        const { data: original, error: readError } = await database.from("FuelEntries")
            .select("fuel_date").eq("id", entryId).maybeSingle();
        checkDatabaseError(readError);
        if (!original) throw new RangeBuddyError(404, "Fuel entry not found", "RB_ENTRY_NOT_FOUND");
        const { data, error } = await database.rpc("rangebuddy_update_entry", {
            p_entry_id: entryId,
            p_current_kms: input.current_kms,
            p_litres: input.litres,
            p_price_per_litre: input.price_per_litre,
            p_fuel_date: original.fuel_date,
        });
        checkDatabaseError(error);
        return serializeEntry(data);
    },

    async getEntries(auth, query) {
        const isDevice = auth.type === "device";
        const session = isDevice ? await this.currentSession(auth, {}) : null;
        if (isDevice && !session) return [];
        const range = isDevice ? null : monthRange(query);
        const entries = [];
        // Fetch all results even when the Supabase API caps each response.
        while (true) {
            let request = database.from("FuelEntries")
                .select(`${entryColumns},van:Vans!van_id(${vanColumns})`, { count: "exact" })
                .order("fuel_date", { ascending: false })
                .order("id", { ascending: false })
                .range(entries.length, entries.length + 499);
            if (isDevice) request = request.eq("van_id", auth.vanId).eq("session_id", session.id);
            else {
                request = request.gte("fuel_date", range.start.toISOString())
                    .lt("fuel_date", range.end.toISOString());
                if (query.van_id) request = request.eq("van_id", query.van_id);
            }
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
