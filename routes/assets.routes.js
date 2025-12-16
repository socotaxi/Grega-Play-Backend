// backend/routes/assets.routes.js
import express from "express";
import { uploadPremiumAsset } from "../controllers/assets.controller.js";

const router = express.Router();

// POST /api/assets/upload
router.post("/upload", uploadPremiumAsset);

export default router;
