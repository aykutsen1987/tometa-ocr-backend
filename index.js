import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({ dest: "/tmp" });
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ ToMeta OCR Server is running");
});

/**
 * POST /ocr
 * form-data:
 *  - file : PDF
 */
app.post("/ocr", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "PDF missing" });

    const pdfPath = req.file.path;
    const timestamp = Date.now();
    const rawImgPrefix = `/tmp/raw_${timestamp}`;
    const processedImgPrefix = `/tmp/proc_${timestamp}`;
    const textOutput = `/tmp/result_${timestamp}`;

    // 1️⃣ PDF → Yüksek Kaliteli PNG (300 DPI)
    // -r 300: Çözünürlüğü 300 DPI yapar (Kritik!)
    const pdfToImgCmd = `pdftoppm -png -r 300 ${pdfPath} ${rawImgPrefix}`;
    await execPromise(pdfToImgCmd);

    // 2️⃣ Görüntü İyileştirme (Sharp ile)
    // Oluşan tüm sayfaları gez ve optimize et
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith(`raw_${timestamp}-`) && f.endsWith(".png"));
    
    for (const file of files) {
      const inputPath = path.join("/tmp", file);
      const outputPath = path.join("/tmp", `optimized_${file}`);
      
      await sharp(inputPath)
        .grayscale()      // Gri tonlama
        .normalize()      // Kontrastı otomatik yayar
        .sharpen()        // Harf kenarlarını keskinleştirir
        .toFile(outputPath);
    }

    // 3️⃣ OCR (Tesseract Gelişmiş Parametreler)
    // -l tur+eng: Çift dil desteği
    // --oem 3: Default + LSTM (en iyisi)
    // --psm 6: Tek bir blok metin olarak oku (Sayfa düzenini korur)
    const ocrCmd = `tesseract /tmp/optimized_raw_${timestamp}-*.png ${textOutput} -l tur+eng --oem 3 --psm 6`;
    await execPromise(ocrCmd);

    const text = fs.readFileSync(`${textOutput}.txt`, "utf8");

    // Temizlik: Geçici dosyaları silebilirsin (opsiyonel)
    
    res.json({
      status: "ok",
      text
    });

  } catch (err) {
    console.error("OCR error:", err);
    res.status(500).json({ error: "OCR failed" });
  }
});
