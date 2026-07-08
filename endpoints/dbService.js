import { Router } from "express";
import jwt from "jsonwebtoken";
import { supabase } from "../SupabaseClient/supabaseClient.js";
import { enqueueEmailJob, enqueueEmailJobs } from "../services/emailQueueService.js";
import { sendEmail } from "../services/emailSenderService.js";

export const dbRouter = Router();

const getAccessToken = (req) => {
    const authorization = req.headers.authorization;
    if (!authorization) return null;

    const [scheme, credentials] = authorization.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer") return credentials || null;

    // Keep accepting existing clients that send the raw JWT during migration.
    return authorization.trim();
};

const getAuthorizedUser = (req) => {
    const token = getAccessToken(req);
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;

    try {
        return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
        return null;
    }
};

const requireAuthenticatedUser = (req, res, next) => {
    const user = getAuthorizedUser(req);

    if (!user) {
        return res.status(401).json({ error: "Missing, invalid, or expired user token" });
    }

    req.user = user;
    next();
};

const getAuthorizedUserName = (req) => req.user?.userName ?? getAuthorizedUser(req)?.userName ?? null;

const requireAdmin = (req, res) => {
    const user = getAuthorizedUser(req);

    if (!user) {
        res.status(401).json({ error: "Missing or invalid user token" });
        return false;
    }

    if (!normalizeAdminRole(user.adminRole)) {
        res.status(403).json({ error: "Admin rights required" });
        return false;
    }

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

const escapeHtml = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

const getPublicBaseUrl = (req) => {
    return process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get("host")}`;
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

    const { data: user, error } = await supabase
        .from("Users")
        .select("id, userName, password, adminRole")
        .eq("userName", userName)
        .eq("password", password)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    if (!user) {
        return res.json(JSON.stringify(false));
    }

    if (!process.env.ACCESS_TOKEN_SECRET) {
        return res.status(500).json({ error: "ACCESS_TOKEN_SECRET is not configured" });
    }

    const token = jwt.sign(
        {
            userId: user.id,
            userName: user.userName,
            adminRole: user.adminRole,
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "10h" }
    );

    res.json({ token });
});

dbRouter.get("/getAllUsers", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { data, error } = await supabase
        .from("Users")
        .select("id, userName, password, adminRole")
        .order("id", { ascending: true });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

const handleCreateUser = async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { newUserName, password, adminRole = false } = req.body;

    if (!newUserName || !password) {
        return res.status(400).json(false);
    }

    const { data: existingUser, error: existingUserError } = await supabase
        .from("Users")
        .select("id")
        .eq("userName", newUserName)
        .maybeSingle();

    if (existingUserError) {
        return res.status(500).json({ error: existingUserError.message });
    }

    if (existingUser) {
        return res.json(false);
    }

    const { error } = await supabase
        .from("Users")
        .insert({
            userName: newUserName,
            password,
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
    if (!requireAdmin(req, res)) return;

    const { id, newUsername, password, adminRole = false } = req.body;

    if (!id || !newUsername || !password) {
        return res.status(400).json(false);
    }

    const { data: existingUser, error: existingUserError } = await supabase
        .from("Users")
        .select("id")
        .eq("userName", newUsername)
        .neq("id", id)
        .maybeSingle();

    if (existingUserError) {
        return res.status(500).json({ error: existingUserError.message });
    }

    if (existingUser) {
        return res.json(false);
    }

    const { error } = await supabase
        .from("Users")
        .update({
            userName: newUsername,
            password,
            adminRole: normalizeAdminRole(adminRole),
        })
        .eq("id", id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(true);
});

dbRouter.post("/deleteUser", async (req, res) => {
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

    const { to, subject, text, html, template, templateData, metadata = {} } = req.body;

    try {
        const messageId = await enqueueEmailJob({ to, subject, text, html, template, templateData, metadata });
        res.json({ queued: true, messageId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

dbRouter.post("/queueCompanyEmailCampaign", async (req, res) => {
    if (!requireAdmin(req, res)) return;

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

dbRouter.post("/addQuotation", requireAuthenticatedUser, async (req, res) => {
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

    const userName = getAuthorizedUserName(req);

    if (!userName) {
        return res.status(401).json({ error: "Missing or invalid user token" });
    }

    const { data: user, error: userError } = await supabase
        .from("Users")
        .select("id, userName")
        .eq("userName", userName)
        .single();

    if (userError || !user) {
        return res.status(401).json({ error: userError?.message ?? "User not found" });
    }

    const { error: quotationError } = await supabase
        .from("Quotations")
        .insert({
            id: quotationNumber,
            userId: user.id,
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

dbRouter.get("/getAllQuotations", requireAuthenticatedUser, async (req, res) => {
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

dbRouter.get("/getLastNumber", requireAuthenticatedUser, async (req, res) => {
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
