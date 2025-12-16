// backend/services/videoProcessing/assetResolver.js
import path from "path";
import fs from "fs";
import https from "https";
import http from "http";

/**
 * Téléchargement http(s) simple
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https://") ? https : http;

    const file = fs.createWriteStream(dest);
    const req = proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return resolve(downloadFile(res.headers.location, dest));
      }

      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`Erreur HTTP ${res.statusCode} sur ${url}`));
      }

      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(dest);
      });
    });

    req.on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function isHttpUrl(u) {
  return typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
}

/**
 * Résout un asset depuis :
 * - storagePath (bucket privé) => signedUrl => download local
 * - url http(s) => download local (fallback compat)
 * - sinon null
 */
export async function resolveAssetToLocalFile({
  supabase,
  bucket = "premium-assets",
  storagePath,
  url,
  tempDir,
  fileNameHint = "asset",
}) {
  if (!tempDir) throw new Error("tempDir manquant pour resolveAssetToLocalFile.");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // 1) storagePath prioritaire
  if (storagePath && typeof storagePath === "string") {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 60 * 60);
    if (error) throw error;
    const signedUrl = data?.signedUrl;
    if (!signedUrl) throw new Error("Signed URL introuvable.");

    const ext = path.extname(storagePath) || "";
    const out = path.join(tempDir, `${fileNameHint}${ext}`);
    await downloadFile(signedUrl, out);
    return out;
  }

  // 2) fallback url externe (compat ancienne logique)
  if (isHttpUrl(url)) {
    const ext = path.extname(new URL(url).pathname) || "";
    const out = path.join(tempDir, `${fileNameHint}${ext}`);
    await downloadFile(url, out);
    return out;
  }

  return null;
}
