import { Router, json } from "express";
import { rateLimit } from "express-rate-limit";
import { rangeBuddyErrorHandler } from "./errors.js";
import { createRangeBuddyAuth, verifyAdminPassword } from "./security.js";
import { createRangeBuddyService } from "./service.js";
import {
    activationSchema, adminEntrySchema, adminMonthSchema, adminPlateSchema,
    deviceEntrySchema, deviceMonthSchema, devicePlateSchema, licensePlate,
} from "./validation.js";

export const createRangeBuddyRouter = ({ requireWebAdmin, database }) => {
    if (typeof requireWebAdmin !== "function") throw new Error("RangeBuddy requires the existing web admin authorizer");
    if (!database) throw new Error("RangeBuddy requires the existing Supabase client");
    const router = Router();
    const authenticate = createRangeBuddyAuth({ database, requireWebAdmin });
    const service = createRangeBuddyService(database);
    const passwordLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many password attempts. Try again in 15 minutes." },
    });

    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.use(json({ limit: "16kb" }));

    router.post("/activate", passwordLimiter, async (req, res) => {
        const input = activationSchema.parse(req.body);
        verifyAdminPassword(input.password);
        const { created, ...result } = await service.activate(input);
        res.status(created ? 201 : 200).json(result);
    });

    router.post("/entries", authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminEntrySchema : deviceEntrySchema;
        const entry = await service.createEntry(req.rangeBuddyAuth, schema.parse(req.body));
        res.status(201).json(entry);
    });

    router.get("/entries", authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminMonthSchema : deviceMonthSchema;
        res.json(await service.getEntries(req.rangeBuddyAuth, schema.parse(req.query)));
    });

    router.get("/vans/:licensePlate", authenticate, async (req, res) => {
        res.json(await service.getVan(req.rangeBuddyAuth, licensePlate.parse(req.params.licensePlate)));
    });

    router.put("/vans/license-plate", passwordLimiter, authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminPlateSchema : devicePlateSchema;
        const input = schema.parse(req.body);
        if (req.rangeBuddyAuth.type === "device") verifyAdminPassword(input.password);
        res.json(await service.changeLicensePlate(req.rangeBuddyAuth, input));
    });

    router.use(rangeBuddyErrorHandler);
    return router;
};
