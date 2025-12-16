// backend/routes/capabilitiesRoutes.js
import express from "express";
import { computeEventCapabilities } from "../services/capabilitiesService.js";
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

export default router;
