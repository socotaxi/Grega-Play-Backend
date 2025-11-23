// services/pushService.js
import dotenv from "dotenv";

// Charge .env **sans override** pour ne pas écraser Railway
dotenv.config();

import webPush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@socotaxi.com";

// Logs debug
console.log("🔐 VAPID_PUBLIC_KEY définie ?", !!VAPID_PUBLIC_KEY);
console.log("🔐 VAPID_PRIVATE_KEY définie ?", !!VAPID_PRIVATE_KEY);

// Flag pour activer/désactiver les notifications push
const hasVapid = !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY;

if (hasVapid) {
  webPush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️ Clés VAPID manquantes. Les notifications push sont désactivées.");
}

export async function sendPushNotification(subscription, payload) {
  if (!hasVapid) {
    console.warn("⏭️ Push ignoré (VAPID non configuré).");
    return;
  }

  return webPush.sendNotification(subscription, JSON.stringify(payload));
}
