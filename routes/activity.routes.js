// routes/activity.routes.js
import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * DELETE /api/activity/event/:eventId
 * Supprime toutes les activités d'un événement
 */
router.delete("/event/:eventId", async (req, res) => {
  const { eventId } = req.params;

  if (!eventId) {
    return res.status(400).json({ error: "eventId manquant" });
  }

  const { error } = await supabase
    .from("activity_feed")
    .delete()
    .eq("event_id", eventId);

  if (error) {
    console.error("❌ Erreur suppression activity_feed (event):", error);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true });
});

/**
 * DELETE /api/activity/user/:userId
 * Supprime toutes les activités d'un utilisateur
 */
router.delete("/user/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: "userId manquant" });
  }

  const { error } = await supabase
    .from("activity_feed")
    .delete()
    .eq("user_id", userId);

  if (error) {
    console.error("❌ Erreur suppression activity_feed (user):", error);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true });
});

export default router;
