FROM node:22-bookworm

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala os navegadores em caminho compartilhado para que o usuário
# não-root consiga acessá-los em tempo de execução.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN npx playwright install --with-deps chromium

COPY . .

# Usuário não-root + diretórios graváveis (data e perfis do navegador).
# Os dois precisam existir na imagem com dono uid 1001 para que volumes
# nomeados novos herdem a posse correta e o Playwright consiga gravar.
RUN useradd -m -u 1001 appuser \
 && mkdir -p /app/data /app/minimax_profiles \
 && chown -R appuser:appuser /app \
 && chmod -R a+rx /ms-playwright

USER appuser

VOLUME ["/app/data", "/app/minimax_profiles"]

EXPOSE 3003
ENV NODE_ENV=production PORT=3003

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
