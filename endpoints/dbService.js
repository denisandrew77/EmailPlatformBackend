import { Router } from "express";
import jwt from "jsonwebtoken";
import { supabase } from "../SupabaseClient/supabaseClient.js";
import { enqueueEmailJob, enqueueEmailJobs } from "../services/emailQueueService.js";
import { sendEmail } from "../services/emailSenderService.js";
import { hashPassword, isPasswordHash, verifyPassword } from "../services/passwordService.js";

export const dbRouter = Router();

const getAccessToken = (req) => {
    const authorization = req.headers.authorization;
    if (!authorization) return null;

    const [scheme, credentials] = authorization.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer") return credentials || null;

    // Keep accepting existing clients that send the raw JWT during migration.
    return authorization.trim();
};

const getAuthorizedUser = async (req) => {
    const token = getAccessToken(req);
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;

    try {
        const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        if (!payload?.id) return null;
        if (payload.userType === "external") return null;

        const { data: user, error } = await supabase
            .from("Users")
            .select("id, userName, adminRole")
            .eq("id", payload.id)
            .maybeSingle();

        if (error || !user) return null;

        return { token, payload, user };
    } catch {
        return null;
    }
};

const getAuthorizedExternalUser = async (req) => {
    const token = getAccessToken(req);
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;

    try {
        const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const hasExternalPayloadShape = payload?.userType === "external" || payload?.companyName || payload?.emailAddress;

        if (!payload?.id || !hasExternalPayloadShape) return null;

        let query = supabase
            .from("ExternalUsers")
            .select('id, emailAddress, companyName')
            .eq("id", payload.id);

        if (payload.emailAddress) {
            query = query.ilike("emailAddress", payload.emailAddress);
        }

        if (payload.companyName) {
            query = query.ilike("companyName", payload.companyName);
        }

        const { data: user, error } = await query.maybeSingle();

        if (error || !user) return null;

        return { token, payload, user };
    } catch {
        return null;
    }
};

const requireAuthenticatedUser = async (req, res, next) => {
    const user = await getAuthorizedUser(req);

    if (!user) {
        return res.status(401).json({ error: "Missing, invalid, or expired user token" });
    }

    req.user = user;
    next();
};

const requireAuthenticatedExternalUser = async (req, res, next) => {
    const user = await getAuthorizedExternalUser(req);

    if (!user) {
        const internalUser = await getAuthorizedUser(req);
        if (internalUser) {
            return res.status(403).json({ error: "External company user access required" });
        }

        return res.status(401).json({ error: "Missing, invalid, or expired external user token" });
    }

    req.externalUser = user;
    next();
};

const requireAuthenticatedInternalOrExternalUser = async (req, res, next) => {
    const internalUser = await getAuthorizedUser(req);

    if (internalUser) {
        req.user = internalUser;
        return next();
    }

    const externalUser = await getAuthorizedExternalUser(req);

    if (externalUser) {
        req.externalUser = externalUser;
        return next();
    }

    return res.status(401).json({ error: "Missing, invalid, or expired user token" });
};

const requireValidJwtToken = (req, res, next) => {
    const token = getAccessToken(req);

    if (!token || !process.env.ACCESS_TOKEN_SECRET) {
        return res.status(401).json({ error: "Missing, invalid, or expired user token" });
    }

    try {
        req.authPayload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        return next();
    } catch {
        return res.status(401).json({ error: "Missing, invalid, or expired user token" });
    }
};

const requireInternalUser = (req, res, next) => {
    if (!req.user) {
        return res.status(403).json({ error: "Internal application access required" });
    }

    next();
};

const requireAdmin = async (req, res) => {
    const user = await getAuthorizedUser(req);

    if (!user) {
        res.status(401).json({ error: "Missing or invalid user token" });
        return false;
    }

    if (!normalizeAdminRole(user.user.adminRole)) {
        res.status(403).json({ error: "Admin rights required" });
        return false;
    }

    req.user = user;
    return true;
};

const quotationCategoriesToTypeList = (quotation) => {
    const categories = [];

    if (quotation.threeTonnCategory) {
        categories.push("3.5T");
    }

    if (quotation.sevenTonnCategory) {
        categories.push("7.5T Truck - 24T Truck");
    }

    if (quotation.caddyCategory) {
        categories.push("Caddy");
    }

    return categories;
};

