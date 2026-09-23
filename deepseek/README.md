# DeepSeekProxy

Proxy API local compatível com OpenAI que roteia requisições para os modelos do
**DeepSeek (chat.deepseek.com)** via automação de navegador com Playwright.
Porte do **QwenProxy**, mantendo multi-conta com rotação, execução de
ferramentas, modo de pensamento (R1), persistência de sessão e SQLite.

> ✅ **Estado: funcionando.** `/v1/chat/completions` responde com modelos reais
> do DeepSeek (streaming + não-streaming, `content` + `reasoning_content` do R1 +
> `usage` + tool-calling). PoW resolvido via WASM oficial; login por sessão
> persistida. Suíte de testes verde. Detalhes em **[PLAN.md](PLAN.md)**.

---

## Diferença central vs. Qwen

O Qwen usa headers anti-bot (`bx-ua`/`bx-umidtoken`) **cacheáveis**. O DeepSeek
usa um **Proof-of-Work (PoW) por requisição** (`x-ds-pow-response`) e
autenticação por **Bearer token**. Toda a lógica de PoW está isolada em
[`src/services/pow.ts`](src/services/pow.ts). Detalhes em [PLAN.md](PLAN.md).

---

## Pré-requisitos

| Dependência | Versão Mínima |
|------------|--------------|
| Node.js | v20.x |
| Playwright | `npx playwright install` |
| Docker (opcional) | v24.x |

---

## Instalação

```bash
cd deepseek
npm install            # (ou use o node_modules symlinkado do projeto pai)
npx playwright install
cp .env.example .env   # preencher credenciais
```

### `.env`

```env
PORT=3001
API_KEY=sua-chave-secreta            # opcional, protege os endpoints
DEEPSEEK_EMAIL=seu-email@exemplo.com
DEEPSEEK_PASSWORD=sua-senha
BROWSER=chromium
```

---

## Uso

```bash
# 1º login: navegador headful (passa pelo AWS WAF) e persiste a sessão
HEADLESS=false npm run login     # ou: HEADLESS=false npx tsx src/validate.ts
npm start                        # servidor headless reusa a sessão (porta 3001)
npm test                         # 24 testes
npm run typecheck
```

> O primeiro login precisa de navegador "de cabeça" (headful) por causa do AWS
> WAF; depois a sessão fica salva em `deepseek_profiles/` e o servidor roda
> headless. No Docker isso é automático via Xvfb (ver seção Docker).

| Rota | Método | Descrição |
|------|--------|-----------|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/chat/completions/stop` | POST | Abortar geração ativa |
| `/v1/models` | GET | `deepseek-chat`, `deepseek-reasoner` |
| `/health` | GET | Health check |
| `/metrics` | GET | Métricas Prometheus |

### Exemplo (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: process.env.API_KEY || 'sk-no-key-required'
});

const completion = await openai.chat.completions.create({
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'Explique o que é Proof-of-Work.' }]
});
```

---

## Docker (turnkey)

```bash
docker compose up --build -d
```

Funciona **out-of-the-box**:
- Login do 1º acesso roda dentro do container (**Chromium headful sob Xvfb** —
  passa pelo AWS WAF sem tela real).
- Se o DB estiver vazio mas houver `DEEPSEEK_EMAIL`/`DEEPSEEK_PASSWORD` no `.env`,
  a conta é **cadastrada automaticamente** no startup (sem `npm run login`).
- Persistência em **volumes nomeados** (`ds_data`, `ds_profiles`) — evita o erro
  de *File Sharing* do Docker Desktop no macOS.

| Volume | Conteúdo |
|--------|----------|
| `ds_data` | SQLite (`deepseekproxy.db`) |
| `ds_profiles` | Perfis de navegador / sessão |

> Para usar pastas do host (bind mounts) em vez de volumes nomeados, edite o
> `docker-compose.yml` e habilite o path em Docker Desktop → Settings →
> Resources → File Sharing.

---

## Disclaimer

Projeto para fins **educacionais e de pesquisa**. Respeite os Termos de Serviço
do DeepSeek. Use por sua conta e risco.
