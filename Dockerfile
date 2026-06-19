FROM node:20-alpine

WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding on alpine
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/data

CMD ["node", "src/index.js"]
