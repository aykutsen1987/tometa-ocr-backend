# tometa-ocr-backend

Taranmış PDF → metin (Tesseract OCR, Türkçe + İngilizce). Dijital metin içeren PDF'lerde OCR atlanır.
Docker ile çalışır (tesseract + poppler gerekir).

## Endpoint'ler
| Yöntem | Yol | Açıklama |
|---|---|---|
| GET | `/health` | Sağlık kontrolü |
| POST | `/ocr` | `file` (PDF) + `target` (`txt`/`docx`) → dosya |

Hatalar JSON: `401`, `413` (>25 MB), `422` (metin bulunamadı), `500`.

## Ortam değişkenleri (hepsi isteğe bağlı)
`APP_SECRET`, `MAX_PAGES` (30), `OCR_DPI` (200), `OCR_LANGS` (`tur+eng`)

## Yerelde (Docker)
```bash
docker build -t tometa-ocr .
docker run -p 3000:3000 tometa-ocr
```
