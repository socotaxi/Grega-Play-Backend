// server-minimal.js
import express from "express";

const app = express();

// Route de test
app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
  });
});

// Lancement serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend minimal en écoute sur le port ${PORT}`);
});
