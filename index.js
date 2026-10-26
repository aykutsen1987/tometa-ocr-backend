// index.js  — ToMeta OCR sunucusu v2
//
// Düzeltmeler (v1'e göre):
//  • ÇOK SAYFALI TARANMIŞ PDF HATASI: v1, `tesseract sayfa-*.png çıktı` komutuyla tüm sayfaları
//    tek çağrıda veriyordu; Tesseract tek girdi görseli kabul eder, bu yüzden 2+ sayfalı taranmış
//    PDF'ler başarısız oluyordu. Artık her sayfa ayrı işlenir ve birleştirilir.
//  • Bellek: sayfalar tek tek (200 DPI) işlenir ve hemen silinir (Render ücretsiz 512 MB).
//  • Kabuk (shell) yerine execFile: komut enjeksiyonu / glob sorunu yok.
//  • İsteğe bağlı x-app-secret doğrulaması (APP_SECRET ortam değişkeni).
//  • DOCX çıktısı: satır sonu bölünmüş metin paragraflara toplanır.

process.on('uncaughtException', (err) => console.error('Beklenmedik Hata:', err));
process.on('unhandledRejection', (reason) => console.error('Yakalanmamış Rejection:', reason));

import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun } from "docx";
import pdf from "pdf-parse";

const app = express();
const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "30", 10);
const OCR_DPI = parseInt(process.env.OCR_DPI || "200", 10);
const OCR_LANGS = process.env.OCR_LANGS || "tur+eng";

const UPLOAD_DIR = path.join(os.tmpdir(), "tometa_uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

function requireSecret(req, res, next) {
  if (!APP_SECRET) return next();           // ayarlı değilse eski davranış
  if (req.headers["x-app-secret"] !== APP_SECRET) {
    return res.status(401).json({ error: "Yetkisiz erişim." });
  }
  next();
}

app.get("/", (req, res) => res.send("✅ ToMeta Smart OCR & DOCX Server is running"));
app.get("/health", (req, res) => res.json({ status: "ok", service: "tometa-ocr-backend" }));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().slice(0, 400)));
      else resolve(stdout);
    });
  });
}

// ── Metin → paragraflar (OCR satır sonlarını toparlar) ───────────────────────
const BULLET = /^([•●▪◦‣\-–—*]|\d{1,3}[.)])\s+\S/;
const SENTENCE_END = /[.!?:;…"”’)\]]$/;

function toParagraphs(text) {
  const out = [];
  let cur = "";
  let prev = "";
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; prev = ""; };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim().replace(/^\uFEFF/, "");
    if (!line) { flush(); continue; }
    if (!cur) { cur = line; }
    else if (BULLET.test(line) || prev.length < 35 || (SENTENCE_END.test(prev) && prev.length < 70)) {
      flush(); cur = line;
    } else if (/[A-Za-zÇĞİÖŞÜçğıöşü]-$/.test(prev) && /^[a-zçğıöşü]/.test(line)) {
      cur = cur.slice(0, -1) + line;
    } else {
      cur += " " + line;
    }
    prev = line;
  }
  flush();
  return out;
}

async function buildDocx(text) {
  const paragraphs = toParagraphs(text).map(p =>
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: p, size: 22, font: "Calibri" })]
    })
  );
  if (paragraphs.length === 0) paragraphs.push(new Paragraph({ children: [new TextRun("")] }));
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

// ── Sayfa sayfa OCR ──────────────────────────────────────────────────────────
async function ocrPdf(pdfPath, pageCount, tempFiles) {
  const pages = Math.min(pageCount, MAX_PAGES);
  const texts = [];
  const stamp = Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  for (let p = 1; p <= pages; p++) {
    const base = path.join(os.tmpdir(), `pg_${stamp}_${p}`);
    const png = `${base}.png`;
    const opt = `${base}_opt.png`;
    tempFiles.push(png, opt);

    // -singlefile: çıktı tam olarak <base>.png olur (sayfa numarası eki yok)
    await run("pdftoppm", ["-png", "-r", String(OCR_DPI), "-f", String(p), "-l", String(p), "-singlefile", pdfPath, base]);

    let imgForOcr = png;
    try {
      await sharp(png).grayscale().normalize().sharpen().toFile(opt);
      imgForOcr = opt;
    } catch (e) {
      console.warn(`sharp atlandı (sayfa ${p}):`, e.message);
    }

    const pageText = await run("tesseract", [imgForOcr, "stdout", "-l", OCR_LANGS, "--oem", "3", "--psm", "3"]);
    texts.push(pageText.trim());

    for (const f of [png, opt]) { try { fs.unlinkSync(f); } catch (_) {} }   // belleği/diski hemen boşalt
    console.log(`OCR sayfa ${p}/${pages} tamam (${pageText.length} karakter)`);
  }
  return { text: texts.filter(Boolean).join("\n\n"), truncated: pageCount > pages };
}

/**
 * POST /ocr   (multipart)
 *   file   — PDF
 *   target — "txt" | "docx" (varsayılan docx)
 */
app.post("/ocr", requireSecret, upload.single("file"), async (req, res) => {
  const tempFiles = [];
  const target = (req.body?.target || "docx").toLowerCase().trim();

  try {
    if (!req.file) return res.status(400).json({ error: "PDF missing" });
    const pdfPath = req.file.path;
    tempFiles.push(pdfPath);

    // Aşama 1: dijital metin var mı?
    const data = await pdf(fs.readFileSync(pdfPath));
    const pageCount = data.numpages || 1;

    let text;
    let source;
    if (data.text && data.text.trim().length > 20 * pageCount) {
      text = data.text;
      source = "digital";
    } else {
      // Aşama 2: sayfa sayfa OCR
      const r = await ocrPdf(pdfPath, pageCount, tempFiles);
      text = r.text;
      source = "ocr";
      if (r.truncated) console.warn(`PDF ${pageCount} sayfa; yalnızca ilk ${MAX_PAGES} sayfa işlendi`);
    }

    if (!text || !text.trim()) {
      return res.status(422).json({ error: "Metin bulunamadı", message: "Sayfalardan metin okunamadı." });
    }
    console.log(`Kaynak: ${source}, ${text.length} karakter, hedef: ${target}`);

    if (target === "txt") {
      const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, "utf8")]);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="output.txt"');
      return res.send(buf);
    }

    const buffer = await buildDocx(text);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="ToMeta_OCR_${Date.now()}.docx"`);
    return res.send(buffer);

  } catch (err) {
    console.error("Critical Error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Process failed", message: err.message });
  } finally {
    for (const f of tempFiles) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} }
  }
});

// multer / genel hata yakalayıcı
app.use((err, req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Dosya çok büyük (en fazla 25 MB)" });
  }
  console.error("Sunucu hatası:", err);
  res.status(500).json({ error: "Sunucu hatası" });
});

app.listen(PORT, () => console.log(`🚀 ToMeta OCR Server live on port ${PORT}`));
