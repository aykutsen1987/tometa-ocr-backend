// index.js en üstüne ekle
process.on('uncaughtException', (err) => {
    console.error('Beklenmedik Hata:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Yakalanmamış Rejection:', reason);
});

import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun } from "docx";
import pdf from "pdf-parse"; // Aşama 4: Dijital metin ayıklama

const app = express();
const upload = multer({ dest: "/tmp/uploads" });
const PORT = process.env.PORT || 3000;

// Gerekli klasörleri oluştur
const dirs = ["/tmp/uploads", "/tmp/output"];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.get("/", (req, res) => {
    res.send("✅ ToMeta Smart OCR & DOCX Server is running - Phase 4");
});

/**
 * YARDIMCI FONKSİYON: DOCX OLUŞTURMA
 */
async function generateDocxFile(text, timestamp) {
    const paragraphs = text.split("\n").map(line => {
        return new Paragraph({
            children: [new TextRun({ text: line.trim(), size: 24, font: "Calibri" })]
        });
    });

    const doc = new Document({
        sections: [{ children: paragraphs }]
    });

    const docxFilename = `ToMeta_OCR_${timestamp}.docx`;
    const docxPath = `/tmp/output/${docxFilename}`;
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(docxPath, buffer);
    return docxFilename;
}

/**
 * ANA ENDPOINT: /ocr
 */
app.post("/ocr", upload.single("file"), async (req, res) => {
    let tempFiles = [];
    const timestamp = Date.now();

    try {
        if (!req.file) return res.status(400).json({ error: "PDF missing" });

        const pdfPath = req.file.path;
        tempFiles.push(pdfPath);

        // --- AŞAMA 4: AKILLI FALLBACK (Dijital Metin Kontrolü) ---
        console.log("Checking for digital text...");
        const dataBuffer = fs.readFileSync(pdfPath);
        const pdfData = await pdf(dataBuffer);

        // Eğer PDF'de anlamlı miktarda metin varsa direkt işle
        if (pdfData.text && pdfData.text.trim().length > 20) {
            console.log("Digital text detected. Skipping OCR...");
            const docxName = await generateDocxFile(pdfData.text, timestamp);
            
            return res.json({
                status: "ok",
                source: "digital",
                text: pdfData.text,
                docxUrl: `${req.protocol}://${req.get('host')}/download/${docxName}`
            });
        }

        // --- AŞAMA 2: OCR SÜRECİ (Eğer metin yoksa buraya geçer) ---
        console.log("No digital text. Starting OCR Pipeline...");
        const rawImgPrefix = `/tmp/raw_${timestamp}`;
        const textOutputBase = `/tmp/result_${timestamp}`;

        // 1. PDF -> PNG (300 DPI)
        await execPromise(`pdftoppm -png -r 300 ${pdfPath} ${rawImgPrefix}`);

        // Sayfaları bul ve sırala
        const files = fs.readdirSync("/tmp")
            .filter(f => f.startsWith(`raw_${timestamp}-`) && f.endsWith(".png"))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        if (files.length === 0) throw new Error("Could not convert PDF to images.");

        // 2. Görüntü İyileştirme (Sharp)
        console.log(`Processing ${files.length} pages...`);
        for (const file of files) {
            const inputPath = path.join("/tmp", file);
            const outputPath = path.join("/tmp", `opt_${file}`);
            
            await sharp(inputPath)
                .grayscale()
                .normalize()
                .sharpen()
                .toFile(outputPath);
            
            tempFiles.push(inputPath, outputPath);
        }

        // 3. Tesseract OCR (Aşama 2.3 Parametreleri)
        console.log("Running Tesseract...");
        const ocrCmd = `tesseract /tmp/opt_raw_${timestamp}-*.png ${textOutputBase} -l tur+eng --oem 3 --psm 6`;
        await execPromise(ocrCmd);
        
        const ocrText = fs.readFileSync(`${textOutputBase}.txt`, "utf8");
        tempFiles.push(`${textOutputBase}.txt`);

        // 4. DOCX Üretimi
        const docxName = await generateDocxFile(ocrText, timestamp);

        // 5. Yanıt
        res.json({
            status: "ok",
            source: "ocr",
            text: ocrText,
            docxUrl: `${req.protocol}://${req.get('host')}/download/${docxName}`
        });

        // Temizlik
        setTimeout(() => {
            tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        }, 10000);

    } catch (err) {
        console.error("Critical Error:", err.message);
        res.status(500).json({ error: "Process failed", details: err.message });
    }
});

/**
 * DOSYA İNDİRME
 */
app.get("/download/:filename", (req, res) => {
    const filePath = path.join("/tmp/output", req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
        // İndirmeden 2 dakika sonra sunucudan kaldır
        setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 120000);
    } else {
        res.status(404).send("File expired or not found.");
    }
});

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
        });
    });
}

app.listen(PORT, () => console.log(`🚀 ToMeta Server live on port ${PORT}`));
