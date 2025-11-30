// routes/emailRoutes.js
import express from "express";
import emailService from "../services/emailService.js"; // ✅ chemin corrigé

const router = express.Router();

/**
 * Route d'envoi d'invitations
 *
 * POST /api/email/invite
 * Body: { to, subject, html, eventId?, invitationToken? }
 * Le backend envoie l'email via SMTP (Hostinger) grâce à services/emailService.js
 */
router.post("/invite", async (req, res) => {
  try {
    const { to, subject, html, eventId, invitationToken } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).json({
        error: "Champs requis: to, subject, html",
      });
    }

    await emailService.sendMail({
      to,
      subject,
      html,
    });

    console.log("📧 Invitation envoyée via /api/email/invite →", to, {
      eventId,
      invitationToken,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Erreur envoi email d'invitation:", err);
    return res.status(500).json({ error: "Erreur envoi email" });
  }
});

/* -------------------------------------------------------------------------- */
/* Anti-spam + route contact                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stockage en mémoire pour le rate limit.
 * Remarque : ça se réinitialise à chaque redeploy/redémarrage,
 * mais c’est déjà une bonne première barrière.
 */
const rateMap = new Map();
const WINDOW_MS = 15 * 60 * 1000; // fenêtre de 15 minutes
const MAX_PER_WINDOW = 5; // max 5 messages par fenêtre (IP / email)

/**
 * Récupère la meilleure IP possible depuis les headers.
 */
function getClientIp(req) {
  const xRealIp = req.headers["x-real-ip"];
  const xForwardedFor = req.headers["x-forwarded-for"];

  if (typeof xRealIp === "string" && xRealIp.length > 0) {
    return xRealIp;
  }

  if (typeof xForwardedFor === "string" && xForwardedFor.length > 0) {
    return xForwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "unknown";
}

/**
 * Met à jour et vérifie le compteur de requêtes pour une clé donnée (ip:xxx ou email:xxx)
 */
function isRateLimited(key, now) {
  if (!key) return false;

  const existing = rateMap.get(key) || { count: 0, first: now };

  // Si la fenêtre de temps est dépassée, on réinitialise
  if (now - existing.first > WINDOW_MS) {
    existing.count = 0;
    existing.first = now;
  }

  existing.count += 1;
  rateMap.set(key, existing);

  return existing.count > MAX_PER_WINDOW;
}

/**
 * Route de contact avec anti-spam
 *
 * Si tu montes ce router avec:
 *   app.use("/api/email", emailRoutes);
 * alors la route sera: POST /api/email/contact
 *
 * Body attendu:
 * {
 *   email: "contact@grega-play.com",   // destinataire
 *   subject: "📩 Message depuis Grega Play - ...",
 *   content: "<html>...</html>",       // template HTML généré côté frontend
 *   website: "",                       // honeypot (doit rester vide)
 *   formCreatedAt: 1732961234567       // Date.now() côté frontend
 * }
 */
router.post("/contact", async (req, res) => {
  try {
    const {
      email: to,
      subject,
      content,
      website,
      formCreatedAt,
    } = req.body || {};

    const now = Date.now();

    // 1) Vérification honeypot "website" (rempli => spam)
    if (website && String(website).trim().length > 0) {
      console.warn("🛑 Spam contact détecté (honeypot rempli).", {
        to,
        website,
      });
      // On répond 200 pour ne pas donner d'indice au bot
      return res.status(200).json({ success: true, spam: true });
    }

    // 2) Vérification formCreatedAt (anti-bot trop rapide)
    const createdAtMs = Number(formCreatedAt);
    if (!createdAtMs || Number.isNaN(createdAtMs) || now - createdAtMs < 3000) {
      console.warn("🛑 Spam contact détecté (form soumis trop vite).", {
        to,
        formCreatedAt,
        deltaMs: now - createdAtMs,
      });
      return res
        .status(429)
        .json({ error: "Envoi détecté comme spam (trop rapide)." });
    }

    // 3) Rate-limit par IP + email
    const ip = getClientIp(req);
    const emailKey = to ? `email:${String(to).toLowerCase()}` : null;
    const ipKey = `ip:${ip}`;

    const blockedByIp = isRateLimited(ipKey, now);
    const blockedByEmail = isRateLimited(emailKey, now);

    if (blockedByIp || blockedByEmail) {
      console.warn("🛑 Spam contact détecté (rate limit).", {
        to,
        ip,
        blockedByIp,
        blockedByEmail,
      });

      return res.status(429).json({
        error:
          "Trop de messages envoyés en peu de temps. Merci de réessayer plus tard.",
      });
    }

    // 4) Validation minimale des champs
    if (!to || !subject || !content) {
      return res.status(400).json({
        error: "Champs manquants (email, subject ou content).",
      });
    }

    // 5) Envoi de l'email via ton service SendGrid/SMTP existant
    await emailService.sendMail({
      to,
      subject,
      html: content,
      text: "Nouveau message de contact Grega Play.",
    });

    console.log("📩 Message contact envoyé via /api/email/contact →", to, {
      ip,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Erreur envoi email de contact:", error);
    return res.status(500).json({ error: "Erreur envoi email de contact" });
  }
});

export default router;
