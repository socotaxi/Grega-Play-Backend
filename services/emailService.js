// services/emailService.js
import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  SMTP_FROM_EMAIL,
  SMTP_FROM_NAME,
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME,
  GREGAPLAY_LOGO_URL,
} = process.env;

const hasSmtp = !!SMTP_HOST && !!SMTP_USER && !!SMTP_PASSWORD;
const hasSendgrid = !!SENDGRID_API_KEY && !!SENDGRID_FROM_EMAIL;

let smtpTransporter = null;

if (hasSmtp) {
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASSWORD,
    },
  });
  console.log("📨 SMTP config chargée:", {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
  });
} else if (hasSendgrid) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log("📨 SendGrid config chargée:", {
    fromEmail: SENDGRID_FROM_EMAIL,
    fromName: SENDGRID_FROM_NAME,
  });
} else {
  console.warn(
    "⚠️ Aucun service email configuré (ni SMTP ni SendGrid). " +
      "Les emails ne seront pas envoyés, mais le backend reste en ligne."
  );
}

/**
 * Envoi générique d'email via SMTP (Brevo) ou SendGrid en fallback
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (hasSmtp) {
    const fromEmail = SMTP_FROM_EMAIL || SMTP_USER;
    const fromName = SMTP_FROM_NAME || "Grega Play";
    try {
      const info = await smtpTransporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject,
        text,
        html,
        ...(replyTo ? { replyTo } : {}),
      });
      console.log("📧 Email envoyé via SMTP →", to, "messageId:", info.messageId);
      return info;
    } catch (error) {
      console.error("❌ Erreur SMTP lors de l'envoi d'email:", error.message);
    }
    return;
  }

  if (hasSendgrid) {
    const fromName = SENDGRID_FROM_NAME || "Grega Play";
    const msg = {
      to,
      from: { email: SENDGRID_FROM_EMAIL, name: fromName },
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
    };
    try {
      const [response] = await sgMail.send(msg);
      console.log("📧 Email envoyé via SendGrid →", to, "statusCode:", response?.statusCode);
      return response;
    } catch (error) {
      console.error("❌ Erreur SendGrid lors de l'envoi d'email:", error.message);
      if (error.response) {
        console.error("📩 Détails SendGrid:", error.response.body);
      }
    }
    return;
  }

  console.warn("⏭️ Email ignoré (aucun service configuré) ->", subject, "->", to);
}

/**
 * Email d’invitation à un événement Grega Play
 */
