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
    if (!req.file) {
      return res.status(400).json({ error: "PDF missing" });
    }

    const pdfPath = req.file.path;
    const imgPrefix = `/tmp/output_${Date.now()}`;
    const textOutput = `${imgPrefix}.txt`;

    // 1️⃣ PDF → PNG
    const pdfToImgCmd = `pdftoppm -png ${pdfPath} ${imgPrefix}`;
    await execPromise(pdfToImgCmd);

    // 2️⃣ OCR (Tesseract tüm sayfalar)
    const ocrCmd = `tesseract ${imgPrefix}-*.png ${imgPrefix} -l tur+eng`;
    await execPromise(ocrCmd);

    const text = fs.readFileSync(textOutput, "utf8");

    res.json({
      status: "ok",
      text
    });

  } catch (err) {
    console.error("OCR error:", err);
    res.status(500).json({ error: "OCR failed" });
  }
});

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.listen(PORT, () => {
  console.log("🚀 ToMeta OCR server running on port", PORT);
});
