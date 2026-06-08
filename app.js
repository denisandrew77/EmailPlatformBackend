import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

app.get("/", (req, res) => {
    res.json({ message: "EmailApp backend running" });
});
app.get("/getAllQuotations", async (req, res) => {
    const { data, error } = await supabase
        .from("Quotations")
        .select(`
      *,
      Goods (*)
    `);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});