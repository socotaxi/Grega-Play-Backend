// backend/routes/capabilitiesRoutes.js
import express from "express";
import { computeEventCapabilities, computeBatchEventCapabilities } from "../services/capabilitiesService.js";
import { requireAuth } from "../services/authMiddleware.js";

const router = express.Router();

router.get("/api/events/:eventId/capabilities", requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.id; // défini par requireAuth

    const caps = await computeEventCapabilities({ userId, eventId });

    return res.json({
      role: caps.role,
      actions: caps.actions,
      limits: caps.limits,
      premium: caps.premium, // utile au debug/UX
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      error: {
        code: e.code || "CAPABILITIES_FAILED",
        message: e.message || "Erreur lors du calcul des capabilities.",
        status,
        details: process.env.NODE_ENV !== "production" ? e.cause : undefined,
      },
    });
  }
});

router.post("/api/events/capabilities-batch", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { eventIds } = req.body;

    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: { code: "INVALID_INPUT", message: "eventIds doit être un tableau non vide.", status: 400 } });
    }
    if (eventIds.length > 50) {
      return res.status(400).json({ error: { code: "TOO_MANY_IDS", message: "Maximum 50 eventIds par requête.", status: 400 } });
    }

    const results = await computeBatchEventCapabilities({ userId, eventIds });
    return res.json({ results });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      error: {
        code: e.code || "CAPABILITIES_BATCH_FAILED",
        message: e.message || "Erreur lors du calcul batch des capabilities.",
        status,
        details: process.env.NODE_ENV !== "production" ? e.cause : undefined,
      },
    });
  }
});

export default router;
