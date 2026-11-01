# Node 26 = trenutni LTS (podrška do aprila 2029). apk upgrade povuče sigurnosne zakrpe za Alpine.
FROM node:26-alpine
RUN apk upgrade --no-cache

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

# Server nema vanjskih npm paketa, pa nema ni "npm install".
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "--no-warnings", "src/index.js"]
