// services/pushService.js
import dotenv from "dotenv";
import webPush from "web-push";

dotenv.config();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const RAW_VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@gregaplay.com";

// Normalisation du subject pour éviter l'erreur "Vapid subject is not a valid URL"
function normalizeSubject(subject) {
  if (!subject) return null;

  const trimmed = subject.trim();

  // Si commence déjà par mailto: ou http/https → OK
  if (
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }

  // Si ça ressemble à une adresse email simple → on préfixe par mailto:
  if (trimmed.includes("@") && !trimmed.includes(" ")) {
    return `mailto:${trimmed}`;
  }

  // Sinon, on considère que c'est invalide
  return null;
}

const VAPID_SUBJECT = normalizeSubject(RAW_VAPID_SUBJECT);

console.log("🔐 VAPID_PUBLIC_KEY définie ?", !!VAPID_PUBLIC_KEY);
console.log("🔐 VAPID_PRIVATE_KEY définie ?", !!VAPID_PRIVATE_KEY);
console.log("🔐 VAPID_SUBJECT (normalisé) :", VAPID_SUBJECT);

let vapidConfigured = false;

// On n'active web-push que si on a bien les 3 éléments valides
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  try {
    webPush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
    console.log("✅ VAPID configuré avec succès (web-push prêt).");
  } catch (error) {
    console.error(
      "❌ Erreur lors de la configuration VAPID (web-push):",
      error.message
    );
    console.warn(
      "⚠️ Les notifications push sont désactivées à cause d'une erreur VAPID."
    );
    vapidConfigured = false;
  }
} else {
  console.warn(
    "⚠️ Clés VAPID ou subject manquants/invalides. Les notifications push sont désactivées."
  );
}

export async function sendPushNotification(subscription, payload) {
  if (!vapidConfigured) {
    console.warn("⏭️ Push ignoré (VAPID non configuré ou invalide).");
    return;
  }

  try {
    return await webPush.sendNotification(
      subscription,
      JSON.stringify(payload)
    );
  } catch (error) {
    console.error("❌ Erreur lors de l'envoi de la notification push:", error);
  }
}
