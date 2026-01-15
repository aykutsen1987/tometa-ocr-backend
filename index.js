// index.js (Geliştirilmiş versiyon)
import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const app = express();
const upload = multer({ dest: "/tmp/uploads" }); // Özel bir alt klasör
const PORT = process.env.PORT || 3000;

// Klasörlerin varlığından emin olalım
if (!fs.existsSync("/tmp/uploads")) fs.mkdirSync("/tmp/uploads", { recursive: true });

app.get("/", (req, res) => {
  res.send("✅ ToMeta OCR Server is running - Optimized Version");
});

app.post("/ocr", upload.single("file"), async (req, res) => {
  let tempFiles = []; // İşlem bitince temizlemek için
  
  try {
    if (!req.file) return res.status(400).json({ error: "PDF missing" });

    const pdfPath = req.file.path;
    const timestamp = Date.now();
    const rawImgPrefix = `/tmp/raw_${timestamp}`;
    const textOutputBase = `/tmp/result_${timestamp}`;
    
    tempFiles.push(pdfPath);

    // 1️⃣ PDF → PNG (DPI 300)
    console.log("Converting PDF to Image...");
    await execPromise(`pdftoppm -png -r 300 ${pdfPath} ${rawImgPrefix}`);

    // Oluşan dosyaları bul
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith(`raw_${timestamp}-`) && f.endsWith(".png"));
    
    if (files.length === 0) throw new Error("PDF conversion failed: No images produced.");

    // 2️⃣ Görsel Optimizasyon
    console.log("Optimizing images...");
    const optimizedImages = [];
    for (const file of files) {
      const inputPath = path.join("/tmp", file);
      const outputPath = path.join("/tmp", `opt_${file}`);
      
      await sharp(inputPath)
        .grayscale()
        .normalize()
        .sharpen()
        .toFile(outputPath);
      
      optimizedImages.push(outputPath);
      tempFiles.push(inputPath, outputPath);
    }

    // 3️⃣ OCR İşlemi (Gelişmiş Parametreler)
    console.log("Starting Tesseract...");
    // Not: Tesseract wildcards (*.png) bazen shell'e göre hata verebilir, 
    // Bu yüzden ilk sayfayı veya tüm listeyi veriyoruz.
    const ocrCmd = `tesseract /tmp/opt_raw_${timestamp}-*.png ${textOutputBase} -l tur+eng --oem 3 --psm 6`;
    await execPromise(ocrCmd);

    const text = fs.readFileSync(`${textOutputBase}.txt`, "utf8");
    tempFiles.push(`${textOutputBase}.txt`);

    // Başarılı yanıt
    res.json({ status: "ok", text });

    // Temizlik (Arka planda silebiliriz)
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

  } catch (err) {
    console.error("CRITICAL OCR ERROR:", err.message);
    res.status(500).json({ error: "OCR failed", details: err.message });
  }
});

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`Exec Error: ${stderr}`);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
