// services/emailService.js
import sgMail from "@sendgrid/mail";

const {
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME,
  GREGAPLAY_LOGO_URL,
} = process.env;

const hasSendgrid = !!SENDGRID_API_KEY && !!SENDGRID_FROM_EMAIL;

console.log("📨 SendGrid config chargée:", {
  hasApiKey: !!SENDGRID_API_KEY,
  fromEmail: SENDGRID_FROM_EMAIL,
  fromName: SENDGRID_FROM_NAME,
  hasLogo: !!GREGAPLAY_LOGO_URL,
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
    console.error(
      "❌ Erreur SendGrid lors de l'envoi d'email:",
      error.message
    );
    if (error.response) {
      console.error("📩 Détails SendGrid:", error.response.body);
    }
    // On ne lève PAS d'erreur ici pour ne pas faire crasher le serveur
  }
}

/**
 * Email d'invitation à un événement Grega Play (version design + logo)
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

  const logoUrl =
    GREGAPLAY_LOGO_URL ||
    "https://via.placeholder.com/240x80?text=Grega+Play"; // Fallback si pas de logo configuré

  const html = `
    <div style="font-family: Arial, sans-serif; background:#f6f9fc; padding:24px;">
      <div style="
        max-width:520px;
        margin:auto;
        background:#ffffff;
        border-radius:12px;
        box-shadow:0 6px 20px rgba(0,0,0,0.08);
        overflow:hidden;
      ">
        <!-- HEADER AVEC LOGO -->
        <div style="background:#111827; padding:24px; text-align:center;">
          <img src="${logoUrl}" alt="Grega Play"
            style="width:140px; height:auto; display:block; margin:auto;" />
        </div>

        <!-- CONTENU -->
        <div style="padding: 28px; color:#333; line-height:1.6;">

          <p style="font-size:15px; margin:0 0 10px;">
            Bonjour,
          </p>

          <p style="font-size:15px; margin:0 0 14px;">
            <strong>${safeOrganizerName}</strong> vous invite à participer à un montage vidéo collaboratif avec
            <strong style="color:#4CAF50;">Grega Play</strong>.
          </p>

          <!-- TITRE DE L'ÉVÉNEMENT -->
          <h2 style="
            text-align:center;
            color:#111827;
            margin:20px 0 14px;
            font-size:22px;
          ">
             ${safeEventTitle}
          </h2>

          ${
            eventThumbnailUrl
              ? `
          <!-- MINIATURE (optionnelle) -->
          <div style="text-align:center; margin-bottom:20px;">
            <img src="${eventThumbnailUrl}" alt="Miniature de l'événement ${safeEventTitle}"
              style="width:100%; max-width:420px; border-radius:10px; box-shadow:0 4px 12px rgba(0,0,0,0.15);" />
          </div>
          `
              : ""
          }

          ${
            eventDescription
              ? `
          <!-- DESCRIPTION -->
          <p style="margin-top:10px; font-size:14px;">
            <strong>Description :</strong><br/>
            ${eventDescription}
          </p>
          `
              : ""
          }

          ${
            deadline
              ? `
          <!-- DEADLINE -->
          <p style="margin-top:10px; font-size:14px;">
            <strong>Date limite :</strong> ${deadline}
          </p>
          `
              : ""
          }

          ${
            personalMessage
              ? `
          <!-- MESSAGE PERSONNEL -->
          <div style="margin-top:16px; padding:14px 18px; background:#f4f4f4; border-left:4px solid #4CAF50; border-radius:6px;">
            <p style="margin:0; font-size:14px;">
              <em>Message de ${safeOrganizerName} :</em><br/>
              ${personalMessage}
            </p>
          </div>
          `
              : ""
          }

          <!-- ÉTAPES -->
          <p style="margin-top:18px; font-size:14px;">🎯 <strong>Comment participer ?</strong></p>
          <ul style="padding-left:18px; font-size:14px; margin-top:8px;">
            <li>Cliquez sur le bouton ci-dessous pour rejoindre l’événement</li>
            <li>Créez votre compte Grega Play (si ce n’est pas déjà fait)</li>
            <li>Enregistrez ou téléchargez votre vidéo avant la date limite</li>
            <li>Profitez du montage final créé automatiquement 🎬</li>
          </ul>

          <!-- BOUTON PRINCIPAL -->
          <div style="text-align:center; margin:26px 0 18px;">
            <a href="${eventLink}"
              style="
                display:inline-block;
                padding:14px 28px;
                background:#4CAF50;
                color:#ffffff;
                font-weight:bold;
                font-size:15px;
                border-radius:8px;
                text-decoration:none;
                box-shadow:0 3px 8px rgba(0,0,0,0.15);
              "
              target="_blank"
            >
              👉 Rejoindre l’événement
            </a>
          </div>

          <!-- LIEN TEXTE -->
          <p style="font-size:12px; color:#666; text-align:center; margin-top:0;">
            Si le bouton ne fonctionne pas, ouvrez ce lien dans votre navigateur :<br/>
            <a href="${eventLink}" style="color:#4CAF50;" target="_blank">${eventLink}</a>
          </p>
        </div>

        <!-- FOOTER -->
        <div style="background:#f1f5f9; padding:16px; text-align:center; font-size:12px; color:#777;">
          Grega Play – Créez des moments qui rassemblent.<br/>
          © 2025 Grega Play, tous droits réservés.
        </div>
      </div>
    </div>
  `;

  return sendMail({ to, subject, html });
}

export default {
  sendMail,
  sendInvitationEmail,
};
