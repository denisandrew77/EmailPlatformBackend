import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dbRouter, requireAdmin } from "./endpoints/dbService.js";
import { createRangeBuddyRouter } from "./rangebuddy/routes.js";
import { startEmailWorker } from "./workers/emailWorker.js";
import { createSmtp2goWebhookRouter } from "./endpoints/smtp2goWebhook.js";
import { supabase } from "./SupabaseClient/supabaseClient.js";

dotenv.config();

const app = express();
// Render terminates HTTPS at its reverse proxy; use the client IP for rate limiting.
app.set("trust proxy", 1);
const assetsPath = fileURLToPath(new URL("./assets", import.meta.url));

app.use(cors());
app.use("/api/rangebuddy", createRangeBuddyRouter({ requireWebAdmin: requireAdmin, database: supabase }));
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
app.use("/assets", express.static(assetsPath));

app.get("/", (req, res) => {
    res.json({ message: "EmailApp backend running" });
});

app.use("/", dbRouter);
app.use(createSmtp2goWebhookRouter(supabase));

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

if (process.env.RUN_EMAIL_WORKER_IN_API === "true") {
    startEmailWorker();
}
