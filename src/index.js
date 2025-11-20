import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import fetch from "node-fetch";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "movies";
const tmdbKey = process.env.TMDB_API_KEY || "";
const jwtSecret = process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || "dev_secret";

let Favorite;
let User;
if (mongoUri) {
  mongoose
    .connect(mongoUri, { dbName })
    .then(() => {
      const favoriteSchema = new mongoose.Schema(
        {
          tmdbId: { type: String },
          title: { type: String, required: true },
          description: { type: String },
          poster: { type: String },
          releaseDate: { type: String }
        },
        { timestamps: true }
      );
      Favorite = mongoose.models.Favorite || mongoose.model("Favorite", favoriteSchema);

      const userSchema = new mongoose.Schema(
        {
          email: { type: String, unique: true, required: true },
          passwordHash: { type: String, required: true },
          name: { type: String }
        },
        { timestamps: true }
      );
      User = mongoose.models.User || mongoose.model("User", userSchema);
    })
    .catch(() => {});
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "backend" });
});

app.get("/api/films", auth, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    if (!tmdbKey) return res.status(503).json({ error: "tmdb_key_missing" });

    let url;
    if (q) {
      url = new URL("https://api.themoviedb.org/3/search/movie");
      url.searchParams.set("query", q);
      url.searchParams.set("include_adult", "false");
    } else {
      url = new URL("https://api.themoviedb.org/3/movie/popular");
    }
    url.searchParams.set("api_key", tmdbKey);
    url.searchParams.set("language", process.env.TMDB_LANGUAGE || "es-ES");
    url.searchParams.set("page", String(page));

    const r = await fetch(url.toString());
    if (!r.ok) return res.status(502).json({ error: "external_api_error" });
    const data = await r.json();
    const items = Array.isArray(data.results)
      ? data.results.map(f => ({
          id: String(f.id),
          title: f.title || f.original_title || "",
          description: f.overview || "",
          poster: f.poster_path ? `https://image.tmdb.org/t/p/w500${f.poster_path}` : "",
          releaseDate: f.release_date || ""
        }))
      : [];
    res.json({ items, page: data.page || page, totalPages: data.total_pages || 1, total: data.total_results || items.length });
  } catch (e) {
    res.status(500).json({ error: "external_api_error" });
  }
});

app.get("/api/favorites", auth, async (req, res) => {
  try {
    if (!Favorite) return res.status(503).json({ error: "db_unavailable" });
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10) || 10, 1), 50);
    const skip = (page - 1) * limit;
    const total = await Favorite.countDocuments();
    const items = await Favorite.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    res.json({ items, page, totalPages, total });
  } catch (e) {
    res.status(500).json({ error: "db_error" });
  }
});

app.post("/api/favorites", auth, async (req, res) => {
  try {
    if (!Favorite) return res.status(503).json({ error: "db_unavailable" });
    const { title, description = "", poster = "", releaseDate = "", tmdbId = "" } = req.body || {};
    const validTitle = typeof title === "string" && title.trim().length > 0 && title.trim().length <= 200;
    const validPoster = typeof poster === "string" && poster.length <= 1000;
    const validDescription = typeof description === "string" && description.length <= 5000;
    const validRelease = typeof releaseDate === "string" && releaseDate.length <= 50;
    const validTmdbId = typeof tmdbId === "string" && tmdbId.length <= 50;
    if (!validTitle || !validPoster || !validDescription || !validRelease || !validTmdbId) {
      return res.status(400).json({ error: "invalid_payload" });
    }
    const doc = await Favorite.create({ title: title.trim(), description, poster, releaseDate, tmdbId });
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ error: "invalid_payload" });
  }
});

app.delete("/api/favorites/:id", auth, async (req, res) => {
  try {
    if (!Favorite) return res.status(503).json({ error: "db_unavailable" });
    const { id } = req.params;
    const r = await Favorite.findByIdAndDelete(id);
    if (!r) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: "invalid_id" });
  }
});

const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(port, () => {});
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ error: "unauthorized" });
    const payload = jwt.verify(token, jwtSecret);
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!User) return res.status(503).json({ error: "db_unavailable" });
    const { email, password, name = "" } = req.body || {};
    const e = typeof email === "string" ? email.trim().toLowerCase() : "";
    const p = typeof password === "string" ? password : "";
    if (!e || !p || p.length < 6) return res.status(400).json({ error: "invalid_payload" });
    const exists = await User.findOne({ email: e });
    if (exists) return res.status(409).json({ error: "email_exists" });
    const hash = await bcrypt.hash(p, 10);
    const u = await User.create({ email: e, passwordHash: hash, name });
    const token = jwt.sign({ uid: String(u._id) }, jwtSecret, { expiresIn: "7d" });
    res.status(201).json({ token });
  } catch {
    res.status(500).json({ error: "auth_error" });
  }
});

export default app;

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!User) return res.status(503).json({ error: "db_unavailable" });
    const { email, password } = req.body || {};
    const e = typeof email === "string" ? email.trim().toLowerCase() : "";
    const p = typeof password === "string" ? password : "";
    if (!e || !p) return res.status(400).json({ error: "invalid_payload" });
    const u = await User.findOne({ email: e });
    if (!u) return res.status(401).json({ error: "invalid_credentials" });
    const ok = await bcrypt.compare(p, u.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });
    const token = jwt.sign({ uid: String(u._id) }, jwtSecret, { expiresIn: "7d" });
    res.json({ token });
  } catch {
    res.status(500).json({ error: "auth_error" });
  }
});