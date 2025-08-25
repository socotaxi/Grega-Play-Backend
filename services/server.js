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

const execAsync = util.promisify(exec);
const app = express();
dotenv.config();

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
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.options("*", cors());

// 📋 Logger
app.use((req, res, next) => {
  console.log(
    `🌍 [${new Date().toISOString()}] ${req.method} ${req.originalUrl} | Origin: ${req.headers.origin || "N/A"}`
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

// ⚙️ Multer
const upload = multer({
  dest: tmp,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// 🔑 Supabase client
console.log("🔑 Vérification variables d'environnement :");
console.log("   SUPABASE_URL:", process.env.SUPABASE_URL ? "OK" : "❌ MISSING");
console.log("   SUPABASE_SERVICE_ROLE_KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "❌ MISSING");

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
// ✅ Upload + compression vidéo avec limite 10s
// ======================================================
app.post(
  "/api/videos/upload-and-compress",
  upload.single("file"),
  async (req, res) => {
    const { eventId, participantName } = req.body;
    const file = req.file;

    if (!eventId || !participantName || !file) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    const rawPath = path.join(tmp, `raw-${Date.now()}-${file.originalname}`);
    const compressedPath = path.join(
      tmp,
      `compressed-${Date.now()}-${file.originalname}`
    );

    try {
      fs.copyFileSync(file.path, rawPath);

      // ✅ Vérifier durée max (10s)
      const duration = await getVideoDuration(rawPath);
      console.log(`🎞️ Durée détectée: ${duration}s`);
      if (duration > 10) {
        fs.unlinkSync(rawPath);
        fs.unlinkSync(file.path);
        return res.status(400).json({
          error: "⛔ La vidéo dépasse la durée maximale autorisée (10 secondes).",
        });
      }

      // Compression si durée ok
      const cmd = `ffmpeg -y -i "${rawPath}" -vf "scale=640:-2" -b:v 800k -preset ultrafast "${compressedPath}"`;
      await execAsync(cmd);

      const buffer = fs.readFileSync(compressedPath);
      const filename = `compressed/${eventId}/${Date.now()}-${file.originalname}`;

      const { error: uploadError } = await supabase.storage
        .from("videos")
        .upload(filename, buffer, {
          contentType: "video/mp4",
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${filename}`;

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
    res.status(200).json({ videoUrl: finalVideoUrl });
  } catch (err) {
    console.error("❌ Erreur génération vidéo finale :", err);
    res.status(500).json({ error: "Erreur lors de la génération de la vidéo finale" });
  }
});

// ======================================================
// 🚀 Lancement serveur
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Grega Play en écoute sur le port ${PORT}`);
});
