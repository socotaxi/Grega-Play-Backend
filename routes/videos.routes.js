import { Router } from "express";
import { upload } from "../services/uploadMiddleware.js";

import {
  uploadVideo,
  deleteVideo,
  processVideoSync,
  processVideoAsync,
  getJobStatus,
} from "../controllers/videos.controller.js";

const router = Router();

// Upload vidéo
router.post("/upload", upload.single("video"), uploadVideo);

// Delete vidéo
router.delete("/:id", deleteVideo);

// Génération sync (inchangé)
router.post("/process", processVideoSync);

// Génération async (nouveau)
router.post("/process-async", processVideoAsync);

// Statut job
router.get("/jobs/:jobId", getJobStatus);

export default router;
