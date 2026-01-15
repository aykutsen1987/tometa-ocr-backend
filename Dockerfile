# 1. Aşama: Temel İmaj
FROM node:20-slim

# 2. Aşama: Sistem Paketlerini Kur (Hata vermeyen güvenli alan)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-tur \
    tesseract-ocr-eng \
    poppler-utils \
    libvips-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 3. Aşama: Uygulama Kodları
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# 4. Aşama: Başlatma
EXPOSE 3000
CMD ["node", "index.js"]
