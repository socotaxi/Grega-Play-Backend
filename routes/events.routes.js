import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------
// Helpers
// -------------------------------
function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function safeCount(table, filterCol, filterVal) {
  // Count exact rows; returns 0 if table/column doesn't exist
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(filterCol, filterVal);

  if (error) {
    // Ex: table doesn't exist, column doesn't exist, etc.
    return 0;
  }
  return count || 0;
}

async function computeOwnerPremium(userId) {
  // Support: nouveau modèle is_premium_account + expiration
  // Support: ancien modèle is_premium (legacy)
  const { data: p, error } = await supabase
    .from("profiles")
    .select("id, is_premium_account, premium_account_expires_at, is_premium")
    .eq("id", userId)
    .maybeSingle();

  if (error || !p) {
    return {
      owner_has_premium_account: false,
      owner_premium_expires_at: null,
    };
  }

  const now = new Date();
  const expiresAt = toDateOrNull(p.premium_account_expires_at);

  const hasNewPremium =
    p.is_premium_account === true && expiresAt && expiresAt > now;

  const hasLegacyPremium = p.is_premium === true;

  return {
    owner_has_premium_account: Boolean(hasNewPremium || hasLegacyPremium),
    owner_premium_expires_at: expiresAt ? expiresAt.toISOString() : null,
  };
}

// -------------------------------
// GET /api/events/:eventId/stats
// - stats UI: totalInvitations / totalWithVideo / totalPending
// - champs "capabilities-like": videos_count, max_videos, hasReachedUploadLimit, is_effective_premium_event
// -------------------------------
router.get("/:eventId/stats", async (req, res) => {
  try {
    const { eventId } = req.params;

    // 1) Event
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, user_id, max_videos, status, is_premium_event, created_at")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: "Événement introuvable." });
    }

    // 2) Premium effectif (événement premium OU owner premium account)
    const ownerPremium = await computeOwnerPremium(event.user_id);
    const is_premium_event = event.is_premium_event === true;
    const is_effective_premium_event =
      is_premium_event || ownerPremium.owner_has_premium_account;

    // 3) Videos count
    const videos_count = await safeCount("videos", "event_id", eventId);

    // 4) Invitations count
    // Ton front utilise "invitations" (historique), mais ton ancien bloc testait "event_invites".
    // On supporte les deux sans casser si une table n'existe pas.
    const invitations_count = await safeCount("invitations", "event_id", eventId);
    const event_invites_count = await safeCount("event_invites", "event_id", eventId);

    const invites_count = invitations_count > 0 ? invitations_count : event_invites_count;

    // 5) Limite upload (aligné capabilities)
    const max_videos = typeof event.max_videos === "number" ? event.max_videos : 0;
    const hasReachedUploadLimit = max_videos > 0 ? videos_count >= max_videos : false;

    // 6) Stats UI (indicateurs)
    // totalWithVideo = indicateur: combien de “participants couverts” par au moins une vidéo
    // (si premium/multi-vidéos, cet indicateur reste OK comme "avancement", pas comme “vidéos uniques”)
    const totalInvitations = invites_count;
    const totalWithVideo = Math.min(videos_count, totalInvitations);
    const totalPending = Math.max(totalInvitations - totalWithVideo, 0);

    return res.json({
      // ✅ UI existante (Dashboard)
      totalInvitations,
      totalWithVideo,
      totalPending,

      // ✅ champs utiles (capabilities-like)
      event_id: event.id,
      status: event.status ?? "open",
      created_at: event.created_at,
      creator_user_id: event.user_id,

      videos_count,
      invites_count,
      max_videos,
      hasReachedUploadLimit,

      is_premium_event,
      ...ownerPremium,
      is_effective_premium_event,
    });
  } catch (e) {
    console.error("❌ /events/:eventId/stats error:", e);
    return res.status(500).json({ error: "Erreur interne stats événement." });
  }
});

export default router;
