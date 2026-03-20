// services/eventNotifier.js
import { createClient } from "@supabase/supabase-js";
import { sendPushNotification } from "./pushService.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "";

/**
 * Envoie une notification push + in-app à une liste de user_ids.
 * Fail-safe : une erreur n'interrompt pas l'action principale.
 */
async function dispatchToUsers(userIds, payload) {
  if (!userIds.length) return;

  // In-app (notifications table)
  try {
    await supabase.from("notifications").insert(
      userIds.map((userId) => ({
        user_id: userId,
        title: payload.title,
        message: payload.body,
        type: payload.type || "info",
        link: payload.url || null,
        read: false,
      }))
    );
  } catch (err) {
    console.error("⚠️ eventNotifier: erreur insert notifications:", err?.message);
  }

  // Push (Web Push via VAPID)
  try {
    const { data: subscriptions } = await supabase
      .from("notification_subscriptions")
      .select("user_id, endpoint, p256dh, auth")
      .in("user_id", userIds);

    if (subscriptions?.length) {
      await Promise.allSettled(
        subscriptions.map((sub) =>
          sendPushNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          )
        )
      );
    }
  } catch (err) {
    console.error("⚠️ eventNotifier: erreur envoi push:", err?.message);
  }
}

/**
 * Notifie tous les participants d'un événement (créateur inclus).
 *
 * @param {string} eventId
 * @param {{ title: string, body: string, url?: string, type?: string }} payload
 * @param {{ excludeUserId?: string }} options
 */
export async function notifyEventParticipants(eventId, payload, { excludeUserId } = {}) {
  try {
    const [{ data: event }, { data: participants }] = await Promise.all([
      supabase.from("events").select("user_id").eq("id", eventId).single(),
      supabase.from("event_participants").select("user_id").eq("event_id", eventId),
    ]);

    const seen = new Set();
    if (event?.user_id) seen.add(event.user_id);
    for (const p of participants || []) {
      if (p.user_id) seen.add(p.user_id);
    }
    if (excludeUserId) seen.delete(excludeUserId);

    await dispatchToUsers([...seen], payload);
  } catch (err) {
    console.error("❌ notifyEventParticipants error:", err?.message || err);
  }
}

/**
 * Notifie un seul utilisateur.
 *
 * @param {string} userId
 * @param {{ title: string, body: string, url?: string, type?: string }} payload
 */
export async function notifyUser(userId, payload) {
  try {
    await dispatchToUsers([userId], payload);
  } catch (err) {
    console.error("❌ notifyUser error:", err?.message || err);
  }
}

/**
 * Payload : nouvelle vidéo soumise (→ créateur de l'event)
 */
export function buildNewVideoPayload(eventTitle, participantName, eventId) {
  return {
    title: "Nouvelle vidéo reçue 🎬",
    body: `${participantName || "Un participant"} a soumis une vidéo pour "${eventTitle || "votre événement"}"`,
    url: `${PUBLIC_SITE_URL}/events/${eventId}`,
    type: "video_submitted",
  };
}

/**
 * Payload : montage final prêt (→ tous les participants)
 */
export function buildFinalVideoPayload(eventTitle, eventId, finalVideoUrl) {
  return {
    title: "Montage final prêt 🎉",
    body: `Le montage de "${eventTitle || "votre événement"}" est disponible !`,
    url: `${PUBLIC_SITE_URL}/events/${eventId}/final`,
    type: "final_video_ready",
  };
}
