import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun } from "docx"; // Aşama 3 Paketleri

const app = express();
const upload = multer({ dest: "/tmp/uploads" });
const PORT = process.env.PORT || 3000;

// Gerekli klasörlerin varlığından emin olalım
const dirs = ["/tmp/uploads", "/tmp/output"];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.get("/", (req, res) => {
    res.send("✅ ToMeta OCR & DOCX Server is running - Phase 3 Stable");
});

/**
 * AŞAMA 2 & 3: PDF -> IMAGE -> OCR -> DOCX
 */
app.post("/ocr", upload.single("file"), async (req, res) => {
    let tempFiles = [];
    
    try {
        if (!req.file) return res.status(400).json({ error: "PDF missing" });

        const pdfPath = req.file.path;
        const timestamp = Date.now();
        const rawImgPrefix = `/tmp/raw_${timestamp}`;
        const textOutputBase = `/tmp/result_${timestamp}`;
        const docxFilename = `ToMeta_OCR_${timestamp}.docx`;
        const docxPath = `/tmp/output/${docxFilename}`;
        
        tempFiles.push(pdfPath);

        // 1️⃣ PDF → PNG (DPI 300)
        console.log("1. Converting PDF to Image...");
        await execPromise(`pdftoppm -png -r 300 ${pdfPath} ${rawImgPrefix}`);

        // Oluşan sayfaları yakala
        const files = fs.readdirSync("/tmp").filter(f => f.startsWith(`raw_${timestamp}-`) && f.endsWith(".png")).sort();
        if (files.length === 0) throw new Error("PDF could not be converted to images.");

        // 2️⃣ GÖRÜNTÜ OPTİMİZASYONU (Sharp)
        console.log("2. Optimizing images for OCR...");
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

        // 3️⃣ OCR İŞLEMİ (Tesseract)
        console.log("3. Starting Tesseract OCR...");
        const ocrCmd = `tesseract /tmp/opt_raw_${timestamp}-*.png ${textOutputBase} -l tur+eng --oem 3 --psm 6`;
        await execPromise(ocrCmd);
        
        const rawText = fs.readFileSync(`${textOutputBase}.txt`, "utf8");
        tempFiles.push(`${textOutputBase}.txt`);

        // 4️⃣ DOCX ÜRETİMİ (Aşama 3)
        console.log("4. Generating DOCX file...");
        const paragraphs = rawText.split("\n").map(line => {
            return new Paragraph({
                children: [new TextRun({ text: line.trim(), size: 24, font: "Calibri" })]
            });
        });

        const doc = new Document({
            sections: [{ children: paragraphs }]
        });

        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(docxPath, buffer);

        // 5️⃣ YANIT GÖNDERME
        res.json({
            status: "ok",
            text: rawText,
            docxUrl: `${req.protocol}://${req.get('host')}/download/${docxFilename}`
        });

        // Arka planda geçici resim ve txt dosyalarını temizle
        setTimeout(() => {
            tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        }, 5000);

    } catch (err) {
        console.error("OCR/DOCX Error:", err.message);
        res.status(500).json({ error: "Process failed", details: err.message });
    }
});

/**
 * DOSYA İNDİRME ENDPOINT'İ
 */
app.get("/download/:filename", (req, res) => {
    const filePath = path.join("/tmp/output", req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
        // İndirildikten 1 dakika sonra dosyayı sunucudan sil (Disk dolmasın)
        setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 60000);
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

app.listen(PORT, () => console.log(`🚀 ToMeta Server is live on port ${PORT}`));
