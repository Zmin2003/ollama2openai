FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV ADMIN_PASSWORD=admin123
ENV OLLAMA_BASE_URL=https://ollama.com/api
ENV HEALTH_CHECK_INTERVAL=60

CMD ["node", "src/app.js"]
