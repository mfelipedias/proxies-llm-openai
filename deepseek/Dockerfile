FROM node:22-bookworm

# dumb-init = init/reaping; xvfb = display virtual (permite rodar o Chromium
# "headful" sem tela real, o que o AWS WAF do DeepSeek trata com mais leniência).
RUN apt-get update && apt-get install -y dumb-init xvfb && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala os navegadores em caminho compartilhado para que o usuário
# não-root consiga acessá-los em tempo de execução.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN npx playwright install --with-deps chromium

COPY . .

# Usuário não-root + diretórios graváveis (data + perfis do navegador).
# Criar /app/deepseek_profiles aqui garante que o volume nomeado herde o dono
# appuser (senão o volume sobe como root e o app não consegue escrever).
RUN useradd -m -u 1001 appuser \
 && mkdir -p /app/data /app/deepseek_profiles \
 && chown -R appuser:appuser /app \
 && chmod -R a+rx /ms-playwright

USER appuser

VOLUME ["/app/data", "/app/deepseek_profiles"]

EXPOSE 3001
# HEADLESS=false + xvfb-run => Chromium headful num display virtual (passa pelo WAF).
ENV NODE_ENV=production PORT=3001 HEADLESS=false

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x1024x24", "npx", "tsx", "src/index.ts"]
