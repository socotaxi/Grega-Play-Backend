// services/emailService.js
import nodemailer from "nodemailer";

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
} = process.env;

// Debug visible au démarrage
console.log("📨 SMTP config chargée:", {
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  user: SMTP_USER,
  from: SMTP_FROM,
  passLength: SMTP_PASS ? SMTP_PASS.length : 0,
});

// Configuration SendGrid SMTP
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || "smtp.sendgrid.net",
  port: Number(SMTP_PORT) || 587,
  secure: SMTP_SECURE === "true", // false pour port 587
  auth: {
    user: SMTP_USER, // doit être "apikey"
    pass: SMTP_PASS, // ta clé API SendGrid
  },
});

// Vérification au démarrage
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Vérification SMTP échouée:", error.message);
  } else {
    console.log("✅ Connexion SMTP OK, prêt à envoyer des emails.");
  }
});

/**
 * Email générique
 */
async function sendMail({ to, subject, html, text }) {
  const mailOptions = {
    from: SMTP_FROM || "Grega Play <noreply@gregaplay.com>",
    to,
    subject,
    text,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("📧 Email envoyé →", to, "messageId:", info.messageId);
  return info;
}

/**
 * Email d'invitation
 * On garde la compatibilité avec l’appel existant
 * et on ajoute des champs optionnels :
 * - eventDescription
 * - deadline (déjà formatée côté appelant si tu veux)
 * - eventThumbnailUrl
 * - personalMessage
 */
async function sendInvitationEmail({
  to,
  inviterName,
  eventTitle,
  eventLink,
  eventDescription,
  deadline,
  eventThumbnailUrl,
  personalMessage,
}) {
  const safeOrganizerName = inviterName || "L'organisateur";
  const safeEventTitle = eventTitle || "un événement vidéo collaboratif";

  const subject = `Invitation à l'événement "${safeEventTitle}"`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <p>Bonjour,</p>

      <p>
        <strong>${safeOrganizerName}</strong> vous invite à participer à l’événement vidéo collaboratif :
      </p>

      <h2 style="margin-top: 8px; margin-bottom: 4px; color: #4CAF50;">
        🎉 ${safeEventTitle}
      </h2>

      ${
        eventDescription
          ? `<p><strong>Description :</strong> ${eventDescription}</p>`
          : ""
      }

      ${
        deadline
          ? `<p><strong>Date limite :</strong> ${deadline}</p>`
          : ""
      }

      ${
        personalMessage
          ? `<p style="margin-top: 12px;"><em>Message de ${safeOrganizerName} :</em><br>${personalMessage}</p>`
          : ""
      }

      ${
        eventThumbnailUrl
          ? `
      <div style="margin: 20px 0; text-align: center;">
        <img
          src="${eventThumbnailUrl}"
          alt="Miniature de l'événement ${safeEventTitle}"
          style="max-width: 100%; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.12);"
        />
      </div>
      `
          : ""
      }

      <p style="margin-top: 16px;">🎯 <strong>Comment participer ?</strong></p>
      <ul>
        <li>Cliquez sur le bouton ci-dessous pour accepter l’invitation</li>
        <li>Créez votre compte Grega Play (si ce n’est pas déjà fait)</li>
        <li>Téléchargez votre vidéo avant la date limite</li>
        <li>Regardez le montage final créé automatiquement !</li>
      </ul>

      <div style="margin-top: 24px; text-align: center;">
        <a
          href="${eventLink}"
          style="
            padding: 12px 22px;
            background-color: #4CAF50;
            color: #ffffff;
            text-decoration: none;
            font-weight: bold;
            border-radius: 6px;
            display: inline-block;
          "
          target="_blank"
        >
          👉 Accepter l’invitation
        </a>
      </div>

      <p style="margin-top: 20px; font-size: 12px; color: #777;">
        Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br/>
        <a href="${eventLink}" target="_blank">${eventLink}</a>
      </p>
    </div>
  `;

  return sendMail({ to, subject, html });
}

export default {
  sendMail,
  sendInvitationEmail,
};
