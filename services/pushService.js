// services/pushService.js
import dotenv from "dotenv";
dotenv.config(); // ⚠️ charge le .env AVANT de lire process.env

import webPush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@socotaxi.com";

// Petit log pour debug (tu peux le retirer ensuite)
console.log("🔐 VAPID_PUBLIC_KEY définie ?", !!VAPID_PUBLIC_KEY);
console.log("🔐 VAPID_PRIVATE_KEY définie ?", !!VAPID_PRIVATE_KEY);

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("❌ Clés VAPID manquantes. Vérifie ton fichier .env dans grega-play-backend");
  throw new Error("VAPID keys are missing");
}

webPush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

export async function sendPushNotification(subscription, payload) {
  return webPush.sendNotification(subscription, JSON.stringify(payload));
}
