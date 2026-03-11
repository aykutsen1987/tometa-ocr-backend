// index.js
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
import pdf from "pdf-parse";

const app = express();
const upload = multer({ dest: "/tmp/uploads" });
const PORT = process.env.PORT || 3000;

// Gerekli klasörleri oluştur
const dirs = ["/tmp/uploads", "/tmp/output"];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.get("/", (req, res) => {
    res.send("✅ ToMeta Smart OCR & DOCX Server is running");
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "tometa-ocr-backend" });
});

/**
 * YARDIMCI: DOCX oluştur
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
 *
 * Parametreler:
 *   file   — PDF dosyası (multipart)
 *   target — "txt" veya "docx" (opsiyonel, varsayılan: "docx")
 */
app.post("/ocr", upload.single("file"), async (req, res) => {
    let tempFiles = [];
    const timestamp = Date.now();

    // target format: txt veya docx (varsayılan: docx)
    const target = (req.body?.target || "docx").toLowerCase().trim();

    try {
        if (!req.file) return res.status(400).json({ error: "PDF missing" });

        const pdfPath = req.file.path;
        tempFiles.push(pdfPath);

        // --- AŞAMA 1: Dijital Metin Kontrolü ---
        console.log("Checking for digital text...");
        const dataBuffer = fs.readFileSync(pdfPath);
        const pdfData = await pdf(dataBuffer);

        let extractedText = "";
        let source = "ocr";

        if (pdfData.text && pdfData.text.trim().length > 20) {
            // PDF zaten metin içeriyor — direkt kullan
            console.log("Digital text detected. Skipping OCR...");
            extractedText = pdfData.text;
            source = "digital";
        } else {
            // --- AŞAMA 2: OCR Pipeline ---
            console.log("No digital text. Starting OCR Pipeline...");
            const rawImgPrefix = `/tmp/raw_${timestamp}`;
            const textOutputBase = `/tmp/result_${timestamp}`;

            // PDF → PNG (300 DPI)
            await execPromise(`pdftoppm -png -r 300 ${pdfPath} ${rawImgPrefix}`);

            // Sayfaları bul
            const files = fs.readdirSync("/tmp")
                .filter(f => f.startsWith(`raw_${timestamp}-`) && f.endsWith(".png"))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            if (files.length === 0) throw new Error("Could not convert PDF to images.");

            // Görüntü iyileştirme
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

            // Tesseract OCR
            console.log("Running Tesseract...");
            const ocrCmd = `tesseract /tmp/opt_raw_${timestamp}-*.png ${textOutputBase} -l tur+eng --oem 3 --psm 6`;
            await execPromise(ocrCmd);

            extractedText = fs.readFileSync(`${textOutputBase}.txt`, "utf8");
            tempFiles.push(`${textOutputBase}.txt`);
        }

        // --- ÇIKTI: target'a göre TXT veya DOCX ---
        if (target === "txt") {
            // Direkt TXT binary olarak döndür (Android dosyaya yazıyor)
            const buf = Buffer.concat([
                Buffer.from([0xEF, 0xBB, 0xBF]),          // UTF-8 BOM
                Buffer.from(extractedText, "utf8")
            ]);
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", "attachment; filename=\"output.txt\"");
            return res.send(buf);
        } else {
            // DOCX döndür
            const docxName = await generateDocxFile(extractedText, timestamp);
            const docxPath = `/tmp/output/${docxName}`;
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            res.setHeader("Content-Disposition", `attachment; filename="${docxName}"`);
            const stream = fs.createReadStream(docxPath);
            stream.pipe(res);
            stream.on("end", () => {
                // Temizlik
                setTimeout(() => {
                    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {} });
                    try { if (fs.existsSync(docxPath)) fs.unlinkSync(docxPath); } catch(_) {}
                }, 10000);
            });
            return;
        }

    } catch (err) {
        console.error("Critical Error:", err.message);
        // Temizlik
        tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {} });
        res.status(500).json({ error: "Process failed", details: err.message });
    }
});

/**
 * DOSYA İNDİRME (opsiyonel, geriye dönük uyumluluk)
 */
app.get("/download/:filename", (req, res) => {
    const filePath = path.join("/tmp/output", req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
        setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(_) {} }, 120000);
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

app.listen(PORT, () => console.log(`🚀 ToMeta OCR Server live on port ${PORT}`));