const toQuotationResponse = (quotation, goods, users = []) => ({
    id: quotation.id,
    dateSent: quotation.createdAt ? new Date(quotation.createdAt).toLocaleDateString("ro-RO") : "",
    sender: {
        postalCode: quotation.senderPostalCode,
        city: quotation.senderCity,
        country: quotation.senderCountry,
        date: quotation.senderDate,
        time: quotation.senderTime,
    },
    receiver: {
        postalCode: quotation.receiverPostalCode,
        city: quotation.receiverCity,
        country: quotation.receiverCountry,
        date: quotation.receiverDate,
        time: quotation.receiverTime,
    },
    goods: goods
        .filter((good) => good.quotationNumber === quotation.id)
        .map((good) => ({
            type: good.goodsType,
            number: good.goodsNumber,
            length: good.goodsLength,
            width: good.goodsWidth,
            height: good.goodsHeight,
            weight: good.goodsWeight,
            stack: good.goodsStack,
        })),
    observations: quotation.observations,
    type: quotationCategoriesToTypeList(quotation),
    userName: users.find((user) => user.id === quotation.userId)?.userName ?? "",
});

const normalizeAdminRole = (adminRole) => {
    return adminRole === true || adminRole === "true" || adminRole === "Admin";
};

const vehicleCategories = new Set(["Caddy", "3.5T", "7.5T Truck - 24T Truck"]);

const isValidAvailabilityDate = (date) => {
    return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
};

const getTimeZoneOffsetMs = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);

    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const zonedTimestamp = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second)
    );

    return zonedTimestamp - date.getTime();
};

const zonedDateTimeToUtc = (date, time, timeZone = process.env.AVAILABILITY_TIME_ZONE || "Europe/Bucharest") => {
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute, secondAndMs] = time.split(":");
    const [second, millisecond = "0"] = secondAndMs.split(".");
    const utcGuess = new Date(Date.UTC(
        year,
        month - 1,
        day,
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond.padEnd(3, "0"))
    ));
    const offset = getTimeZoneOffsetMs(utcGuess, timeZone);

    return new Date(utcGuess.getTime() - offset);
};

const addDaysToDateString = (date, days) => {
    const [year, month, day] = date.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day + days));

    return [
        utcDate.getUTCFullYear(),
        String(utcDate.getUTCMonth() + 1).padStart(2, "0"),
        String(utcDate.getUTCDate()).padStart(2, "0"),
    ].join("-");
};

const getAvailabilityExpiresAt = (availableDate) => {
    const nextDay = addDaysToDateString(availableDate, 1);

    return zonedDateTimeToUtc(nextDay, "00:00:00.000").toISOString();
};

const normalizeAvailabilityEntry = (entry) => ({
    country: String(entry?.country ?? "").trim().toUpperCase(),
    postalCode: String(entry?.postalCode ?? "").trim(),
    city: String(entry?.city ?? "").trim(),
    vehicleCategory: String(entry?.vehicleCategory ?? "").trim(),
    availabilityDate: String(entry?.availabilityDate ?? "").trim(),
});

const validateAvailabilityEntry = (entry, index) => {
    const missingFields = [];

    if (!entry.country) missingFields.push("country");
    if (!entry.city) missingFields.push("city");
    if (!entry.vehicleCategory) missingFields.push("vehicleCategory");
    if (entry.availabilityDate && !isValidAvailabilityDate(entry.availabilityDate)) {
        return {
            index,
            message: "Invalid availabilityDate",
        };
    }

    if (missingFields.length) {
        return {
            index,
            message: `Missing required fields: ${missingFields.join(", ")}`,
        };
    }

    if (!vehicleCategories.has(entry.vehicleCategory)) {
        return {
            index,
            message: "Invalid vehicle category",
        };
    }

    return null;
};

const toAvailabilityMapResponse = (availability, externalUsersById = new Map()) => ({
    id: availability.id,
    companyName: availability.companyName || "",
    emailAddress: availability.emailAddress || externalUsersById.get(availability.createdByExternalUserId)?.emailAddress || "",
    country: availability.country,
    postalCode: availability.postalCode,
    city: availability.city,
    latitude: Number(availability.latitude),
    longitude: Number(availability.longitude),
    vehicleCategory: availability.vehicleCategory,
    quantity: availability.quantity,
    notes: availability.notes,
    availableDate: availability.availableDate,
    expiresAt: availability.expiresAt,
    createdAt: availability.createdAt,
});

