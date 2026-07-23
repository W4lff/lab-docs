FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY content/ ./content/
COPY site/ ./site/
EXPOSE 8090
CMD ["node", "-r", "./src/tracing.js", "src/index.js"]
