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
import notificationsRouter from "../routes/notifications.js";
import { sendPushNotification } from "./pushService.js"; // 🔔 envoi des push
import emailRoutes from "../routes/emailRoutes.js"; // 📧 routes email backend
import whatsappAuthRoutes from "../routes/whatsappAuthRoutes.js"; // 📱 login téléphone / WhatsApp
import emailService from "./emailService.js"; // ✅ nécessaire pour /api/events/:eventId/remind

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
  "http://localhost:3000",
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

// 🔔 Notifs : helper quand une nouvelle vidéo est envoyée (créateur uniquement)
async function notifyEventOwnerOnNewVideo(eventId, participantName) {
  try {
    const { data: events, error: eventError } = await supabase
      .from("events")
      .select("user_id, title, enable_notifications") // prise en compte du toggle
      .eq("id", eventId)
      .limit(1);

    if (eventError || !events || events.length === 0) {
      console.warn(
        "⚠️ Impossible de récupérer l'événement pour la notif (nouvelle vidéo):",
        eventError
      );
      return;
    }

    const event = events[0];

    // respect du choix du créateur
    if (event.enable_notifications === false) {
      console.log(
        `ℹ️ Notifications désactivées pour l'événement ${eventId} (nouvelle vidéo), aucun envoi.`
      );
      return;
    }

    const { data: subs, error: subsError } = await supabase
      .from("notification_subscriptions")
      .select("*")
      .eq("user_id", event.user_id);

    if (subsError || !subs || subs.length === 0) {
      console.log(
        "ℹ️ Aucun abonnement push pour ce créateur (nouvelle vidéo), aucun envoi."
      );
      return;
    }

    const payload = {
      title: "Nouvelle vidéo reçue 🎬",
      body: `${participantName} a envoyé une vidéo pour l'événement "${event.title}".`,
      url: `https://gregaplay.com/dashboard`,
    };

    for (const sub of subs) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await sendPushNotification(subscription, payload);
      } catch (err) {
        console.error("❌ Erreur envoi push (nouvelle vidéo):", err);
      }
    }
  } catch (err) {
    console.error("❌ Erreur notifyEventOwnerOnNewVideo:", err);
  }
}

// 🔔 Notifs : helper quand la vidéo finale est prête (créateur + invités)
async function notifyEventUsersOnFinalVideo(eventId, finalVideoUrl) {
  try {
    // 1) Récupérer l'événement (créateur + titre + choix notifs)
    const { data: events, error: eventError } = await supabase
      .from("events")
      .select("id, user_id, title, enable_notifications")
      .eq("id", eventId)
      .limit(1);

    if (eventError || !events || events.length === 0) {
      console.warn(
        "⚠️ Impossible de récupérer l'événement pour la notif (vidéo finale):",
        eventError
      );
      return;
    }

    const event = events[0];

    // notifications désactivées pour cet event
    if (event.enable_notifications === false) {
      console.log(
        `ℹ️ Notifications désactivées pour l'événement ${eventId} (vidéo finale), aucun envoi.`
      );
      return;
    }

    // 2) Récupérer les invités (participants) de l'événement
    const { data: participants, error: participantsError } = await supabase
      .from("event_participants")
      .select("user_id")
      .eq("event_id", eventId)
      .eq("status", "accepted");

    if (participantsError) {
      console.error(
        "❌ Erreur récupération participants pour notif vidéo finale:",
        participantsError
      );
    }

    const participantUserIds = (participants || []).map((p) => p.user_id);

    // 3) Construire la liste de tous les user_ids à notifier (créateur + invités)
    const allUserIds = Array.from(
      new Set([event.user_id, ...participantUserIds])
    );

    if (allUserIds.length === 0) {
      console.log(
        "ℹ️ Aucun utilisateur à notifier pour cette vidéo finale (liste userIds vide)."
      );
      return;
    }

    // 4) Récupérer toutes les subscriptions de ces users
    const { data: subs, error: subsError } = await supabase
      .from("notification_subscriptions")
      .select("*")
      .in("user_id", allUserIds);

    if (subsError || !subs || subs.length === 0) {
      console.log(
        "ℹ️ Aucun abonnement push trouvé pour ces utilisateurs (vidéo finale)."
      );
      return;
    }

    // 5) Envoyer la notif adaptée à chacun
    for (const sub of subs) {
      const isOwner = sub.user_id === event.user_id;

      const payload = isOwner
        ? {
            title: "Ta vidéo finale est prête 🎉",
            body: `La vidéo finale de l'événement "${event.title}" est maintenant disponible.`,
            url: finalVideoUrl || "https://gregaplay.com/dashboard",
          }
        : {
            title: "La vidéo finale est prête 🎉",
            body: `La vidéo finale de l'événement "${event.title}" est prête. Le créateur pourra te la partager bientôt.`,
            url: "https://gregaplay.com/dashboard",
          };

      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await sendPushNotification(subscription, payload);
      } catch (err) {
        console.error("❌ Erreur envoi push (vidéo finale - user):", err);
      }
    }
  } catch (err) {
    console.error("❌ Erreur notifyEventUsersOnFinalVideo:", err);
  }
}

