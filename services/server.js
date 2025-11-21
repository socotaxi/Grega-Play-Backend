import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import util from "util";
import { createClient } from "@supabase/supabase-js";
import fetch from "cross-fetch";

// ⚠️ Supabase client utilisé dans cette fonction sera défini plus bas
async function logRejectedUpload({
  req,
  reason,
  file = null,
  eventId = null,
  participantName = null,
  duration = null,
}) {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      "unknown";

    const userAgent = req.headers["user-agent"] || null;

    const rawRequest = {
      headers: req.headers,
      body: req.body,
      url: req.originalUrl,
      method: req.method,
    };

    await supabase.from("upload_logs").insert([
      {
        ip,
        event_id: eventId,
        participant_name: participantName,
        file_name: file?.originalname || null,
        mime_type: file?.mimetype || null,
        file_size: file?.size || null,
        duration,
        reason,
        user_agent: userAgent,
        raw_request: rawRequest,
      },
    ]);
  } catch (err) {
    console.error("❌ Échec du log Supabase :", err);
  }
}

global.fetch = fetch;

const execAsync = util.promisify(exec);
const app = express();

// 🔒 Middleware sécurité : vérifie la clé API dans le header
function apiKeyMiddleware(req, res, next) {
  const clientKey = req.headers["x-api-key"];

  if (!clientKey) {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }

  if (clientKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  next();
}

dotenv.config();

if (!process.env.API_SECRET) {
  console.error("❌ API_SECRET manquant dans les variables d'environnement.");
  process.exit(1);
}

console.log("🚀 Backend Grega Play lancé");
console.log("Node version:", process.version);
console.log("Process PID:", process.pid);
console.log("ENV PORT:", process.env.PORT);

process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("SIGTERM", () => {
  console.warn("⚠️ SIGTERM reçu, le container va s’arrêter.");
});

// 🌍 Config CORS
const allowedOrigins = [
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "https://grega-play-frontend.vercel.app",
  "https://gregaplay.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn("❌ Origin non autorisée :", origin);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    credentials: true,
  })
);

app.options("*", cors());

// 📋 Logger
app.use((req, res, next) => {
  console.log(
    `🌍 [${new Date().toISOString()}] ${req.method} ${req.originalUrl} | Origin: ${
      req.headers.origin || "N/A"
    }`
  );
  next();
});
app.use(express.json());

// 📂 Résolution chemins
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📂 Répertoire temporaire
const tmp = path.join(__dirname, "tmp");
if (!fs.existsSync(tmp)) {
  fs.mkdirSync(tmp);
}

// 🔐 Règles et helper pour la sécurité des fichiers vidéo
const ALLOWED_MIME_TYPES = ["video/mp4", "video/quicktime"];
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 Mo

function sanitizeFileName(originalName) {
  if (!originalName || typeof originalName !== "string") {
    return "video.mp4";
  }

  const lastDotIndex = originalName.lastIndexOf(".");
  const baseName =
    lastDotIndex > -1 ? originalName.slice(0, lastDotIndex) : originalName;
  const extension =
    lastDotIndex > -1 ? originalName.slice(lastDotIndex) : ".mp4";

  const safeBase =
    baseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // enlève les accents
      .replace(/[^a-zA-Z0-9]+/g, "-") // remplace tout ce qui n’est pas alphanumérique
      .replace(/^-+|-+$/g, "") // supprime les "-" au début/fin
      .substring(0, 50) || "video";

  return `${safeBase}${extension}`;
}

// ⚙️ Multer
const upload = multer({
  dest: tmp,
  limits: { fileSize: MAX_FILE_SIZE_BYTES }, // 50 MB
});

