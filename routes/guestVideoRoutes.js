// routes/guestVideoRoutes.js — Upload vidéo sans compte (invité)
import { Router } from "express";
import fs from "fs";
import path from "path";
import util from "util";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { upload } from "../services/uploadMiddleware.js";

const router = Router();
const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];
const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_DURATION_SEC = 30;

// Rate limit : 3 uploads invité par IP toutes les 15 min
const guestRateMap = new Map();
const GUEST_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const GUEST_MAX = 3;

function isGuestRateLimited(ip, now) {
  if (!ip) return false;
  const key = `guest_ip:${ip}`;
  const rec = guestRateMap.get(key) || { count: 0, first: now };
  if (now - rec.first > GUEST_WINDOW_MS) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  guestRateMap.set(key, rec);
  return rec.count > GUEST_MAX;
}

function getClientIp(req) {
  const xRealIp = req.headers["x-real-ip"];
  const xff = req.headers["x-forwarded-for"];
  if (typeof xRealIp === "string" && xRealIp.length > 0) return xRealIp;
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function sanitizeFileName(name = "video") {
  const base = String(name)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .trim();
  return base.length ? base : `video_${Date.now()}`;
}

async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${filePath}"`
    );
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

async function compressVideo(inputPath, outputPath) {
  await execAsync(
    `ffmpeg -y -i "${inputPath}" -vf "scale=720:-2" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`
  );
}

async function uploadToSupabase(filePath, storagePath) {
  const fileBuffer = await fs.promises.readFile(filePath);
  const { error } = await supabase.storage
    .from("videos")
    .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
  if (error) throw new Error("Erreur upload Supabase Storage");
  const { data } = supabase.storage.from("videos").getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error("URL publique Supabase introuvable");
  return data.publicUrl;
}

const tmpDir = path.join(__dirname, "..", "tmp");
const compressedDir = path.join(tmpDir, "compressed");

// POST /api/public/videos/upload
router.post("/upload", upload.single("video"), async (req, res) => {
  const { eventId, guestName } = req.body;
  const file = req.file;
  const ip = getClientIp(req);
  const now = Date.now();

  const cleanup = () => {
    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  };

  // Validation champs
  if (!eventId) { cleanup(); return res.status(400).json({ error: "eventId manquant." }); }
  const safeGuestName = String(guestName || "").trim().slice(0, 100);
  if (!safeGuestName) { cleanup(); return res.status(400).json({ error: "Ton prénom est requis." }); }
  if (!file) return res.status(400).json({ error: "Aucun fichier vidéo reçu." });

  // Rate limit
  if (isGuestRateLimited(ip, now)) {
    cleanup();
    return res.status(429).json({ error: "Trop d'envois. Réessaie dans 15 minutes." });
  }

  // MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cleanup();
    return res.status(400).json({ error: "Format non autorisé. Seules les vidéos MP4 et MOV sont acceptées." });
  }

  // Taille
  if (file.size > MAX_FILE_SIZE_BYTES) {
    cleanup();
    return res.status(400).json({ error: `Fichier trop lourd. Maximum : ${MAX_FILE_SIZE_MB} Mo.` });
  }

  let compressedFilePath = null;

  try {
    // Vérifier l'événement : doit être public + open
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, title, deadline, user_id, status, is_public")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      cleanup();
      return res.status(404).json({ error: "Événement introuvable." });
    }

    if (!event.is_public) {
      cleanup();
      return res.status(403).json({ error: "Cet événement n'accepte pas les participations sans compte." });
    }

    if (event.status !== "open") {
      cleanup();
      return res.status(400).json({ error: "Cet événement est clôturé et n'accepte plus de vidéos." });
    }

    if (event.deadline) {
      const deadline = new Date(event.deadline);
      deadline.setHours(23, 59, 59, 999);
      if (deadline < new Date()) {
        cleanup();
        return res.status(400).json({ error: "La date limite de participation est dépassée." });
      }
    }

    // Durée vidéo
    const duration = await getVideoDuration(file.path);
    if (duration && duration > MAX_DURATION_SEC) {
      cleanup();
      return res.status(400).json({ error: `La vidéo dépasse ${MAX_DURATION_SEC} secondes.` });
    }

    // Compression ffmpeg
    if (!fs.existsSync(compressedDir)) fs.mkdirSync(compressedDir, { recursive: true });

    const safeFileName = sanitizeFileName(file.originalname);
    const baseNoExt = safeFileName.replace(/\.[^.]+$/, "");
    compressedFilePath = path.join(compressedDir, `guest_${now}_${baseNoExt}.mp4`);

    await compressVideo(file.path, compressedFilePath);
    await fs.promises.unlink(file.path);

    // Upload Supabase Storage
    const storagePath = `submissions/${eventId}/guest/${now}-${baseNoExt}.mp4`;
    const publicUrl = await uploadToSupabase(compressedFilePath, storagePath);
    await fs.promises.unlink(compressedFilePath);
    compressedFilePath = null;

    // Insert en base (user_id = null)
    const { data: insertedVideo, error: insertError } = await supabase
      .from("videos")
      .insert([{
        event_id: eventId,
        user_id: null,
        guest_name: safeGuestName,
        participant_name: safeGuestName,
        storage_path: storagePath,
        video_url: publicUrl,
        status: "uploaded",
        duration: duration ?? null,
      }])
      .select()
      .single();

    if (insertError) {
      console.error("❌ Erreur insert guest video:", insertError);
      return res.status(500).json({ error: "Erreur lors de l'enregistrement. Merci de réessayer." });
    }

    console.log("✅ Guest video uploaded:", { eventId, guestName: safeGuestName, storagePath, ip });

    return res.status(200).json({
      message: "Vidéo envoyée avec succès !",
      video: insertedVideo,
      publicUrl,
    });
  } catch (err) {
    console.error("❌ Erreur guest upload:", err);
    cleanup();
    if (compressedFilePath && fs.existsSync(compressedFilePath)) {
      try { fs.unlinkSync(compressedFilePath); } catch {}
    }
    return res.status(500).json({ error: "Erreur interne lors du traitement de la vidéo." });
  }
});

export default router;
