import { Router } from "express";
import { timingSafeEqual } from "node:crypto";

export const createSmtp2goWebhookRouter = (supabase) => {
    const router = Router();

    router.post("/api/v1/webhooks/smtp2go", async (req, res) => {
        const secret = process.env.SMTP2GO_WEBHOOK_SECRET;
        if (!secret) return res.status(503).json({ error: "SMTP2GO webhook is not configured" });

        const expected = Buffer.from(`Bearer ${secret}`);
        const supplied = Buffer.from(req.headers.authorization || "");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            return res.status(401).json({ error: "Invalid webhook credentials" });
        }

        const event = req.body;
        if (!event || typeof event.event !== "string") {
            return res.status(400).json({ error: "Invalid webhook event" });
        }

        const shouldSuppress = ["spam", "unsubscribe"].includes(event.event)
            || (event.event === "bounce" && event.bounce === "hard");
        if (!shouldSuppress) return res.sendStatus(204);

        const email = typeof event.rcpt === "string" ? event.rcpt.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) {
            return res.status(400).json({ error: "Missing recipient" });
        }

        try {
            // Escape LIKE wildcards so feedback only suppresses this exact address.
            const pattern = email.replace(/[\\%_]/g, "\\$&");
            const { error } = await supabase.from("Companies")
                .update({ unsubscribed: true })
                .ilike("emailAddress", pattern);
            if (error) throw error;
            return res.sendStatus(204);
        } catch {
            return res.status(500).json({ error: "Unable to process email feedback" });
        }
    });

    return router;
};
