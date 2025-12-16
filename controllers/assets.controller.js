// backend/controllers/assets.controller.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dossier temporaire
const TMP_DIR = path.join(__dirname, "..", "tmp", "premium-assets");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Types autorisés
const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];
const AUDIO_MIME = ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav"];

/**
 * Nettoie et sécurise le nom de fichier pour Supabase Storage
 * - supprime accents
 * - ASCII only
 * - limite longueur
 */
function sanitizeFileName(name = "file") {
  const ext = path.extname(name);
  const base = path.basename(name, ext);

  const safeBase =
    base
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "asset";

  return `${safeBase}${ext.toLowerCase()}`;
}

function guessKind(mimetype, declaredKind) {
  const k = (declaredKind || "").toLowerCase();
  if (k === "intro" || k === "outro") return "image";
  if (k === "music") return "audio";

  if (IMAGE_MIME.includes(mimetype)) return "image";
  if (AUDIO_MIME.includes(mimetype)) return "audio";
  return null;
}

function cleanupTmpFile(file) {
  try {
    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch {
    // no-op
  }
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return { client: null, error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant." };
  }

  return {
    client: createClient(supabaseUrl, supabaseServiceKey),
    error: null,
  };
}

// Multer
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

export const uploadPremiumAsset = [
  upload.single("file"),
  async (req, res) => {
    console.log("=== /api/assets/upload ===");
    console.log("BODY:", req.body);
    console.log("FILE:", req.file);

    const file = req.file;
    const { userId, kind, eventId } = req.body || {};

    try {
      const { client: supabase, error: envErr } = getSupabaseAdminClient();
      if (envErr || !supabase) {
        cleanupTmpFile(file);
        return res.status(500).json({
          error: "Configuration serveur incomplète (Supabase).",
          details: envErr,
        });
      }

      if (!userId) {
        cleanupTmpFile(file);
        return res.status(400).json({ error: "userId manquant." });
      }

      if (!file) {
        return res.status(400).json({
          error: "Aucun fichier reçu.",
          details: "Le champ FormData doit s'appeler 'file'.",
        });
      }

      const detected = guessKind(file.mimetype, kind);
      if (!detected) {
        cleanupTmpFile(file);
        return res.status(400).json({ error: "Type de fichier non autorisé." });
      }

      if (detected === "image" && !IMAGE_MIME.includes(file.mimetype)) {
        cleanupTmpFile(file);
        return res.status(400).json({ error: "Format image non autorisé." });
      }

      if (detected === "audio" && !AUDIO_MIME.includes(file.mimetype)) {
        cleanupTmpFile(file);
        return res.status(400).json({ error: "Format audio non autorisé." });
      }

      const bucket = "premium-assets";
      const safeName = sanitizeFileName(file.originalname || "asset");
      const ts = Date.now();

      const folder = eventId ? `events/${eventId}` : `users/${userId}`;
      const subFolder = detected === "image" ? "images" : "audio";
      const storagePath = `${folder}/${subFolder}/${ts}_${safeName}`;

      const buffer = await fs.promises.readFile(file.path);

      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .upload(storagePath, buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      cleanupTmpFile(file);

      if (uploadErr) {
        console.error("Supabase upload error:", uploadErr);
        return res.status(500).json({
          error: "Erreur upload premium-assets.",
          details: uploadErr.message,
          storagePath,
        });
      }

      const { data: signed, error: signedErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, 60 * 60);

      return res.status(200).json({
        ok: true,
        bucket,
        storagePath,
        signedUrl: signedErr ? null : signed?.signedUrl || null,
      });
    } catch (err) {
      console.error("UPLOAD PREMIUM ASSET ERROR:", err);
      cleanupTmpFile(file);
      return res.status(500).json({
        error: err?.message || "Erreur serveur upload asset.",
      });
    }
  },
];
