import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dbRouter } from "./endpoints/dbService.js";
import { startEmailWorker } from "./workers/emailWorker.js";

dotenv.config();

const app = express();
const assetsPath = fileURLToPath(new URL("./assets", import.meta.url));

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
app.use("/assets", express.static(assetsPath));

app.get("/", (req, res) => {
    res.json({ message: "EmailApp backend running" });
});

app.use("/", dbRouter);

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

if (process.env.RUN_EMAIL_WORKER_IN_API === "true") {
    startEmailWorker();
}
