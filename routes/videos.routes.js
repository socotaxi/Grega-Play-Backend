import { Router } from "express";
import { upload } from "../services/uploadMiddleware.js";

import {
  uploadVideo,
  deleteVideo,
  processVideoSync,
  processVideoAsync,
  getJobStatus,
  adminKillJob,
  adminRetryJob,
} from "../controllers/videos.controller.js";

const router = Router();

// Upload vidéo
router.post("/upload", upload.single("video"), uploadVideo);

// Delete vidéo
router.delete("/:videoId", deleteVideo);

// Génération sync (inchangé)
router.post("/process", processVideoSync);

// Génération async (nouveau)
router.post("/process-async", processVideoAsync);

// Statut job
router.get("/jobs/:jobId", getJobStatus);

// Admin: kill job
router.post("/admin/jobs/:jobId/kill", adminKillJob);

// Admin: retry job
router.post("/admin/jobs/:jobId/retry", adminRetryJob);

export default router;
