FROM node:20-alpine

WORKDIR /app

# Install deps first (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source
COPY . .

# Railway sets PORT automatically; expose default for clarity
ENV NODE_ENV=production
EXPOSE 3000

# Χρήση του σωστού entry point (src/server.js).
# Το v2 είχε πάθει bug με λάθος path εδώ - προσοχή.
CMD ["node", "src/server.js"]
