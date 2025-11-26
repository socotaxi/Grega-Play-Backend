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
 * Email d'invitation à un événement Grega Play (version premium)
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

  // LOG DE VERSION POUR DEBUG
  console.log(
    "📨 [GregaPlay] sendInvitationEmail PREMIUM v2 utilisé pour:",
    to,
    "| event:",
    safeEventTitle
  );

  // Sujet modifié pour être sûr de voir la nouvelle version
  const subject = `Grega Play – Invitation à "${safeEventTitle}" (v2)`;

  // Logo : priorité à la variable d'env, sinon logo par défaut
  const logoUrl =
    GREGAPLAY_LOGO_URL ||
    "https://cgqnrqbyvetcgwolkjvl.supabase.co/storage/v1/object/public/gregaplay-assets/logo.png";

  // Version texte (utile pour éviter le spam & clients texte-only)
  const text = `
${safeOrganizerName} vous invite à participer à un événement sur Grega Play : "${safeEventTitle}".

${eventDescription ? "À propos de l’événement :\n" + eventDescription.slice(0, 300) + (eventDescription.length > 300 ? "..." : "") : ""}

Date limite pour envoyer votre vidéo : ${deadline || "non précisée"}

Pour rejoindre l'événement, ouvrez ce lien :
${eventLink}

Vous recevez cet email parce que ${safeOrganizerName} a saisi votre adresse sur Grega Play pour vous inviter à participer à ce montage vidéo collaboratif.
`.trim();

  // Template HTML PREMIUM
  const html = `
  <div style="font-family: Inter, Arial, sans-serif; background:#f4f6f9; padding:32px;">
    <div style="
      max-width:600px;
      margin:auto;
      background:#ffffff;
      border-radius:18px;
      overflow:hidden;
      box-shadow:0 10px 35px rgba(0,0,0,0.12);
    ">

      <!-- HEADER AVEC LOGO -->
      <div style="background:#0f172a; padding:32px 24px; text-align:center;">
        <img src="${logoUrl}"
             alt="Grega Play"
             style="width:180px; height:auto; display:block; margin:auto;" />
        <p style="color:#e2e8f0; font-size:14px; margin-top:12px; opacity:0.8;">
          Montage vidéo collaboratif – Simple, rapide, puissant
        </p>
      </div>

      <div style="padding:32px;">

        <!-- TITRE -->
        <h1 style="
          margin:0;
          font-size:26px;
          color:#0f172a;
          text-align:center;
          line-height:1.3;
        ">
           Invitation à l’événement : <br/>
          <span style="color:#16a34a;">${safeEventTitle}</span>
        </h1>

        <!-- ORGANISATEUR -->
        <p style="text-align:center; margin-top:10px; font-size:15px; color:#334155;">
          Organisé par : <strong>${safeOrganizerName}</strong>
        </p>

        <!-- MINIATURE -->
        ${
          eventThumbnailUrl
            ? `
        <div style="text-align:center; margin:28px 0;">
          <img src="${eventThumbnailUrl}"
               alt="Image de l'événement"
               style="
                 width:100%;
                 max-width:480px;
                 border-radius:14px;
                 box-shadow:0 6px 18px rgba(0,0,0,0.15);
               "/>
        </div>
        `
            : ""
        }

        <!-- DESCRIPTION -->
        ${
          eventDescription
            ? `
        <p style="margin:12px 0; font-size:15px; color:#475569; line-height:1.6;">
          <strong>À propos de l’événement :</strong><br/>
          ${eventDescription.slice(0, 300)}${eventDescription.length > 300 ? "..." : ""}
        </p>
        `
            : ""
        }

        ${
          deadline
            ? `
        <p style="margin-top:14px; font-size:14px; color:#334155;">
          <strong>Date limite pour envoyer votre vidéo :</strong><br/>
          <span style="color:#dc2626;">${deadline}</span>
        </p>
        `
            : ""
        }

        <!-- MESSAGE PERSONNEL -->
        ${
          personalMessage
            ? `
        <div style="margin-top:22px; padding:18px 22px; background:#f1f5f9; border-left:5px solid #16a34a; border-radius:10px;">
          <p style="margin:0; font-size:14px; color:#334155;">
            <strong>Message de ${safeOrganizerName} :</strong><br/>
            <em>${personalMessage}</em>
          </p>
        </div>
        `
            : ""
        }

        <!-- COMMENT PARTICIPER -->
        <h3 style="margin-top:30px; font-size:18px; color:#0f172a;">
          🎯 Comment participer ?
        </h3>

        <ul style="font-size:15px; color:#475569; padding-left:20px; line-height:1.7;">
          <li>Cliquez sur le bouton ci-dessous</li>
          <li>Créez votre compte Grega Play ou connectez-vous</li>
          <li>Enregistrez ou téléchargez une vidéo (max 30 sec)</li>
          <li>Recevez automatiquement le montage final 🎬</li>
        </ul>

        <!-- CTA -->
        <div style="text-align:center; margin:36px 0 24px;">
          <a href="${eventLink}"
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
            👉 Rejoindre l’événement
          </a>
        </div>

        <!-- LIEN TEXTE -->
        <p style="font-size:12px; text-align:center; color:#64748b;">
          Si le bouton ne fonctionne pas, ouvrez ce lien :<br/>
          <a href="${eventLink}" style="color:#16a34a;">${eventLink}</a>
        </p>
      </div>

      <!-- FOOTER -->
      <div style="background:#f8fafc; padding:18px; text-align:center; font-size:12px; color:#64748b;">
        Grega Play – L’émotion se construit ensemble<br/>
        <span style="font-size:11px; color:#94a3b8;">
          Version template: PREMIUM-v2
        </span><br/>
        © 2025 Grega Play
      </div>
    </div>
  </div>
`;

  return sendMail({ to, subject, html, text });
}

export default {
  sendMail,
  sendInvitationEmail,
};
