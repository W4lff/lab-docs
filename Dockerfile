FROM node:20-alpine
WORKDIR /app
# Patches de OS (ex: OpenSSL) que a tag da imagem base ainda não pegou.
RUN apk update && apk upgrade --no-cache
COPY package.json ./
RUN npm install --omit=dev \
    # O npm global embutido na imagem base carrega node_modules próprio
    # (glob/minimatch/tar/sigstore etc) só usado em build-time — nada
    # disso é necessário em runtime (só `node`, nunca `npm`), e é onde o
    # scan de vulnerabilidade da imagem sempre acha CVE.
    && rm -rf /usr/local/lib/node_modules/npm
COPY src/ ./src/
COPY content/ ./content/
COPY site/ ./site/
EXPOSE 8090
CMD ["node", "-r", "./src/tracing.js", "src/index.js"]
