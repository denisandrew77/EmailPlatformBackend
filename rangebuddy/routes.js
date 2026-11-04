import { Router, json, raw } from "express";
import { rateLimit } from "express-rate-limit";
import { rangeBuddyErrorHandler } from "./errors.js";
import { createRangeBuddyAuth } from "./security.js";
import { createRangeBuddyService } from "./service.js";
import { createRangeBuddyDocumentService, createRangeBuddySharedDocumentService } from "./documents.js";
import {
    adminEntrySchema, adminMonthSchema, adminPlateSchema,
    createVanSchema, redeemCodeSchema, vanActionSchema, updateVanDueDateSchema,
    deviceEntrySchema, deviceEntriesSchema, entryIdSchema, updateEntrySchema, licensePlate,
    startSessionSchema, stopSessionSchema, updateSessionStartSchema,
    deviceSessionQuerySchema, adminSessionQuerySchema,
} from "./validation.js";
import { vanDueDateFields } from "./data.js";
import { z } from "zod";

const documentTypeSchema = z.enum(vanDueDateFields);
const sharedDocumentTypeSchema = z.enum(["rcce_policy", "rcce_payment_confirmation"]);

export const createRangeBuddyRouter = ({ requireWebAdmin, database }) => {
    if (typeof requireWebAdmin !== "function") throw new Error("RangeBuddy requires the existing web admin authorizer");
    if (!database) throw new Error("RangeBuddy requires the existing Supabase client");
    const router = Router();
    const authenticate = createRangeBuddyAuth({ database, requireWebAdmin });
    const service = createRangeBuddyService(database);
    const documents = createRangeBuddyDocumentService(database);
    const sharedDocuments = createRangeBuddySharedDocumentService(database);
    const redemptionLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 5,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many activation attempts. Try again in 1 minute." },
    });

    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.use(json({ limit: "16kb" }));

    router.get("/vans", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.listVans());
    });
    router.post("/vans", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.status(201).json(await service.createVan(createVanSchema.parse(req.body)));
    });
    router.delete("/vans/:vanId", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.deleteVan(entryIdSchema.parse(req.params.vanId)));
    });
    router.post("/vans/code", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.status(201).json(await service.issueCode(vanActionSchema.parse(req.body)));
    });
    router.post("/vans/revoke-phone", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.revokePhone(vanActionSchema.parse(req.body)));
    });
    router.patch("/vans/due-date", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.updateVanDueDate(updateVanDueDateSchema.parse(req.body)));
    });
    router.get("/vans/:vanId/documents", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await documents.list(entryIdSchema.parse(req.params.vanId)));
    });
    router.get("/vans/:vanId/documents/:type/url", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await documents.signedUrl(
            entryIdSchema.parse(req.params.vanId), documentTypeSchema.parse(req.params.type),
        ));
    });
    router.post("/vans/:vanId/documents/:type", async (req, res, next) => {
        if (!(await requireWebAdmin(req, res))) return;
        raw({ type: () => true, limit: "5mb" })(req, res, next);
    }, async (req, res) => {
        res.status(201).json(await documents.upload(
            entryIdSchema.parse(req.params.vanId), documentTypeSchema.parse(req.params.type),
            req.body, req.headers["content-type"], req.headers["x-file-name"],
        ));
    });

    router.get("/documents", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await sharedDocuments.list());
    });
    router.get("/documents/:type/url", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await sharedDocuments.signedUrl(sharedDocumentTypeSchema.parse(req.params.type)));
    });
    router.post("/documents/:type", async (req, res, next) => {
        if (!(await requireWebAdmin(req, res))) return;
        raw({ type: () => true, limit: "5mb" })(req, res, next);
    }, async (req, res) => {
        res.status(201).json(await sharedDocuments.upload(
            sharedDocumentTypeSchema.parse(req.params.type), req.body,
            req.headers["content-type"], req.headers["x-file-name"],
        ));
    });

    // Only the existing web-admin JWT flow can change sessions, never a device token/password.
    router.post("/sessions/start", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.status(201).json(await service.startSession(startSessionSchema.parse(req.body)));
    });
    router.patch("/sessions/start-kms", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.updateSessionStart(updateSessionStartSchema.parse(req.body)));
    });
    router.post("/sessions/stop", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.stopSession(stopSessionSchema.parse(req.body)));
    });
    router.get("/sessions/current", authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminSessionQuerySchema : deviceSessionQuerySchema;
        res.json({ session: await service.currentSession(req.rangeBuddyAuth, schema.parse(req.query)) });
    });

    router.post("/redeem-code", redemptionLimiter, async (req, res) => {
        res.status(200).json(await service.redeemCode(redeemCodeSchema.parse(req.body)));
    });

    router.post("/entries", authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminEntrySchema : deviceEntrySchema;
        const entry = await service.createEntry(req.rangeBuddyAuth, schema.parse(req.body));
        res.status(201).json(entry);
    });

    router.get("/entries", authenticate, async (req, res) => {
        const schema = req.rangeBuddyAuth.type === "admin" ? adminMonthSchema : deviceEntriesSchema;
        res.json(await service.getEntries(req.rangeBuddyAuth, schema.parse(req.query)));
    });

    router.delete("/entries/:entryId", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.deleteEntry(entryIdSchema.parse(req.params.entryId)));
    });

    router.put("/entries/:entryId", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.updateEntry(
            entryIdSchema.parse(req.params.entryId), updateEntrySchema.parse(req.body),
        ));
    });

    router.get("/vans/:licensePlate", authenticate, async (req, res) => {
        res.json(await service.getVan(req.rangeBuddyAuth, licensePlate.parse(req.params.licensePlate)));
    });

    router.put("/vans/license-plate", async (req, res) => {
        if (!(await requireWebAdmin(req, res))) return;
        res.json(await service.changeLicensePlate({ type: "admin" }, adminPlateSchema.parse(req.body)));
    });

    router.use(rangeBuddyErrorHandler);
    return router;
};
