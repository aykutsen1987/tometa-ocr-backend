# Node.js tabanlı resmi imajı kullan
FROM node:20-slim

# Gerekli sistem paketlerini yükle
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-tur \
    tesseract-ocr-eng \
    poppler-utils \
    libvips-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Uygulama klasörünü oluştur
WORKDIR /app

# Bağımlılıkları kopyala ve yükle
COPY package*.json ./
RUN npm install

# Tüm kodları kopyala
COPY . .

# Port ayarı
EXPOSE 3000

# Uygulamayı başlat
CMD ["node", "index.js"]
