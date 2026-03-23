// backend/services/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import fetch from "cross-fetch";
import sharp from "sharp";

import notificationsRouter from "../routes/notifications.js";
import { sendPushNotification } from "./pushService.js"; // (import conservé si utilisé ailleurs)
import emailRoutes from "../routes/emailRoutes.js";
import whatsappAuthRoutes from "../routes/whatsappAuthRoutes.js";
import emailService from "./emailService.js";

import stripePackage from "stripe";

import eventsRoutes from "../routes/events.routes.js";
import billingRoutes from "../routes/billing.routes.js";

import capabilitiesRoutes from "../routes/capabilitiesRoutes.js";

// ✅ Routes vidéos centralisées
import videosRoutes from "../routes/videos.routes.js";

// ✅ NEW (Étape 8): routes assets premium (bucket privé premium-assets)
import assetsRoutes from "../routes/assets.routes.js";

dotenv.config();
global.fetch = fetch;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const stripe =
  stripeSecretKey && stripeSecretKey.startsWith("sk_")
    ? stripePackage(stripeSecretKey)
    : null;

// Si aucune clé Stripe valide → on désactive les paiements
const PAYMENTS_ENABLED = false;

if (!PAYMENTS_ENABLED) {
  console.warn(
    "⚠️ Stripe n'est pas configuré (STRIPE_SECRET_KEY manquant ou invalide). Les paiements réels sont désactivés, on utilisera le mode Premium gratuit."
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------
// Vérifier les variables Supabase
// ------------------------------------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "❌ Erreur : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY est manquant dans les variables d'environnement."
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------------------------------------------
// Création de l'application Express
// ------------------------------------------------------
const app = express();

// ------------------------------------------------------
// ✅ CORS
// ------------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!allowedOrigins.length) {
  console.warn(
    "⚠️ Aucun domaine CORS spécifié. Tous les domaines seront autorisés en mode développement."
  );
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);

    console.warn(`❌ CORS bloqué pour l'origine : ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ------------------------------------------------------
// Logger global
// ------------------------------------------------------
app.use((req, res, next) => {
  console.log(
    `🌍 [${new Date().toISOString()}] ${req.method} ${req.originalUrl} | Origin: ${
      req.headers.origin || "N/A"
    }`
  );
  next();
});

// ⚠️ On n'utilise PAS express.json() pour /webhooks/stripe (raw body requis).
app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/stripe") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// ------------------------------------------------------
// ✅ Helpers sécurité HTML (pour OG tags)
// ------------------------------------------------------
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(str = "") {
  return escapeHtml(str);
}

// Helpers pour SVG (OG image)
function escapeXml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Wrap simple : découpe en lignes sans mesurer au pixel (suffisant pour V1)
function svgMultilineText(text, x, y, fontSize, lineHeight, maxLines) {
  const clean = escapeXml(text).trim();
  const words = clean.split(/\s+/);
  const lines = [];
  let current = "";

  const approxCharsPerLine = 24; // ajuste si tu changes fontSize
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (test.length > approxCharsPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const finalLines = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    finalLines[maxLines - 1] =
      finalLines[maxLines - 1].replace(/\.*$/, "") + "…";
  }

  const tspans = finalLines
    .map(
      (line, i) =>
        `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${line}</tspan>`
    )
    .join("");

  return `
  <text x="${x}" y="${y}" fill="#fff" font-size="${fontSize}"
        font-family="Arial, Helvetica, sans-serif" font-weight="900">
    ${tspans}
  </text>`;
}

function getPublicSiteUrl(req) {
  // 1) Priorité à la variable d'env (recommandé en prod)
  const envUrl = (process.env.PUBLIC_SITE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  // 2) Fallback basé sur la requête (utile en dev / tunnel)
  const proto =
    (req.headers["x-forwarded-proto"] || req.protocol || "http")
      .toString()
      .split(",")[0]
      .trim();

  const host = (req.headers["x-forwarded-host"] || req.headers.host || "")
    .toString()
    .split(",")[0]
    .trim();

  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

// ------------------------------------------------------
// ✅ Middleware de sécurité minimal : clé API backend
// ------------------------------------------------------
const apiKeyMiddleware = (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  // ✅ Exception: routes publiques (pas de clé API)
  if (req.originalUrl.startsWith("/api/public/")) return next();

  const incomingKey = req.headers["x-api-key"];
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!expectedKey || incomingKey !== expectedKey) {
    console.warn(
      "❌ Requête API refusée (mauvaise clé API) sur",
      req.method,
      req.originalUrl
    );
    return res
      .status(403)
      .json({ error: "Accès non autorisé (clé API invalide)." });
  }

  next();
};

// ------------------------------------------------------
// 🟣 Webhook Stripe (RAW body obligatoire)
// ------------------------------------------------------
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!PAYMENTS_ENABLED) {
      console.warn("⚠️ Webhook Stripe reçu alors que PAYMENTS_ENABLED = false.");
      return res.status(200).send("Stripe désactivé, webhook ignoré.");
    }

    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Erreur de vérification du webhook Stripe:", err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`📦 Webhook Stripe reçu: ${event.type}`);

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutSessionCompleted(event.data.object);
          break;
        case "invoice.paid":
          console.log("✅ invoice.paid reçu (abonnement actif)");
          break;
        case "invoice.payment_failed":
          console.warn("⚠️ invoice.payment_failed reçu (paiement échoué)");
          break;
        default:
          console.log(`ℹ️ Événement Stripe non géré: ${event.type}`);
      }
    } catch (err) {
      console.error("❌ Erreur lors du traitement du webhook Stripe:", err);
      return res
        .status(500)
        .send("Erreur interne lors du traitement du webhook");
    }

    res.json({ received: true });
  }
);

// Fonction de traitement pour "checkout.session.completed"
async function handleCheckoutSessionCompleted(session) {
  if (!session || !session.metadata) {
    console.warn(
      "⚠️ Session Stripe sans metadata. Impossible de savoir quel type de produit."
    );
    return;
  }

  const metadata = session.metadata;
  const mode = metadata.mode;
  const userId = metadata.user_id;

  if (!userId) {
    console.warn("⚠️ Session Stripe sans user_id dans les metadata.");
    return;
  }

  console.log(
    `✅ checkout.session.completed pour user ${userId}, mode=${mode}, session=${session.id}`
  );

  if (mode === "account") {
    const amountTotal = session.amount_total || 0;
    const currency = session.currency || "eur";

    const nowIso = new Date().toISOString();
    const periodEndIso = null;

    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        is_premium_account: true,
        premium_account_plan: "premium-account",
        premium_account_expires_at: periodEndIso,
      })
      .eq("id", userId);

    if (profileError) {
      console.error("❌ Erreur update profil Premium (Stripe):", profileError);
      return;
    }

    const { error: insertError } = await supabase
      .from("account_subscriptions")
      .insert({
        user_id: userId,
        provider: "stripe",
        provider_subscription_id: session.subscription || null,
        status: "active",
        plan: "premium-account",
        amount_cents: amountTotal,
        currency: currency.toUpperCase(),
        current_period_start: nowIso,
        current_period_end: periodEndIso,
      });

    if (insertError) {
      console.error("⚠️ Erreur insert account_subscriptions:", insertError);
    }
  } else if (mode === "event") {
    const eventId = metadata.event_id;
    if (!eventId) {
      console.warn(
        "⚠️ Session Stripe mode=event sans event_id dans les metadata."
      );
      return;
    }

    const { data: updatedEvent, error: eventUpdateError } = await supabase
      .from("events")
      .update({
        is_premium_event: true,
      })
      .eq("id", eventId)
      .eq("user_id", userId)
      .select()
      .single();

    if (eventUpdateError) {
      console.error(
        "❌ Erreur update events (Premium via Stripe):",
        eventUpdateError
      );
      return;
    }

    console.log("✅ Événement mis à jour en Premium via Stripe:", updatedEvent);
  } else {
    console.log("ℹ️ Mode de checkout inconnu, aucune action:", mode);
  }
}

// ------------------------------------------------------
// ✅ Routes (avant /api, si publiques)
// ------------------------------------------------------
app.use(capabilitiesRoutes);

// ------------------------------------------------------
// ✅ OG IMAGE dynamique (publique)
// URL : /og/event/:public_code.png
// ------------------------------------------------------
app.get("/og/event/:public_code.png", async (req, res) => {
  try {
    const { public_code } = req.params;

    const { data: event, error } = await supabase
      .from("events")
      .select("title, theme")
      .eq("public_code", public_code)
      .single();

    if (error || !event) return res.status(404).send("Not found");

    const title = (event.title || "Événement").trim();
    const theme = (event.theme || "").trim();

    // Dimensions OG recommandées
    const W = 1200;
    const H = 630;

    // Palette (V1)
    const bg1 = "#0B1220";
    const bg2 = "#111827";
    const accent = "#10B981"; // vert Grega Play-like

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg1}"/>
      <stop offset="1" stop-color="${bg2}"/>
    </linearGradient>

    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#g)"/>

  <!-- Accent shapes -->
  <circle cx="980" cy="120" r="180" fill="${accent}" opacity="0.18"/>
  <circle cx="1100" cy="520" r="260" fill="${accent}" opacity="0.12"/>
  <rect x="70" y="460" width="1060" height="6" fill="${accent}" opacity="0.55"/>

  <!-- Card -->
  <g filter="url(#shadow)">
    <rect x="70" y="90" rx="28" ry="28" width="1060" height="360" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)"/>
  </g>

  <!-- Branding -->
  <text x="110" y="150" fill="rgba(255,255,255,0.85)" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="700">
    Grega Play
  </text>

  <!-- Title -->
  ${svgMultilineText(title, 110, 220, 58, 44, 3)}

  <!-- Theme -->
  <text x="110" y="420" fill="rgba(255,255,255,0.72)" font-size="28" font-family="Arial, Helvetica, sans-serif">
    ${escapeXml(theme ? `Thème : ${theme}` : "Participe et ajoute ta vidéo")}
  </text>

  <!-- Footer -->
  <text x="110" y="560" fill="rgba(255,255,255,0.65)" font-size="24" font-family="Arial, Helvetica, sans-serif">
    Une vidéo collective, créée ensemble.
  </text>

  <!-- Badge -->
  <g>
    <rect x="930" y="520" rx="18" ry="18" width="200" height="54" fill="${accent}" opacity="0.95"/>
    <text x="1030" y="556" text-anchor="middle" fill="#062014" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">
      Ouvrir
    </text>
  </g>
</svg>`;

    const pngBuffer = await sharp(Buffer.from(svg))
      .png({ quality: 90 })
      .toBuffer();

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600"); // 1h
    return res.status(200).send(pngBuffer);
  } catch (e) {
    console.error("❌ OG image error:", e);
    return res.status(500).send("Server error");
  }
});

