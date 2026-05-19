FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY src ./src
COPY migrations ./migrations
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