const geocodeAvailabilityEntry = async (entry) => {
    if (!process.env.GEOAPIFY_API_KEY) {
        throw new Error("GEOAPIFY_API_KEY is not configured");
    }

    const params = new URLSearchParams({
        city: entry.city,
        limit: "1",
        format: "json",
        apiKey: process.env.GEOAPIFY_API_KEY,
    });

    if (entry.postalCode) {
        params.set("postcode", entry.postalCode);
    }

    if (entry.country) {
        params.set("filter", `countrycode:${entry.country.toLowerCase()}`);
    }

    const response = await fetch(`https://api.geoapify.com/v1/geocode/search?${params.toString()}`);

    if (!response.ok) {
        throw new Error(`Geoapify request failed with status ${response.status}`);
    }

    const result = await response.json();
    const location = result?.results?.[0];

    if (!location || typeof location.lat !== "number" || typeof location.lon !== "number") {
        return null;
    }

    return {
        latitude: location.lat,
        longitude: location.lon,
        formattedAddress: location.formatted ?? "",
    };
};

const geocodeAvailabilityEntryWithFallback = async (entry) => {
    const directCoordinates = await geocodeAvailabilityEntry(entry);

    if (directCoordinates) {
        return directCoordinates;
    }

    if (!entry.postalCode || !entry.city) {
        return null;
    }

    return geocodeAvailabilityEntry({
        ...entry,
        postalCode: "",
    });
};

const escapeHtml = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

const normalizeEmail = (value) => {
    return String(value ?? "").trim().toLowerCase();
};

