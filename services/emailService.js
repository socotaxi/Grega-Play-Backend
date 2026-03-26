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

export default {
  sendMail,
};
