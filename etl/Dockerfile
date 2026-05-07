FROM node:20-slim

WORKDIR /app

# Install deps first for Docker layer caching
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Cloud Run Jobs execute the CMD and exit
CMD ["node", "index.js"]