async function sendInvitationEmail({
  to,
  inviterName,
  eventTitle,
  eventTheme,
  eventLink,
  eventDescription,
  deadline,
  personalMessage,
}) {
  const safeOrganizerName = inviterName || "L’organisateur";
  const safeEventTitle = eventTitle || "un événement vidéo collaboratif";
  const safeDescription = eventDescription
    ? eventDescription.slice(0, 300) + (eventDescription.length > 300 ? "..." : "")
    : "";

  console.log(
    "📨 [GregaPlay] sendInvitationEmail v3 pour:",
    to,
    "| event:",
    safeEventTitle
  );

  const subject = `${safeOrganizerName} vous invite à "${safeEventTitle}" sur Grega Play`;

  const text = `
${safeOrganizerName} vous invite à participer à un événement sur Grega Play : "${safeEventTitle}".

${safeDescription ? "À propos de l’événement :\n" + safeDescription : ""}
${deadline ? "\nDate limite : " + deadline : ""}
${personalMessage ? "\nMessage de " + safeOrganizerName + " : " + personalMessage : ""}

Pour rejoindre l’événement, ouvrez ce lien :
${eventLink}

Vous recevez cet email car ${safeOrganizerName} vous a invité(e) sur Grega Play.
`.trim();

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Invitation Grega Play</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:’Segoe UI’,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6c47ff 0%,#a855f7 100%);padding:40px 48px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">Grega Play</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Together, we create the moment</p>
            </td>
          </tr>

          <!-- Intro -->
          <tr>
            <td style="padding:40px 48px 0;">
              <p style="margin:0 0 8px;color:#999;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Vous avez une invitation</p>
              <h2 style="margin:0 0 16px;color:#1a1a2e;font-size:22px;font-weight:700;line-height:1.3;">
                ${safeOrganizerName} vous invite à participer à un événement vidéo collaboratif
              </h2>
              <p style="margin:0;color:#666;font-size:15px;line-height:1.7;">
                Rejoignez l’événement, partagez vos moments en vidéo et découvrez le montage final créé automatiquement par Grega Play.
              </p>
            </td>
          </tr>

          <!-- Event Card -->
          <tr>
            <td style="padding:32px 48px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5ff;border:1px solid #e4dcff;border-radius:10px;overflow:hidden;">
                <tr>
                  <td style="background:#6c47ff;width:5px;padding:0;">&nbsp;</td>
                  <td style="padding:24px 24px 20px;">

                    <p style="margin:0 0 4px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Événement</p>
                    <h3 style="margin:0 0 16px;color:#1a1a2e;font-size:18px;font-weight:700;">${safeEventTitle}</h3>

                    ${eventTheme ? `
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:0 12px 0 0;vertical-align:top;">
                          <span style="display:inline-block;background:#ede9ff;color:#6c47ff;font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;">${eventTheme}</span>
                        </td>
                      </tr>
                    </table>
                    <hr style="border:none;border-top:1px solid #e4dcff;margin:16px 0;"/>
                    ` : ""}

                    ${safeDescription ? `<p style="margin:0;color:#555;font-size:14px;line-height:1.7;">${safeDescription}</p>` : ""}

                    ${deadline ? `
                    <p style="margin:12px 0 0;font-size:13px;color:#6c47ff;font-weight:600;">
                      Date limite : ${deadline}
                    </p>
                    ` : ""}

                    ${personalMessage ? `
                    <div style="margin-top:16px;padding:14px 16px;background:#ffffff;border-left:3px solid #a855f7;border-radius:6px;">
                      <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
                        <strong>Message de ${safeOrganizerName} :</strong><br/>
                        <em>${personalMessage}</em>
                      </p>
                    </div>
                    ` : ""}

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Steps -->
          <tr>
            <td style="padding:32px 48px 0;">
              <p style="margin:0 0 20px;color:#1a1a2e;font-size:15px;font-weight:700;">Comment participer ?</p>

              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 0 16px;">
                    <table cellpadding="0" cellspacing="0"><tr>
                      <td style="width:36px;vertical-align:top;"><span style="display:inline-block;width:28px;height:28px;background:#6c47ff;color:#fff;font-size:13px;font-weight:700;border-radius:50%;text-align:center;line-height:28px;">1</span></td>
                      <td style="padding-left:12px;vertical-align:middle;"><p style="margin:0;color:#444;font-size:14px;line-height:1.5;">Cliquez sur le bouton ci-dessous pour rejoindre l’événement</p></td>
                    </tr></table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 16px;">
                    <table cellpadding="0" cellspacing="0"><tr>
                      <td style="width:36px;vertical-align:top;"><span style="display:inline-block;width:28px;height:28px;background:#6c47ff;color:#fff;font-size:13px;font-weight:700;border-radius:50%;text-align:center;line-height:28px;">2</span></td>
                      <td style="padding-left:12px;vertical-align:middle;"><p style="margin:0;color:#444;font-size:14px;line-height:1.5;">Créez votre compte Grega Play ou connectez-vous</p></td>
                    </tr></table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 16px;">
                    <table cellpadding="0" cellspacing="0"><tr>
                      <td style="width:36px;vertical-align:top;"><span style="display:inline-block;width:28px;height:28px;background:#6c47ff;color:#fff;font-size:13px;font-weight:700;border-radius:50%;text-align:center;line-height:28px;">3</span></td>
                      <td style="padding-left:12px;vertical-align:middle;"><p style="margin:0;color:#444;font-size:14px;line-height:1.5;">Enregistrez ou téléchargez votre vidéo <span style="color:#6c47ff;font-weight:600;">(max 30 secondes)</span></p></td>
                    </tr></table>
                  </td>
                </tr>
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0"><tr>
                      <td style="width:36px;vertical-align:top;"><span style="display:inline-block;width:28px;height:28px;background:#a855f7;color:#fff;font-size:13px;font-weight:700;border-radius:50%;text-align:center;line-height:28px;">✓</span></td>
                      <td style="padding-left:12px;vertical-align:middle;"><p style="margin:0;color:#444;font-size:14px;line-height:1.5;">Profitez du montage final créé <strong>automatiquement</strong> 🎬</p></td>
                    </tr></table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding:36px 48px 0;text-align:center;">
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:linear-gradient(135deg,#6c47ff 0%,#a855f7 100%);border-radius:8px;">
                    <a href="${eventLink}" style="display:inline-block;padding:16px 44px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px;letter-spacing:0.2px;">
                      Participer à l’événement →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:36px 48px 0;">
              <hr style="border:none;border-top:1px solid #ebebf0;margin:0;"/>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding:20px 48px 0;">
              <p style="margin:0 0 6px;color:#aaa;font-size:12px;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>
              <p style="margin:0;word-break:break-all;">
                <a href="${eventLink}" style="color:#6c47ff;font-size:12px;text-decoration:none;">${eventLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9fb;padding:24px 48px;text-align:center;border-top:1px solid #ebebf0;margin-top:24px;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.7;">
                Vous recevez cet email car vous avez été invité(e) à rejoindre un événement sur <strong>Grega Play</strong>.<br/>
                Si vous n’attendiez pas cette invitation, vous pouvez ignorer cet email.
              </p>
              <p style="margin:12px 0 0;color:#ccc;font-size:11px;">© 2026 Grega Play — Tous droits réservés</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  return sendMail({ to, subject, html, text });
}

/**
 * Emails de rappel aux participants qui n'ont pas encore soumis de vidéo
 */
async function sendReminderToParticipants({ event, participants, eventLink }) {
  const safeTitle = event.title || "l'événement";
  const formattedDeadline = event.deadline
    ? new Date(event.deadline).toLocaleDateString("fr-FR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  const results = await Promise.allSettled(
    participants.map((participant) => {
      const safeName = participant.name || "vous";

      const subject = `Rappel : n'oubliez pas de soumettre votre vidéo pour "${safeTitle}"`;

      const text = `
Bonjour ${safeName},

Vous avez été invité(e) à participer à l'événement "${safeTitle}" sur Grega Play et nous n'avons pas encore reçu votre vidéo.

${formattedDeadline ? `Date limite : ${formattedDeadline}\n` : ""}
Soumettez votre vidéo dès maintenant :
${eventLink}

L'équipe Grega Play
`.trim();

      const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Rappel Grega Play</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6c47ff 0%,#a855f7 100%);padding:40px 48px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">Grega Play</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Together, we create the moment</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 48px 0;">
              <p style="margin:0 0 8px;color:#999;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Rappel</p>
              <h2 style="margin:0 0 16px;color:#1a1a2e;font-size:22px;font-weight:700;line-height:1.3;">
                Votre vidéo pour &laquo;&nbsp;${safeTitle}&nbsp;&raquo; nous attend encore !
              </h2>
              <p style="margin:0;color:#666;font-size:15px;line-height:1.7;">
                Bonjour ${safeName},<br/><br/>
                Vous avez été invité(e) à participer à cet événement vidéo collaboratif et nous n'avons pas encore reçu votre contribution. Il n'est pas trop tard !
              </p>
            </td>
          </tr>

          <!-- Event card -->
          <tr>
            <td style="padding:32px 48px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5ff;border:1px solid #e4dcff;border-radius:10px;overflow:hidden;">
                <tr>
                  <td style="background:#6c47ff;width:5px;padding:0;">&nbsp;</td>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Événement</p>
                    <h3 style="margin:0 0 10px;color:#1a1a2e;font-size:17px;font-weight:700;">${safeTitle}</h3>
                    ${formattedDeadline ? `<p style="margin:0;font-size:13px;color:#6c47ff;font-weight:600;">Date limite : ${formattedDeadline}</p>` : ""}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:36px 48px 0;text-align:center;">
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:linear-gradient(135deg,#6c47ff 0%,#a855f7 100%);border-radius:8px;">
                    <a href="${eventLink}" style="display:inline-block;padding:16px 44px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px;">
                      Soumettre ma vidéo →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding:24px 48px 0;">
              <hr style="border:none;border-top:1px solid #ebebf0;margin:0 0 16px;"/>
              <p style="margin:0 0 6px;color:#aaa;font-size:12px;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>
              <p style="margin:0;word-break:break-all;">
                <a href="${eventLink}" style="color:#6c47ff;font-size:12px;text-decoration:none;">${eventLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9fb;padding:24px 48px;text-align:center;border-top:1px solid #ebebf0;margin-top:24px;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.7;">
                Vous recevez cet email car vous avez été invité(e) à un événement sur <strong>Grega Play</strong>.<br/>
                Si vous ne souhaitez plus recevoir ces rappels, ignorez cet email.
              </p>
              <p style="margin:12px 0 0;color:#ccc;font-size:11px;">© 2026 Grega Play — Tous droits réservés</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

      return sendMail({ to: participant.email, subject, html, text });
    })
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(`📧 Rappels envoyés : ${sent} réussis, ${failed} échoués`);
  return { sent, failed };
}

export default {
  sendMail,
  sendInvitationEmail,
  sendReminderToParticipants,
};
