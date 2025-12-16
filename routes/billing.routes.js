import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function addDurationToNow(duration) {
  const now = new Date();
  const d = String(duration || "").toLowerCase();

  // Aligné avec ton front: "1w", "1m", et event: "24h", "3d", "7d"
  if (d === "1w") now.setDate(now.getDate() + 7);
  else if (d === "1m") now.setMonth(now.getMonth() + 1);
  else if (d === "24h") now.setHours(now.getHours() + 24);
  else if (d === "3d") now.setDate(now.getDate() + 3);
  else if (d === "7d") now.setDate(now.getDate() + 7);
  else {
    // défaut sûr
    now.setDate(now.getDate() + 7);
  }

  return now.toISOString();
}

// ✅ Boost compte (Premium offert)
router.post("/checkout-account", async (req, res) => {
  try {
    const { userId, duration } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId manquant." });

    const expiresAt = addDurationToNow(duration || "1w");

    const { error } = await supabase
      .from("profiles")
      .update({
        is_premium_account: true,
        premium_account_expires_at: expiresAt,
      })
      .eq("id", userId);

    if (error) {
      console.error("❌ billing checkout-account update profiles:", error);
      return res.status(500).json({ error: "Impossible d'activer le Premium." });
    }

    return res.status(200).json({
      message: "Compte Premium activé (offre de lancement).",
      expiresAt,
    });
  } catch (e) {
    console.error("❌ billing checkout-account:", e);
    return res.status(500).json({ error: "Erreur interne billing." });
  }
});

// ✅ Boost événement (Premium offert)
router.post("/checkout-event", async (req, res) => {
  try {
    const { eventId, userId, duration } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "eventId manquant." });
    if (!userId) return res.status(400).json({ error: "userId manquant." });

    // sécurité: seul le créateur peut booster son event
    const { data: ev, error: evErr } = await supabase
      .from("events")
      .select("id,user_id")
      .eq("id", eventId)
      .maybeSingle();

    if (evErr) {
      console.error("❌ billing checkout-event load event:", evErr);
      return res.status(500).json({ error: "Erreur chargement événement." });
    }
    if (!ev) return res.status(404).json({ error: "Événement introuvable." });
    if (ev.user_id !== userId) {
      return res.status(403).json({ error: "Seul le créateur peut booster l'événement." });
    }

    const expiresAt = addDurationToNow(duration || "3d");

    const { error } = await supabase
      .from("events")
      .update({
        is_premium_event: true,
        premium_event_expires_at: expiresAt,
      })
      .eq("id", eventId)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ billing checkout-event update events:", error);
      return res.status(500).json({ error: "Impossible de booster cet événement." });
    }

    return res.status(200).json({
      message: "Événement Premium activé (offre de lancement).",
      expiresAt,
    });
  } catch (e) {
    console.error("❌ billing checkout-event:", e);
    return res.status(500).json({ error: "Erreur interne billing." });
  }
});

export default router;