// 🔑 Supabase client
console.log("🔑 Vérification variables d'environnement :");
console.log(
  "   SUPABASE_URL:",
  process.env.SUPABASE_URL ? "OK" : "❌ MISSING"
);
console.log(
  "   SUPABASE_SERVICE_ROLE_KEY:",
  process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "❌ MISSING"
);

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// ======================================================
// 🚑 Route de test
// ======================================================
app.get("/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ======================================================
// ✅ Helper : récupérer la durée avec ffprobe
// ======================================================
async function getVideoDuration(filePath) {
  const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`;
  const { stdout } = await execAsync(cmd);
  return parseFloat(stdout);
}

// ======================================================
// ✅ Upload + compression vidéo avec limite 30s
// ======================================================
// 🔒 Toutes les routes /api doivent avoir x-api-key
app.use("/api", apiKeyMiddleware);

app.post(
  "/api/videos/upload-and-compress",
  upload.single("file"),
  async (req, res) => {
    const { eventId, participantName } = req.body;
    const file = req.file;

    // 🔍 Validations de base sur les champs
    if (!eventId || typeof eventId !== "string") {
      return res.status(400).json({ error: "eventId manquant ou invalide" });
    }

    if (!participantName || typeof participantName !== "string") {
      return res
        .status(400)
        .json({ error: "participantName manquant ou invalide" });
    }

    if (!file) {
      await logRejectedUpload({
        req,
        reason: "fichier_absent",
        eventId,
        participantName,
      });
      return res.status(400).json({ error: "Aucun fichier reçu" });
    }

    // 🔎 Taille excessive (défense supplémentaire, même si Multer limite déjà)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      await logRejectedUpload({
        req,
        reason: "taille_excessive",
        file,
        eventId,
        participantName,
      });
      return res.status(400).json({
        error: "Fichier trop volumineux (taille maximale 50 Mo).",
      });
    }

    // 🎯 Filtrage strict des types MIME autorisés
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      await logRejectedUpload({
        req,
        reason: "type_non_autorisé",
        file,
        eventId,
        participantName,
      });

      return res.status(400).json({
        error: "Type de fichier non autorisé. Formats acceptés : MP4, MOV.",
      });
    }

    // 🧼 Normalisation du nom de fichier
    const safeOriginalName = sanitizeFileName(file.originalname || "video.mp4");

    const rawPath = path.join(tmp, `raw-${Date.now()}-${safeOriginalName}`);
    const compressedPath = path.join(
      tmp,
      `compressed-${Date.now()}-${safeOriginalName}`
    );

    try {
      fs.copyFileSync(file.path, rawPath);

      // ✅ Vérifier durée max (30s)
      const duration = await getVideoDuration(rawPath);
      console.log(`🎞️ Durée détectée: ${duration}s`);
      if (duration > 30) {
        await logRejectedUpload({
          req,
          reason: "durée_excessive",
          file,
          eventId,
          participantName,
          duration,
        });

        fs.unlinkSync(rawPath);
        fs.unlinkSync(file.path);
        return res.status(400).json({
          error:
            "⛔ La vidéo dépasse la durée maximale autorisée (30 secondes).",
        });
      }

      // Compression si durée ok
      const cmd = `ffmpeg -y -i "${rawPath}" -vf "scale=640:-2" -b:v 800k -preset ultrafast "${compressedPath}"`;
      await execAsync(cmd);

      const buffer = fs.readFileSync(compressedPath);
      const filename = `compressed/${eventId}/${Date.now()}-${safeOriginalName}`;

      const { error: uploadError } = await supabase.storage
        .from("videos")
        .upload(filename, buffer, {
          contentType: "video/mp4",
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/videos/${filename}`;

      const { data: insertData, error: insertError } = await supabase
        .from("videos")
        .insert([
          {
            event_id: eventId,
            participant_name: participantName,
            storage_path: filename,
            video_url: publicUrl,
          },
        ])
        .select();
      if (insertError) throw insertError;

      // Nettoyage
      fs.unlinkSync(rawPath);
      fs.unlinkSync(compressedPath);
      fs.unlinkSync(file.path);

      res.status(200).json(insertData[0]);
    } catch (err) {
      console.error("❌ Erreur upload vidéo :", err);
      res.status(500).json({ error: "Erreur lors de l'upload vidéo" });
    }
  }
);

// ======================================================
// ✅ Récupérer les vidéos par événement
// ======================================================
app.get("/api/videos", async (req, res) => {
  const { eventId } = req.query;

  try {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .eq("event_id", eventId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Erreur récupération vidéos :", err);
    res.status(500).json({ error: "Erreur récupération vidéos" });
  }
});

// ======================================================
// ✅ Supprimer une vidéo
// ======================================================
app.delete("/api/videos/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("videos")
      .delete()
      .eq("id", id)
      .select();
    if (error) throw error;

    res.status(200).json(data[0]);
  } catch (err) {
    console.error("❌ Erreur suppression vidéo :", err);
    res.status(500).json({ error: "Erreur suppression vidéo" });
  }
});

// ======================================================
// ✅ Générer la vidéo finale
// ======================================================
app.post("/api/videos/process", async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) {
    return res.status(400).json({ error: "eventId manquant" });
  }
  try {
    const { default: processVideo } = await import("./processVideo.js");
    const finalVideoUrl = await processVideo(eventId);
    return res.status(200).json({ finalVideoUrl: finalVideoUrl });
  } catch (err) {
    console.error("❌ Erreur génération vidéo finale :", err);
    return res.status(500).json({
      error: err.message || "Erreur lors de la génération de la vidéo finale",
    });
  }
});

// ======================================================
// 🚀 Lancement serveur
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Grega Play en écoute sur le port ${PORT}`);
});
