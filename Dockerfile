FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY src ./src
COPY migrations ./migrations
COPY muestras-pdf ./muestras-pdf
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
