import { Router } from "express";
import jwt from "jsonwebtoken";
import { supabase } from "../SupabaseClient/supabaseClient.js";

export const dbRouter = Router();

const getAuthorizedUserName = (req) => {
    if (req.body?.userName) return req.body.userName;

    const token = req.headers.authorization;
    if (!token) return null;

    if (process.env.ACCESS_TOKEN_SECRET) {
        try {
            return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET).userName;
        } catch {
            return null;
        }
    }

    return jwt.decode(token)?.userName ?? null;
};

const getAuthorizedUser = (req) => {
    const token = req.headers.authorization;
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return null;

    try {
        return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
        return null;
    }
};

const requireAdmin = (req, res) => {
    const user = getAuthorizedUser(req);

    if (!user) {
        res.status(401).json({ error: "Missing or invalid user token" });
        return false;
    }

    if (user.adminRole !== true) {
        res.status(403).json({ error: "Admin rights required" });
        return false;
    }

    return true;
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
    type: quotation.types ? quotation.types.split("/") : [],
    userName: users.find((user) => user.id === quotation.userId)?.userName ?? "",
});

const normalizeAdminRole = (adminRole) => {
    return adminRole === true || adminRole === "true" || adminRole === "Admin";
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

dbRouter.post("/addQuotation", async (req, res) => {
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
        types,
        observations = "",
    } = req.body;

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
            types,
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

    res.json(true);
});

dbRouter.get("/getAllQuotations", async (req, res) => {
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

dbRouter.get("/getLastNumber", async (req, res) => {
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
