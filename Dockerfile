FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
