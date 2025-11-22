// routes/notifications.js
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { sendPushNotification } from "../services/pushService.js";

const router = express.Router();

// ⚙️ Client Supabase pour cette route
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * GET /api/notifications/public-key
 * -> renvoie la clé publique VAPID pour le frontend
 */
router.get("/public-key", (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: "VAPID_PUBLIC_KEY manquante" });
  }
  return res.json({ publicKey });
});

/**
 * POST /api/notifications/subscribe
 * Body JSON :
 * {
 *   "userId": "uuid_supabase",
 *   "subscription": {
 *      "endpoint": "...",
 *      "keys": { "p256dh": "...", "auth": "..." }
 *   }
 * }
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { userId, subscription } = req.body;

    if (!userId || !subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: "Données de subscription invalides" });
    }

    const { endpoint, keys } = subscription;
    const { p256dh, auth } = keys;

    // Option : supprimer d'abord les anciennes subscriptions pour cet endpoint
    await supabase
      .from("notification_subscriptions")
      .delete()
      .eq("endpoint", endpoint);

    const { error } = await supabase.from("notification_subscriptions").insert([
      {
        user_id: userId,
               endpoint,
        p256dh,
        auth,
      },
    ]);

    if (error) {
      console.error("❌ Erreur Supabase insert subscription :", error);
      return res.status(500).json({ error: "Erreur enregistrement subscription" });
    }

    return res.status(201).json({ success: true });
  } catch (err) {
    console.error("❌ Erreur /api/notifications/subscribe :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * POST /api/notifications/test
 * Body JSON:
 * {
 *   "userId": "uuid_supabase"
 * }
 * -> Envoie une notif de test à tous les abonnements de ce user
 */
router.post("/test", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId manquant" });
  }

  const payload = {
    title: "Grega Play",
    body: "Test notification push",
    url: "https://gregaplay.com/dashboard",
  };

  try {
    const { data: subs, error } = await supabase
      .from("notification_subscriptions")
      .select("*")
      .eq("user_id", userId);

    if (error) throw error;

    const results = [];

    for (const sub of subs) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await sendPushNotification(subscription, payload);
        results.push({ endpoint: sub.endpoint, status: "ok" });
      } catch (err) {
        console.error("❌ Erreur envoi push test :", err);
        results.push({ endpoint: sub.endpoint, status: "error" });
      }
    }

    return res.json({ success: true, results });
  } catch (err) {
    console.error("❌ Erreur /api/notifications/test :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
