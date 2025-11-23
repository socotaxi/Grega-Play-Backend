// services/emailService.js
import sgMail from "@sendgrid/mail";

const {
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME,
} = process.env;

const hasSendgrid = !!SENDGRID_API_KEY && !!SENDGRID_FROM_EMAIL;

console.log("📨 SendGrid config chargée:", {
  hasApiKey: !!SENDGRID_API_KEY,
  fromEmail: SENDGRID_FROM_EMAIL,
  fromName: SENDGRID_FROM_NAME,
});

if (hasSendgrid) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn(
    "⚠️ SendGrid non configuré (SENDGRID_API_KEY ou SENDGRID_FROM_EMAIL manquant). " +
    "Les emails ne seront pas envoyés, mais le backend reste en ligne."
  );
}

/**
 * Envoi générique d'email via SendGrid
 */
async function sendMail({ to, subject, html, text }) {
  if (!hasSendgrid) {
    console.warn(
      "⏭️ Email ignoré (SendGrid non configuré) ->",
      subject,
      "->",
      to
    );
    return;
  }

  const fromName = SENDGRID_FROM_NAME || "Grega Play";

  const msg = {
    to,
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: fromName,
    },
    subject,
    text,
    html,
  };

  try {
    const [response] = await sgMail.send(msg);
    console.log(
      "📧 Email envoyé via SendGrid →",
      to,
      "statusCode:",
      response?.statusCode
    );
    return response;
  } catch (error) {
    console.error("❌ Erreur SendGrid lors de l'envoi d'email:", error.message);
    if (error.response) {
      console.error("📩 Détails SendGrid:", error.response.body);
    }
    // On nève PAS d'erreur ici pour ne pas faire crasher le serveur
  }
}

/**
 * Email d'invitation à un événement Grega Play
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