// Routes notifications (pas protégées par x-api-key)
app.use("/api/notifications", notificationsRouter);

// ======================================================
// 🚑 Route de test
// ======================================================
app.get("/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ======================================================
// ✅ Route publique pour la vidéo finale (lien propre)
// ======================================================
app.get("/api/public/final-video/:publicCode", async (req, res) => {
  try {
    const { publicCode } = req.params;

    const { data: event, error } = await supabase
      .from("events")
      .select(
        `
        id,
        title,
        description,
        theme,
        deadline,
        final_video_url,
        status,
        user_id
      `
      )
      .eq("public_code", publicCode)
      .single();

    if (error || !event) {
      console.error(
        "❌ Événement introuvable pour public_code:",
        publicCode,
        error
      );
      return res.status(404).json({ message: "Événement introuvable" });
    }

    if (!event.final_video_url) {
      return res
        .status(400)
        .json({ message: "La vidéo finale n’est pas encore disponible." });
    }

    return res.json({
      title: event.title,
      description: event.description,
      theme: event.theme,
      deadline: event.deadline,
      finalVideoUrl: event.final_video_url,
    });
  } catch (err) {
    console.error("❌ Erreur route /api/public/final-video :", err);
    return res.status(500).json({ message: "Erreur serveur" });
  }
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
// 📱 Routes OTP WhatsApp (publiques, pas de x-api-key)
// ======================================================
app.use("/auth", whatsappAuthRoutes);

// ======================================================
// ✅ Upload + compression vidéo avec limite 30s
// ======================================================
// 🔒 Toutes les routes /api doivent avoir x-api-key
app.use("/api", apiKeyMiddleware);

// 📧 Routes email (protégées par x-api-key)
app.use("/api/email", emailRoutes);

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

    // 🔒 Vérifier si le participant est le créateur OU un invité
    try {
      const participantEmailNorm = participantName.trim().toLowerCase();

      // 1) Récupérer l'événement pour connaître le user_id du créateur
      const { data: eventRow, error: eventErr } = await supabase
        .from("events")
        .select("id, user_id")
        .eq("id", eventId)
        .single();

      if (eventErr || !eventRow) {
        console.error("❌ Erreur récupération event pour vérif créateur:", eventErr);
        return res
          .status(404)
          .json({ error: "Événement introuvable pour le contrôle d’invitation." });
      }

      // 2) Récupérer l'email du créateur dans profiles
      const { data: ownerProfile, error: ownerErr } = await supabase
        .from("profiles")
        .select("email")
        .eq("id", eventRow.user_id)
        .single();

      if (ownerErr) {
        console.error("❌ Erreur récupération profil créateur:", ownerErr);
      }

      let isCreator = false;
      if (ownerProfile?.email) {
        const ownerEmailNorm = ownerProfile.email.trim().toLowerCase();
        isCreator = ownerEmailNorm === participantEmailNorm;
      }

      if (!isCreator) {
        // 3) Si ce n'est pas le créateur → vérifier s'il est invité
        const { data: invites, error: inviteErr } = await supabase
          .from("invitations")
          .select("email")
          .eq("event_id", eventId)
          .eq("email", participantName);

        if (inviteErr) {
          console.error("❌ Erreur vérification invitation:", inviteErr);
          return res
            .status(500)
            .json({ error: "Erreur interne (invitation check)" });
        }

        if (!invites || invites.length === 0) {
          await logRejectedUpload({
            req,
            reason: "non_invité",
            file,
            eventId,
            participantName,
          });

          return res.status(403).json({
            error: "NOT_INVITED",
            message:
              "Tu n'as pas été invité à cet événement. Impossible d'envoyer une vidéo.",
          });
        }
      }
    } catch (err) {
      console.error("❌ Erreur inattendue vérification créateur/invitation:", err);
      return res
        .status(500)
        .json({ error: "Erreur interne lors du contrôle d'invitation." });
    }

    // 🔒 Contrôle : 1 seule vidéo par participant sur compte gratuit
    try {
      const { data: existingVideos, error: existingError } = await supabase
        .from("videos")
        .select("id")
        .eq("event_id", eventId)
        .eq("participant_name", participantName);

      if (existingError) {
        console.error("❌ Erreur contrôle quota vidéos:", existingError);
        return res.status(500).json({
          error: "Erreur interne lors du contrôle du quota.",
        });
      }

      const isPremium = false; // sera branché plus tard sur un vrai statut Premium

      if (!isPremium && existingVideos && existingVideos.length >= 1) {
        await logRejectedUpload({
          req,
          reason: "quota_free_max_1_video",
          file,
          eventId,
          participantName,
        });

        return res.status(403).json({
          error: "MAX_FREE_VIDEOS_PER_EVENT_REACHED",
          message:
            "Avec un compte gratuit, tu peux envoyer une seule vidéo par événement. Passe en Premium pour en ajouter d'autres.",
        });
      }
    } catch (err) {
      console.error("❌ Erreur inattendue contrôle quota:", err);
      return res.status(500).json({
        error: "Erreur interne lors du contrôle du quota.",
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

      // 🔔 Notifier le créateur de l'évènement (nouvelle vidéo)
      notifyEventOwnerOnNewVideo(eventId, participantName).catch((err) =>
        console.error("❌ Erreur notif nouvelle vidéo:", err)
      );

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
// ✅ Générer la vidéo finale (avec sélection 2–5 vidéos)
// ======================================================
app.post("/api/videos/process", async (req, res) => {
  const { eventId, selectedVideoIds } = req.body;

  if (!eventId) {
    return res.status(400).json({ error: "eventId manquant" });
  }

  // Règle gratuite : 2 à 5 vidéos sélectionnées
  if (!Array.isArray(selectedVideoIds) || selectedVideoIds.length < 2) {
    return res.status(400).json({
      error: "Sélectionne au moins 2 vidéos pour générer la vidéo finale.",
    });
  }

  const isPremium = false; // sera branché plus tard sur un vrai statut Premium

  if (!isPremium && selectedVideoIds.length > 5) {
    return res.status(400).json({
      error:
        "La version gratuite permet d'utiliser au maximum 5 vidéos. Passe à un compte Premium pour en utiliser davantage.",
    });
  }

  try {
    const { default: processVideo } = await import("./processVideo.js");
    const finalVideoUrl = await processVideo(eventId, selectedVideoIds);

    // 🔔 Notifier le créateur + les invités quand la vidéo finale est prête
    notifyEventUsersOnFinalVideo(eventId, finalVideoUrl).catch((err) =>
      console.error("❌ Erreur notif vidéo finale:", err)
    );

    return res.status(200).json({ finalVideoUrl: finalVideoUrl });
  } catch (err) {
    console.error("❌ Erreur génération vidéo finale :", err);
    return res.status(500).json({
      error: err.message || "Erreur lors de la génération de la vidéo finale",
    });
  }
});

// ======================================================
// ✅ Statistiques par événement (invitations / vidéos)
// ======================================================
app.get("/api/events/:eventId/stats", async (req, res) => {
  const { eventId } = req.params;

  try {
    // Invitations pour cet événement
    const { data: invitations, error: invError } = await supabase
      .from("invitations")
      .select("email")
      .eq("event_id", eventId);

    if (invError) {
      console.error("❌ Erreur récupération invitations pour stats:", invError);
      return res.status(500).json({ error: "Erreur récupération invitations" });
    }

    // Vidéos reçues pour cet événement
    const { data: videos, error: vidError } = await supabase
      .from("videos")
      .select("participant_name")
      .eq("event_id", eventId);

    if (vidError) {
      console.error("❌ Erreur récupération vidéos pour stats:", vidError);
      return res.status(500).json({ error: "Erreur récupération vidéos" });
    }

    const totalInvitations = invitations?.length || 0;
    const participantsWithVideo = new Set(
      (videos || []).map((v) => v.participant_name)
    );

    // Hypothèse : participant_name = email invité
    const totalWithVideo = (invitations || []).filter((inv) =>
      participantsWithVideo.has(inv.email)
    ).length;

    const totalPending = totalInvitations - totalWithVideo;

    return res.json({
      totalInvitations,
      totalWithVideo,
      totalPending,
    });
  } catch (err) {
    console.error("❌ Erreur /api/events/:eventId/stats :", err);
    return res.status(500).json({ error: "Erreur serveur stats événement" });
  }
});

// ======================================================
// ✅ Route de relance manuelle des participants
// ======================================================
app.post("/api/events/:eventId/remind", async (req, res) => {
  const { eventId } = req.params;

  try {
    // 1. Charger l’évènement
    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("title, deadline, user_id")
      .eq("id", eventId)
      .single();

    if (eventErr || !event) {
      return res.status(404).json({ error: "Event introuvable" });
    }

    // 2. Récupérer les invitations
    const { data: invitations, error: invErr } = await supabase
      .from("invitations")
      .select("email, id")
      .eq("event_id", eventId);

    if (invErr) throw invErr;

    // 3. Récupérer les vidéos existantes
    const { data: videos, error: vidErr } = await supabase
      .from("videos")
      .select("participant_name")
      .eq("event_id", eventId);

    if (vidErr) throw vidErr;

    const participantsWhoSent = videos.map((v) => v.participant_name);

    // 4. Filtrer les invités sans vidéo
    const pendingInvitations = invitations.filter(
      (inv) => !participantsWhoSent.includes(inv.email)
    );

    // 5. Envoyer les relances email
    for (const inv of pendingInvitations) {
      await emailService.sendMail({
        to: inv.email,
        subject: `Rappel : Il ne te reste plus beaucoup de temps pour participer à "${event.title}"`,
        text: `Il ne manque plus que ta vidéo.`,
        html: `
         <div style="font-family: Inter, Arial, sans-serif; background:#f4f6f9; padding:32px;">
    <div style="
      max-width:600px;
      margin:auto;
      background:#ffffff;
      border-radius:18px;
      overflow:hidden;
      box-shadow:0 10px 35px rgba(0,0,0,0.12);
    ">

      <!-- HEADER -->
      <div style="background:#0f172a; padding:32px 24px; text-align:center;">
        <img src="https://cgqnrqbyvetcgwolkjvl.supabase.co/storage/v1/object/public/gregaplay-assets/logo.png"
             alt="Grega Play"
             style="width:180px; height:auto; display:block; margin:auto;" />
        <p style="color:#e2e8f0; font-size:14px; margin-top:12px; opacity:0.8;">
          Together, we create the moment
        </p>
      </div>

      <!-- CONTENU -->
      <div style="padding:32px;">
        <h2 style="font-size:22px; margin:0; color:#0f172a; text-align:center;">
          ⏰ Dernier rappel !
        </h2>

        <p style="margin-top:18px; font-size:15px; color:#334155; text-align:center; line-height:1.6;">
          Il reste moins de <strong>24 heures</strong> pour participer à l'évènement :
          <br />
          <span style="font-size:18px; color:#16a34a;"><strong>${event.title}</strong></span>
        </p>

        <p style="margin-top:12px; font-size:14px; color:#475569; line-height:1.6; text-align:center;">
          Envoie ta vidéo maintenant pour apparaître dans le montage final
        </p>

        <!-- BOUTON CTA -->
        <div style="text-align:center; margin:28px 0 24px;">
          <a href="https://gregaplay.com/invitation/${inv.token}"
             style="
               background:linear-gradient(135deg, #16a34a, #059669);
               padding:16px 36px;
               display:inline-block;
               font-size:16px;
               font-weight:bold;
               color:#ffffff;
               border-radius:12px;
               text-decoration:none;
               box-shadow:0 6px 18px rgba(0,0,0,0.20);
             "
             target="_blank"
          >
            👉 Participer à l’évènement
          </a>
        </div>

        <p style="font-size:12px; text-align:center; color:#64748b;">
          Si le bouton ne fonctionne pas, ouvre ce lien :
          <br />
          <a href="https://gregaplay.com/invitation/${inv.token}" 
             style="color:#16a34a;"
          >
            https://gregaplay.com/invitation/${inv.token}
          </a>
        </p>
      </div>

      <!-- FOOTER -->
      <div style="background:#f8fafc; padding:16px; text-align:center; font-size:12px; color:#94a3b8;">
        Grega Play – L’émotion se construit ensemble<br/>
        <span style="font-size:11px; color:#94a3b8;">Rappel automatique</span>
      </div>

    </div>
  </div>
`,
      });
    }

    return res.json({
      message: "Relance envoyée",
      remindersSent: pendingInvitations.length,
    });
  } catch (err) {
    console.error("❌ Erreur remind:", err);
    return res.status(500).json({ error: "Erreur serveur lors de la relance" });
  }
});

// ======================================================
// 🚀 Lancement serveur
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Grega Play en écoute sur le port ${PORT}`);
});
