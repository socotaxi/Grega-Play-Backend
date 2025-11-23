// routes/emailRoutes.js
import express from "express";
import emailService from "../services/emailService.js"; // ✅ chemin corrigé

const router = express.Router();

/**
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

export default router;