const getPublicBaseUrl = (req) => {
    return process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get("host")}`;
};

const createExternalUserSignInResponse = async (externalUser, password) => {
    if (!isPasswordHash(externalUser.password)) {
        await supabase
            .from("ExternalUsers")
            .update({ password: hashPassword(password) })
            .eq("id", externalUser.id);
    }

    const token = jwt.sign({
        id: externalUser.id,
        userName: externalUser.emailAddress,
        emailAddress: externalUser.emailAddress,
        userType: "external",
        companyName: externalUser.companyName,
        adminRole: false,
    }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "8h" });

    return {
        token,
        user: {
            id: externalUser.id,
            userName: externalUser.emailAddress,
            emailAddress: externalUser.emailAddress,
            userType: "external",
            companyName: externalUser.companyName,
            adminRole: false,
        },
    };
};

const createUnsubscribeUrl = (req, company) => {
    if (!process.env.ACCESS_TOKEN_SECRET) {
        throw new Error("ACCESS_TOKEN_SECRET is not configured");
    }

    const token = jwt.sign(
        {
            companyId: company.id,
            emailAddress: company.emailAddress,
            purpose: "unsubscribe",
        },
        process.env.ACCESS_TOKEN_SECRET
    );

    return `${getPublicBaseUrl(req)}/unsubscribe?token=${encodeURIComponent(token)}`;
};

dbRouter.post("/signIn", async (req, res) => {
    const { userName, password } = req.body;
    const loginIdentifier = String(userName ?? "").trim();

    if (!process.env.ACCESS_TOKEN_SECRET) {
        return res.status(500).json({ error: "ACCESS_TOKEN_SECRET is not configured" });
    }

    if (!loginIdentifier || typeof password !== "string") {
        return res.status(400).json({ error: "Username/email and password are required" });
    }

    const { data: user, error } = await supabase
        .from("Users")
        .select("*")
        .eq("userName", loginIdentifier)
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (user && verifyPassword(password, user.password)) {
        if (!isPasswordHash(user.password)) {
            await supabase
                .from("Users")
                .update({ password: hashPassword(password) })
                .eq("id", user.id);
        }

        const token = jwt.sign({
            id: user.id,
            userName: user.userName,
            userType: "internal",
            adminRole: user.adminRole,
        }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "8h" });

        return res.json({
            token,
            user: {
                id: user.id,
                userName: user.userName,
                userType: "internal",
                adminRole: user.adminRole,
            },
        });
    }

    const { data: externalUser, error: externalUserError } = await supabase
        .from("ExternalUsers")
        .select("*")
        .ilike("emailAddress", loginIdentifier)
        .maybeSingle();

    if (externalUserError) return res.status(500).json({ error: externalUserError.message });

    if (externalUser && verifyPassword(password, externalUser.password)) {
        const response = await createExternalUserSignInResponse(externalUser, password);
        return res.json(response);
    }

    return res.status(401).json(false);
});

dbRouter.post("/api/v1/external/register", async (req, res) => {
    const emailAddress = normalizeEmail(req.body.emailAddress);
    const password = String(req.body.password ?? "");
    const companyName = String(req.body.companyName ?? "").trim();

    if (!process.env.ACCESS_TOKEN_SECRET) {
        return res.status(500).json({ error: "ACCESS_TOKEN_SECRET is not configured" });
    }

    if (!emailAddress || !emailAddress.includes("@") || password.length < 8 || !companyName) {
        return res.status(400).json({
            error: "Email address, password with at least 8 characters, and company name are required",
        });
    }

    const { data: existingExternalUser, error: existingExternalUserError } = await supabase
        .from("ExternalUsers")
        .select("id")
        .ilike("emailAddress", emailAddress)
        .maybeSingle();

    if (existingExternalUserError) {
        return res.status(500).json({ error: existingExternalUserError.message });
    }

    if (existingExternalUser) {
        return res.status(409).json({ error: "An account already exists for this email address" });
    }

    const { data: externalUser, error: externalUserError } = await supabase
        .from("ExternalUsers")
        .insert({
            emailAddress,
            password: hashPassword(password),
            companyName,
        })
        .select("*")
        .single();

    if (externalUserError) {
        if (externalUserError.code === "23505") {
            return res.status(409).json({ error: "An account already exists for this email address" });
        }

        return res.status(500).json({ error: externalUserError.message });
    }

    const response = await createExternalUserSignInResponse(externalUser, password);
    return res.status(201).json(response);
});

dbRouter.get("/api/v1/auth/me", requireAuthenticatedUser, async (req, res) => {
    res.json({
        id: req.user.user.id,
        userName: req.user.user.userName,
        adminRole: req.user.user.adminRole,
    });
});

dbRouter.get("/getAllUsers", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { data, error } = await supabase
        .from("Users")
        .select("id, userName, adminRole")
        .order("id", { ascending: true });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

const handleCreateUser = async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { newUserName, userName, password, adminRole = false } = req.body;
    const normalizedUserName = newUserName ?? userName;

    if (!normalizedUserName || typeof password !== "string" || password.length < 8) {
        return res.status(400).json(false);
    }

    const { error } = await supabase
        .from("Users")
        .insert({
            userName: normalizedUserName,
            password: hashPassword(password),
            adminRole: normalizeAdminRole(adminRole),
        });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
};

dbRouter.post("/addUser", handleCreateUser);
dbRouter.post("/createUser", handleCreateUser);

dbRouter.post("/editUser", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { id, newUsername, userName, password, adminRole = false } = req.body;
    const normalizedUserName = newUsername ?? userName;

    if (!id || !normalizedUserName || (password && password.length < 8)) {
        return res.status(400).json(false);
    }

    const updates = {
        userName: normalizedUserName,
        adminRole: normalizeAdminRole(adminRole),
    };

    if (password) updates.password = hashPassword(password);

    const { error } = await supabase
        .from("Users")
        .update(updates)
        .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });

    res.json(true);
});

dbRouter.post("/deleteUser", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { id } = req.body;

    if (!id) {
        return res.status(400).json(false);
    }

    const { error } = await supabase
        .from("Users")
        .delete()
        .eq("id", id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
});

dbRouter.get("/unsubscribe", async (req, res) => {
    const { token } = req.query;

    if (!token || !process.env.ACCESS_TOKEN_SECRET) {
        return res.status(400).send("Invalid unsubscribe link.");
    }

    let payload;

    try {
        payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
        return res.status(400).send("Invalid or expired unsubscribe link.");
    }

    if (payload.purpose !== "unsubscribe" || !payload.companyId) {
        return res.status(400).send("Invalid unsubscribe link.");
    }

    const { data: company, error: companyError } = await supabase
        .from("Companies")
        .select("id, name, emailAddress, unsubscribed")
        .eq("id", payload.companyId)
        .maybeSingle();

    if (companyError) {
        return res.status(500).send("Unable to process unsubscribe request.");
    }

    if (!company) {
        return res.status(404).send("Company not found.");
    }

    if (!company.unsubscribed) {
        const { error: updateError } = await supabase
            .from("Companies")
            .update({ unsubscribed: true })
            .eq("id", company.id);

        if (updateError) {
            return res.status(500).send("Unable to unsubscribe this email address.");
        }
    }

    if (process.env.SES_FROM_EMAIL) {
        try {
            const companyName = company.name || "Unknown";

            await sendEmail({
                to: process.env.SES_FROM_EMAIL,
                subject: `Unsubscribe request: ${company.emailAddress}`,
                text: [
                    "A company unsubscribed from ByExpress transport offers.",
                    "",
                    `Company: ${companyName}`,
                    `Email: ${company.emailAddress}`,
                    `Company ID: ${company.id}`,
                ].join("\n"),
                html: `
                    <p>A company unsubscribed from ByExpress transport offers.</p>
                    <p><strong>Company:</strong> ${escapeHtml(companyName)}</p>
                    <p><strong>Email:</strong> ${escapeHtml(company.emailAddress)}</p>
                    <p><strong>Company ID:</strong> ${escapeHtml(company.id)}</p>
                `,
            });
        } catch (notificationError) {
            console.error("Failed to send unsubscribe notification", notificationError);
        }
    }

    res.send(`
        <!doctype html>
        <html>
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>Unsubscribed</title>
                <style>
                    body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #f4f7fb; color: #172033; }
                    .card { max-width: 560px; margin: 80px auto; background: #ffffff; border: 1px solid #d8e3ef; border-radius: 12px; padding: 32px; text-align: center; }
                    h1 { margin: 0 0 12px; color: #0b2a5b; }
                    p { margin: 0; line-height: 1.5; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>You have been unsubscribed</h1>
                    <p>${escapeHtml(company.emailAddress)} will no longer receive ByExpress transport offers.</p>
                </div>
            </body>
        </html>
    `);
});

dbRouter.get("/getAllCompanies", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { data, error } = await supabase
        .from("Companies")
        .select("id, name, country, fiscalCode, emailAddress, created_at, threeTonnCategory, sevenTonnCategory, caddyCategory, unsubscribed")
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

dbRouter.post("/addCompany", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const {
        name,
        country,
        fiscalCode,
        emailAddress,
        threeTonnCategory = false,
        sevenTonnCategory = false,
        caddyCategory = false,
    } = req.body;

    if (!name || !country || !fiscalCode || !emailAddress) {
        return res.status(400).json(false);
    }

    const { error } = await supabase
        .from("Companies")
        .insert({
            name,
            country,
            fiscalCode,
            emailAddress,
            threeTonnCategory: Boolean(threeTonnCategory),
            sevenTonnCategory: Boolean(sevenTonnCategory),
            caddyCategory: Boolean(caddyCategory),
        });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
});

dbRouter.post("/editCompany", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const {
        id,
        name,
        country,
        fiscalCode,
        emailAddress,
        threeTonnCategory = false,
        sevenTonnCategory = false,
        caddyCategory = false,
    } = req.body;

    if (!id || !name || !country || !fiscalCode || !emailAddress) {
        return res.status(400).json(false);
    }

    const { error } = await supabase
        .from("Companies")
        .update({
            name,
            country,
            fiscalCode,
            emailAddress,
            threeTonnCategory: Boolean(threeTonnCategory),
            sevenTonnCategory: Boolean(sevenTonnCategory),
            caddyCategory: Boolean(caddyCategory),
        })
        .eq("id", id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
});

dbRouter.post("/deleteCompany", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { id } = req.body;

    if (!id) {
        return res.status(400).json(false);
    }

    const { error } = await supabase
        .from("Companies")
        .delete()
        .eq("id", id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
});

dbRouter.post("/queueEmail", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const { to, subject, text, html, template, templateData, metadata = {} } = req.body;

    try {
        const messageId = await enqueueEmailJob({ to, subject, text, html, template, templateData, metadata });
        res.json({ queued: true, messageId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

dbRouter.post("/queueCompanyEmailCampaign", async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const {
        subject,
        text,
        html,
        template,
        templateData = {},
        observations,
        companyIds = [],
        threeTonnCategory = false,
        sevenTonnCategory = false,
        caddyCategory = false,
    } = req.body;

    if (!template && (!subject || (!text && !html))) {
        return res.status(400).json(false);
    }

    let query = supabase
        .from("Companies")
        .select("id, name, emailAddress, threeTonnCategory, sevenTonnCategory, caddyCategory, unsubscribed")
        .or("unsubscribed.is.false,unsubscribed.is.null");

    if (companyIds.length) {
        query = query.in("id", companyIds);
    } else if (threeTonnCategory || sevenTonnCategory || caddyCategory) {
        const selectedCategoryFilters = [
            threeTonnCategory ? "threeTonnCategory.eq.true" : null,
            sevenTonnCategory ? "sevenTonnCategory.eq.true" : null,
            caddyCategory ? "caddyCategory.eq.true" : null,
        ].filter(Boolean);

        if (selectedCategoryFilters.length === 1) {
            const [column] = selectedCategoryFilters[0].split(".");
            query = query.eq(column, true);
        } else {
            query = query.or(selectedCategoryFilters.join(","));
        }
    }

    const { data: companies, error } = await query;

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    console.log("Queue campaign observations present:", Boolean(String(observations ?? templateData.observations ?? "").trim()));

    const jobs = companies
        .filter((company) => company.emailAddress)
        .map((company) => ({
            to: company.emailAddress,
            subject,
            text,
            html,
            template,
            templateData: {
                ...templateData,
                observations: observations ?? templateData.observations ?? "",
                unsubscribeUrl: createUnsubscribeUrl(req, company),
                company,
            },
            metadata: {
                companyId: company.id,
                companyName: company.name,
                campaignType: "company",
            },
        }));

    try {
        const queued = await enqueueEmailJobs(jobs);
        res.json({ queued: true, count: queued.length, jobs: queued });
    } catch (queueError) {
        res.status(500).json({ error: queueError.message });
    }
});

dbRouter.post("/api/v1/availability", requireAuthenticatedExternalUser, async (req, res) => {
    const { availabilityDate, entries = [] } = req.body;

    if (!isValidAvailabilityDate(availabilityDate)) {
        return res.status(400).json({ error: "A valid availabilityDate is required" });
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: "At least one availability entry is required" });
    }

    const normalizedEntries = entries
        .map((entry) => {
            const normalizedEntry = normalizeAvailabilityEntry(entry);

            return {
                ...normalizedEntry,
                availabilityDate: normalizedEntry.availabilityDate || availabilityDate,
            };
        })
        .filter((entry) => entry.country || entry.postalCode || entry.city || entry.vehicleCategory);

    if (!normalizedEntries.length) {
        return res.status(400).json({ error: "At least one completed availability entry is required" });
    }

    const validationErrors = normalizedEntries
        .map((entry, index) => validateAvailabilityEntry(entry, index))
        .filter(Boolean);

    if (validationErrors.length) {
        return res.status(400).json({ error: "Invalid availability entries", details: validationErrors });
    }

    const geocodedEntries = [];
    const skippedEntries = [];

    try {
        for (const [index, entry] of normalizedEntries.entries()) {
            const coordinates = await geocodeAvailabilityEntryWithFallback(entry);

            if (!coordinates) {
                skippedEntries.push({
                    index,
                    entry,
                    message: `No coordinates found for ${entry.postalCode}, ${entry.city}, ${entry.country}`,
                });
                continue;
            }

            geocodedEntries.push({ ...entry, ...coordinates });
        }
    } catch (error) {
        console.error("Availability geocoding failed", error);
        return res.status(502).json({ error: error.message || "Availability geocoding failed" });
    }

    if (!geocodedEntries.length) {
        return res.status(400).json({
            error: "Unable to geocode any availability entries",
            skipped: skippedEntries,
        });
    }

    const rows = geocodedEntries.map((entry) => ({
        companyName: req.externalUser.user.companyName,
        emailAddress: req.externalUser.user.emailAddress,
        createdByExternalUserId: req.externalUser.user.id,
        country: entry.country,
        city: entry.city,
        postalCode: entry.postalCode,
        latitude: entry.latitude,
        longitude: entry.longitude,
        vehicleCategory: entry.vehicleCategory,
        quantity: 1,
        notes: entry.formattedAddress,
        availableDate: entry.availabilityDate,
        expiresAt: getAvailabilityExpiresAt(entry.availabilityDate),
        status: "active",
    }));

    const { data, error } = await supabase
        .from("VehicleAvailability")
        .insert(rows)
        .select("*");

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        created: true,
        count: data.length,
        skippedCount: skippedEntries.length,
        skipped: skippedEntries,
        availability: data,
    });
});

dbRouter.get("/api/v1/internal/availability", requireAuthenticatedUser, requireInternalUser, async (req, res) => {
    const now = new Date().toISOString();
    const { availableDate } = req.query;

    if (availableDate && !isValidAvailabilityDate(availableDate)) {
        return res.status(400).json({ error: "availableDate must use YYYY-MM-DD format" });
    }

    let availabilityQuery = supabase
        .from("VehicleAvailability")
        .select("*")
        .eq("status", "active")
        .gt("expiresAt", now)
        .not("latitude", "is", null)
        .not("longitude", "is", null);

    if (availableDate) {
        availabilityQuery = availabilityQuery.eq("availableDate", availableDate);
    }

    const { data: availabilityRows, error: availabilityError } = await availabilityQuery
        .order("availableDate", { ascending: true })
        .order("createdAt", { ascending: false });

    if (availabilityError) {
        return res.status(500).json({ error: availabilityError.message });
    }

    const externalUserIds = [...new Set(
        (availabilityRows ?? [])
            .map((row) => row.createdByExternalUserId)
            .filter(Boolean)
    )];
    let externalUsersById = new Map();

    if (externalUserIds.length) {
        const { data: externalUsers, error: externalUsersError } = await supabase
            .from("ExternalUsers")
            .select("id, emailAddress")
            .in("id", externalUserIds);

        if (externalUsersError) {
            return res.status(500).json({ error: externalUsersError.message });
        }

        externalUsersById = new Map(externalUsers.map((externalUser) => [externalUser.id, externalUser]));
    }

    res.json((availabilityRows ?? []).map((availability) => toAvailabilityMapResponse(availability, externalUsersById)));
});

dbRouter.post("/addQuotation", requireAuthenticatedUser, requireInternalUser, async (req, res) => {
    const {
        quotationNumber,
        senderPostalCode,
        senderCity,
        senderCountry,
        senderDate,
        senderTime,
        receiverPostalCode,
        receiverCity,
        receiverCountry,
        receiverDate,
        receiverTime,
        goods = [],
        threeTonnCategory = false,
        sevenTonnCategory = false,
        caddyCategory = false,
        observations = "",
    } = req.body;

    console.log("Add quotation observations present:", Boolean(String(observations).trim()));

    const { error: quotationError } = await supabase
        .from("Quotations")
        .insert({
            id: quotationNumber,
            userId: req.user.user.id,
            senderPostalCode,
            senderCity,
            senderCountry,
            senderDate,
            senderTime,
            receiverPostalCode,
            receiverCity,
            receiverCountry,
            receiverDate,
            receiverTime,
            threeTonnCategory: Boolean(threeTonnCategory),
            sevenTonnCategory: Boolean(sevenTonnCategory),
            caddyCategory: Boolean(caddyCategory),
            observations,
        });

    if (quotationError) {
        return res.status(500).json({ error: quotationError.message });
    }

    const goodsRows = goods.map((good) => ({
        quotationNumber,
        goodsType: good.type,
        goodsNumber: Number(good.number),
        goodsLength: Number(good.length),
        goodsWidth: Number(good.width),
        goodsHeight: Number(good.height),
        goodsWeight: Number(good.weight),
        goodsStack: Boolean(good.stack),
    }));

    if (goodsRows.length) {
        const { error: goodsError } = await supabase
            .from("Goods")
            .insert(goodsRows);

        if (goodsError) {
            await supabase.from("Quotations").delete().eq("id", quotationNumber);
            return res.status(500).json({ error: goodsError.message });
        }
    }

    res.json({
        created: true,
        observations,
    });
});

dbRouter.get("/getAllQuotations", requireAuthenticatedUser, requireInternalUser, async (req, res) => {
    const { data: quotations, error: quotationsError } = await supabase
        .from("Quotations")
        .select("*")
        .order("id", { ascending: true });

    if (quotationsError) {
        return res.status(500).json({ error: quotationsError.message });
    }

    const { data: goods, error: goodsError } = await supabase
        .from("Goods")
        .select("*");

    if (goodsError) {
        return res.status(500).json({ error: goodsError.message });
    }

    const { data: users, error: usersError } = await supabase
        .from("Users")
        .select("id, userName");

    if (usersError) {
        return res.status(500).json({ error: usersError.message });
    }

    res.json(quotations.map((quotation) => toQuotationResponse(quotation, goods, users)));
});

dbRouter.get("/getLastNumber", requireAuthenticatedUser, requireInternalUser, async (req, res) => {
    const { data, error } = await supabase
        .from("Quotations")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data?.id ?? 9999);
});