// ------------------------------------------------------
// ✅ Page publique serveur pour preview WhatsApp / Instagram-like
// URL à partager : https://ton-domaine/share/e/:public_code
// ------------------------------------------------------
app.get("/share/e/:public_code", async (req, res) => {
  try {
    const { public_code } = req.params;

    const { data: event, error } = await supabase
      .from("events")
      .select("title, description, theme, public_code, media_url")
      .eq("public_code", public_code)
      .single();

    if (error || !event) {
      console.warn("❌ /share/e/:public_code introuvable:", error);
      return res.status(404).send("Not found");
    }

    // siteUrl = URL du frontend (pour la redirection vers l'app)
    const siteUrl = getPublicSiteUrl(req);
    const appUrl = siteUrl ? `${siteUrl}/e/${public_code}` : `/e/${public_code}`;

    // backendUrl = URL de CE serveur (pour les routes /og/event/*.png)
    const backendProto = ((req.headers["x-forwarded-proto"] || req.protocol || "https") + "")
      .split(",")[0].trim();
    const backendHost = ((req.headers["x-forwarded-host"] || req.headers.host || "") + "")
      .split(",")[0].trim();
    const backendUrl = backendHost ? `${backendProto}://${backendHost}` : "";

    const ogTitle = `🎉 ${event.title || "Événement"} – Grega Play`;

    // Description tronquée à 200 caractères pour WhatsApp
    const rawDesc =
      (event.description || "").trim() ||
      "Participe à cet événement et ajoute ta vidéo souvenir.";
    const ogDesc = rawDesc.length > 200 ? rawDesc.slice(0, 197) + "…" : rawDesc;

    // Utilise la vraie photo de l'événement si c'est une image,
    // sinon l'image générée sur CE backend (pas le frontend)
    const isImageUrl = (url) =>
      /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url || "");
    const eventPhoto = isImageUrl(event.media_url) ? event.media_url : null;
    const ogImage = eventPhoto || (backendUrl ? `${backendUrl}/og/event/${public_code}.png` : "");

    res.set("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />

  <title>${escapeHtml(ogTitle)}</title>

  <meta property="og:title" content="${escapeAttr(ogTitle)}" />
  <meta property="og:description" content="${escapeAttr(ogDesc)}" />
  ${
    ogImage
      ? `<meta property="og:image" content="${escapeAttr(ogImage)}" />`
      : ""
  }
  <meta property="og:url" content="${escapeAttr(appUrl)}" />
  <meta property="og:type" content="website" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeAttr(ogTitle)}" />
  <meta name="twitter:description" content="${escapeAttr(ogDesc)}" />
  ${
    ogImage ? `<meta name="twitter:image" content="${escapeAttr(ogImage)}" />` : ""
  }

  <meta http-equiv="refresh" content="0;url=${escapeAttr(appUrl)}" />
</head>
<body>
  Redirection… <a href="${escapeAttr(appUrl)}">Ouvrir l’événement</a>
</body>
</html>`);
  } catch (e) {
    console.error("❌ Erreur /share/e/:public_code:", e);
    return res.status(500).send("Server error");
  }
});

// ------------------------------------------------------
// 🌍 ROUTES PUBLIQUES
// ------------------------------------------------------
const publicRouter = express.Router();

// GET /api/public/final-video/:public_code
publicRouter.get("/final-video/:public_code", async (req, res) => {
  try {
    const { public_code } = req.params;

    const { data: event, error } = await supabase
      .from("events")
      .select("title, description, final_video_url, final_video_path")
      .eq("public_code", public_code)
      .single();

    if (error || !event) {
      console.error("❌ public final-video: event not found", { public_code, error });
      return res.status(404).json({ message: "Événement introuvable" });
    }

    console.log("🔎 public final-video DB result:", {
      public_code,
      title: event.title,
      final_video_url_type: typeof event.final_video_url,
      final_video_url: event.final_video_url,
      final_video_path: event.final_video_path,
    });

    // Extraire l'URL depuis final_video_url (peut être une string ou un objet { videoUrl: "..." })
    const rawFinalUrl = event.final_video_url;
    const resolvedFinalUrl =
      typeof rawFinalUrl === "string"
        ? rawFinalUrl
        : rawFinalUrl?.videoUrl || null;

    // Priorité 1 : final_video_url déjà calculée (URL publique ou signée)
    if (resolvedFinalUrl?.startsWith("http")) {
      return res.status(200).json({
        title: event.title || "Vidéo finale",
        description: event.description || null,
        finalVideoUrl: resolvedFinalUrl,
      });
    }

    // Priorité 2 : final_video_path stocké comme URL complète
    if (event.final_video_path?.startsWith("http")) {
      return res.status(200).json({
        title: event.title || "Vidéo finale",
        description: event.description || null,
        finalVideoUrl: event.final_video_path,
      });
    }

    // Priorité 3 : final_video_path = chemin dans le bucket "videos" → signed URL
    if (!event.final_video_path) {
      return res.status(404).json({ message: "Vidéo finale introuvable. Le montage n'est peut-être pas encore terminé." });
    }

    let objectPath = String(event.final_video_path).trim().replace(/^\/+/, "");

    // Cas legacy: DB stocke "events/<id>/final.mp4" → préfixe "final_videos/"
    if (objectPath.startsWith("events/")) {
      objectPath = `final_videos/${objectPath}`;
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from("videos")
      .createSignedUrl(objectPath, 60 * 60); // 1h

    if (signErr || !signed?.signedUrl) {
      console.error("❌ Signed URL error:", signErr);
      return res.status(500).json({ message: "Impossible de générer le lien vidéo" });
    }

    return res.status(200).json({
      title: event.title || "Vidéo finale",
      description: event.description || null,
      finalVideoUrl: signed.signedUrl,
    });
  } catch (e) {
    console.error("❌ public final-video error:", e);
    return res.status(500).json({ message: "Erreur serveur" });
  }
});

// GET /api/public/event/:public_code
publicRouter.get("/event/:public_code", async (req, res) => {
  try {
    const { public_code } = req.params;

    const { data: event, error } = await supabase
      .from("events")
      .select(
        "id, title, description, theme, deadline, status, is_public, is_premium_event, media_url, public_code"
      )
      .eq("public_code", public_code)
      .maybeSingle();

    if (error) {
      console.error("❌ public event fetch error:", error);
      return res.status(500).json({ error: "Erreur lors du chargement de l'événement." });
    }

    if (!event) {
      return res.status(404).json({ error: "Événement introuvable." });
    }

    return res.status(200).json({ event });
  } catch (e) {
    console.error("❌ public event error:", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.use("/api/public", publicRouter);

// ------------------------------------------------------
// Toutes les routes en /api nécessitent une clé API
// ------------------------------------------------------
app.use("/api", apiKeyMiddleware);

// ✅ Étape 8: assets premium (upload privé + storagePath)
app.use("/api/assets", assetsRoutes);

// 📧 Routes email
app.use("/api/email", emailRoutes);

// ✅ events routes
app.use("/api/events", eventsRoutes);

// 💳 billing routes
app.use("/api/billing", billingRoutes);

// ✅ vidéos centralisées (upload/process/process-async/jobs)
app.use("/api/videos", videosRoutes);

// 🔔 notifications push
app.use("/api/notifications", notificationsRouter);

// ------------------------------------------------------
// 🧩 Helper : extraire bucket + path depuis une URL publique Supabase
// (utilisé ici pour la suppression complète d'événement)
// ------------------------------------------------------
function getBucketAndPathFromPublicUrl(publicUrl) {
  if (!publicUrl || typeof publicUrl !== "string") return null;

  try {
    const url = new URL(publicUrl);
    const marker = "/object/public/";
    const idx = url.pathname.indexOf(marker);
    if (idx === -1) return null;

    const after = url.pathname.substring(idx + marker.length);
    const parts = after.split("/");
    if (parts.length < 2) return null;

    const bucket = parts[0];
    const pathInBucket = parts.slice(1).join("/");

    return { bucket, path: pathInBucket };
  } catch (e) {
    console.warn("⚠️ Impossible de parser l'URL publique Supabase:", publicUrl, e);
    return null;
  }
}

// ------------------------------------------------------
// 🔔 Relance des participants à J-1 de la deadline
// ------------------------------------------------------
app.post("/api/events/:eventId/remind", async (req, res) => {
  const { eventId } = req.params;

  try {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, title, description, deadline, user_id, public_code")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      console.error("❌ Événement introuvable pour relance:", eventError);
      return res.status(404).json({ error: "Événement introuvable." });
    }

    const { data: participants, error: participantsError } = await supabase
      .from("event_participants")
      .select("email, name, has_submitted")
      .eq("event_id", eventId);

    if (participantsError) {
      console.error("❌ Erreur récupération participants:", participantsError);
      return res.status(500).json({
        error: "Erreur lors de la récupération des participants.",
      });
    }

    const participantsToRemind = (participants || []).filter(
      (p) => !p.has_submitted && p.email
    );

    if (participantsToRemind.length === 0) {
      return res.status(200).json({
        message: "Aucun participant à relancer (tous ont soumis une vidéo).",
      });
    }

    const publicSiteUrl = process.env.PUBLIC_SITE_URL || "";
    const eventLink = event.public_code
      ? `${publicSiteUrl}/e/${event.public_code}`
      : publicSiteUrl;

    const { sent, failed } = await emailService.sendReminderToParticipants({
      event,
      participants: participantsToRemind,
      eventLink,
    });

    return res.status(200).json({
      message: "Emails de relance envoyés aux participants en attente.",
      count: participantsToRemind.length,
      sent,
      failed,
    });
  } catch (err) {
    console.error("❌ Erreur /api/events/:eventId/remind:", err);
    return res.status(500).json({
      error: "Erreur interne lors de l'envoi des relances.",
    });
  }
});

// ------------------------------------------------------
// 🔔 Stats d'installation PWA
// ------------------------------------------------------
app.post("/api/track-install", async (req, res) => {
  try {
    const userAgent = req.headers["user-agent"] || null;
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      "unknown";

    const { error } = await supabase.from("app_install_events").insert([
      { ip, user_agent: userAgent },
    ]);

    if (error) {
      console.error("❌ Erreur enregistrement app_install_events:", error);
    }

    res.json({ message: "Install click tracked" });
  } catch (err) {
    console.error("❌ Erreur /api/track-install:", err);
    res.status(500).json({ error: "Erreur interne tracking install." });
  }
});

// ------------------------------------------------------
// 🗑️ Suppression complète d'un événement (et fichiers associés)
// ------------------------------------------------------
app.delete("/api/events/:eventId", async (req, res) => {
  const { eventId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({
      error:
        "userId est requis pour vérifier que seul le créateur peut supprimer.",
    });
  }

  try {
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, user_id, final_video_path")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      console.error("❌ Événement introuvable pour la suppression:", eventError);
      return res
        .status(404)
        .json({ error: "Événement introuvable ou déjà supprimé." });
    }

    if (event.user_id !== userId) {
      return res.status(403).json({
        error: "Seul le créateur de l'événement peut le supprimer.",
      });
    }

    const { data: videos, error: videosError } = await supabase
      .from("videos")
      .select("video_url")
      .eq("event_id", eventId);

    if (videosError) {
      console.error("❌ Erreur récupération vidéos pour suppression:", videosError);
      return res.status(500).json({
        error: "Erreur interne lors de la récupération des vidéos.",
      });
    }

    const filesToRemove = [];

    for (const vid of videos || []) {
      const parsed = getBucketAndPathFromPublicUrl(vid.video_url);
      if (parsed) filesToRemove.push({ bucket: parsed.bucket, path: parsed.path });
    }

    // ✅ vidéo finale : final_videos est un dossier dans bucket "videos"
    if (event.final_video_path) {
      let finalPath = String(event.final_video_path || "").trim();

      if (finalPath.startsWith("events/")) {
        finalPath = `final_videos/${finalPath}`;
      }
      finalPath = finalPath.replace(/^\/+/, "");

      filesToRemove.push({
        bucket: "videos",
        path: finalPath,
      });
    }

    const bucketGroups = {};
    for (const file of filesToRemove) {
      if (!bucketGroups[file.bucket]) bucketGroups[file.bucket] = [];
      bucketGroups[file.bucket].push(file.path);
    }

    for (const [bucket, paths] of Object.entries(bucketGroups)) {
      const { error: removeError } = await supabase.storage.from(bucket).remove(paths);

      if (removeError) {
        console.error(`❌ Erreur suppression fichiers dans le bucket ${bucket}:`, removeError);
      } else {
        console.log(`🗑️ Fichiers supprimés dans le bucket ${bucket}:`, paths.length);
      }
    }

    const { error: participantsError } = await supabase
      .from("event_participants")
      .delete()
      .eq("event_id", eventId);

    if (participantsError) {
      console.error("⚠️ Erreur suppression participants event:", participantsError);
    }

    const { error: videosDeleteError } = await supabase
      .from("videos")
      .delete()
      .eq("event_id", eventId);

    if (videosDeleteError) {
      console.error("⚠️ Erreur suppression vidéos event:", videosDeleteError);
    }

    const { error: eventDeleteError } = await supabase
      .from("events")
      .delete()
      .eq("id", eventId);

    if (eventDeleteError) {
      console.error("❌ Erreur suppression event:", eventDeleteError);
      return res
        .status(500)
        .json({ error: "Erreur lors de la suppression de l'événement." });
    }

    return res.status(200).json({
      message: "Événement et données associées supprimés.",
    });
  } catch (err) {
    console.error("❌ Erreur /api/events/:eventId (delete):", err);
    return res.status(500).json({
      error: "Erreur interne lors de la suppression de l'événement.",
    });
  }
});

// ------------------------------------------------------
// 🚀 Démarrage du serveur
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Grega Play en écoute sur le port ${PORT}`);
});

export default app;
