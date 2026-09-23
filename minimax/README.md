# MinimaxProxy

Proxy API local compatível com OpenAI que roteia requisições para os modelos do **Minimax (agent.minimax.io)** via automação de navegador com Playwright. Suporte a múltiplas contas com rotação automática, execução de ferramentas, modo de pensamento (reasoning), persistência de sessão e armazenamento em SQLite.

[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.12-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## ✅ Status: FUNCIONAL (validado E2E 2026-06-07)

Porte do `qwenproxy` para o **MiniMax (`agent.minimax.io`)**. Servidor OpenAI-compatível
na porta **3003**, validado de ponta a ponta (streaming + non-streaming + `/v1/models`),
com `reasoning_content`, `usage` e fechamento automático dos modais.

### Como funciona (arquitetura "bridge")

O `agent.minimax.io` assina cada request com `x-signature` (que **cobre o corpo**) +
`x-timestamp`, calculados por um interceptor do front-end — replicar em Node é inviável.
Então usamos a **bridge** (como o porte `glm/`): o servidor dirige a UI logada via
Playwright (fecha os modais, injeta o prompt, envia) e um hook de `window.fetch` faz o
**tee** do SSE de `/session/<id>/message`, convertendo para o formato OpenAI. Detalhes
da API em [`DISCOVERY.md`](DISCOVERY.md).

- **Login**: OAuth2 (Ory) com captcha → manual, **uma vez**: `npm run login:manual`
  (persiste a sessão em `minimax_profiles/_default`).
- **Modelos**: MiniMax-M3 (450k), MiniMax-M2.7 (200k), MiniMax-M2.7-highspeed. O modelo
  efetivo é o selecionado na UI (a assinatura cobre o corpo), então o parâmetro `model`
  da API é informativo por enquanto.
- **Headless**: o perfil `_default` precisa estar logado. Validado com `HEADLESS=false`;
  para servidor/Docker, validar headless (a sessão persiste no perfil).

### Como rodar

```bash
cd minimax
npm install                 # já feito
npm run login:manual        # logue na sua conta MiniMax uma vez (janela headed)
HEADLESS=false npm start    # sobe o proxy na porta 3003
# teste:
curl -s http://localhost:3003/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"oi"}],"stream":true}'
```

Ferramentas auxiliares: `npm run discover` (recon da API), `npm run session:export`.

---

## Features

- **OpenAI API Compatible** — Interface compatível com `/v1/chat/completions` e `/v1/models`.
- **Multi-Account** — Gerencie múltiplas contas Minimax com rotação round-robin e cooldown automático.
- **SQLite Storage** — Contas salvas em banco de dados SQLite (WAL mode) para performance e confiabilidade.
- **Reasoning Support** — Suporte completo ao modo de pensamento (thinking) dos modelos Minimax.
- **Tool Execution** — Sistema de execução de ferramentas locais integrado ao fluxo do chat.
- **Session Persistence** — Perfil de navegador persistente por conta em `minimax_profiles/`.
- **Auto-Login** — Login automático via credenciais com recuperação de sessão.
- **Browser Selection** — Escolha entre Chromium, Chrome, Firefox, Edge ou WebKit.
- **Monitoring** — Health check, métricas Prometheus e watchdog integrados.
- **Docker Ready** — Deploy para VPS com Docker, volumes persistentes e graceful shutdown.

---

## Arquitetura

```mermaid
graph TD
    Client[Cliente OpenAI/SDK] -->|HTTP| Proxy[MinimaxProxy - Hono]
    Proxy -->|/v1/chat/completions| Handler[Chat Handler]
    Proxy -->|/v1/models| Models[Models API]
    Handler --> AccountMgr[Account Manager]
    AccountMgr -->|Round-Robin| Accounts[(SQLite)]
    AccountMgr --> Playwright[Playwright Service]
    Playwright --> Browser1[Browser - Conta 1]
    Playwright --> Browser2[Browser - Conta 2]
    Playwright --> BrowserN[Browser - Conta N]
    Handler --> MinimaxAPI[agent.minimax.io]
    Handler --> Tools[Tool Executor]

    subgraph "Persistência"
        Accounts
        Profiles[minimax_profiles/]
    end
```

---

## Pré-requisitos

| Dependência | Versão Mínima | Instalação |
|------------|--------------|-----------|
| Node.js | v20.x | [nvm](https://github.com/nvm-sh/nvm) |
| npm | v9.x | Incluído com Node.js |
| Playwright | - | `npx playwright install` |
| Docker (opcional) | v24.x | [Docker Docs](https://docs.docker.com/get-docker/) |

---

## Instalação

### Via npm

```bash
git clone https://github.com/mfelipedias/proxies-llm-openai.git
cd proxies-llm-openai/minimax
npm install
npx playwright install
```

### Via Docker

```bash
docker-compose up -d
```

---

## Configuração

Crie o arquivo `.env` na raiz do projeto (veja `.env.example`):

```env
# Porta do servidor (default: 3000)
PORT=3000

# Chave de API para proteger os endpoints (opcional)
API_KEY=sua-chave-secreta-aqui

# Credenciais Minimax para login automático (modo single-account)
MINIMAX_EMAIL=seu-email@exemplo.com
MINIMAX_PASSWORD=sua-senha-aqui

# Navegador (chromium, firefox, chrome, edge)
BROWSER=chromium
```

---

## Gerenciamento de Contas

As contas são armazenadas em SQLite (`data/minimaxproxy.db`). Use o CLI interativo para gerenciar:

```bash
# Abrir o gerenciador de contas
npm run login

# Com navegador específico
npm run login:firefox
npm run login:chrome
npm run login:edge
```

O menu interativo permite:
- **[A]** Adicionar conta com credenciais (email + senha)
- **[M]** Adicionar conta via login manual no navegador
- **[R]** Remover uma conta
- **[L]** Login em todas as contas (inicializar sessões)

> Na primeira execução, se existir um `accounts.json` antigo, as contas serão migradas automaticamente para SQLite.

---

## Uso

### Iniciar o servidor

```bash
npm start                  # Chromium (padrão)
npm run start:chrome       # Google Chrome
npm run start:firefox      # Firefox
npm run start:edge         # Microsoft Edge
```

O servidor inicia em `http://localhost:3000` com as seguintes rotas:

| Rota | Método | Descrição |
|------|--------|-----------|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/chat/completions/stop` | POST | Abortar uma geração ativa |
| `/v1/models` | GET | Listar modelos disponíveis |
| `/v1/models/:model` | GET | Informações de um modelo específico |
| `/health` | GET | Health check com status do sistema |
| `/metrics` | GET | Métricas no formato Prometheus |

---

## Exemplos de Integração

### OpenAI SDK (Node.js)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.API_KEY || 'sk-no-key-required'
});

const completion = await openai.chat.completions.create({
  model: 'minimax-plus',
  messages: [{ role: 'user', content: 'Explique como funciona o Playwright.' }]
});

console.log(completion.choices[0].message.content);
```

### cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave" \
  -d '{
    "model": "minimax-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## Deploy com Docker

### docker-compose.yml

```yaml
services:
  minimaxproxy:
    build: .
    container_name: minimaxproxy
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data               # Banco SQLite
      - ./minimax_profiles:/app/minimax_profiles  # Sessões dos navegadores
    restart: unless-stopped
```

### Volumes persistentes

| Volume | Conteúdo |
|--------|----------|
| `./data` | Banco SQLite com as contas (`minimaxproxy.db`) |
| `./minimax_profiles` | Perfis de navegador por conta (cookies, sessões) |

---

## Estrutura do Projeto

```
minimaxproxy/
├── src/
│   ├── index.ts                 # Entry point
│   ├── login.ts                 # CLI de gerenciamento de contas
│   ├── api/
│   │   ├── server.ts            # Servidor Hono + startup
│   │   └── models.ts            # Endpoints /v1/models
│   ├── routes/
│   │   └── chat.ts              # Handler /v1/chat/completions
│   ├── services/
│   │   ├── playwright.ts        # Automação de navegador
│   │   └── minimax.ts              # Integração com API do Minimax
│   ├── core/
│   │   ├── accounts.ts          # CRUD de contas (SQLite)
│   │   ├── account-manager.ts   # Rotação round-robin + cooldowns
│   │   ├── database.ts          # Conexão e migrations SQLite
│   │   ├── config.ts            # Configuração com Zod
│   │   ├── logger.ts            # Logger estruturado
│   │   ├── metrics.ts           # Coleta de métricas
│   │   ├── model-registry.ts    # Registro de modelos e context windows
│   │   ├── stream-registry.ts   # Tracking de streams ativos
│   │   └── watchdog.ts          # Health monitoring
│   ├── cache/
│   │   └── memory-cache.ts      # Cache em memória com TTL
│   ├── tools/
│   │   ├── executor.ts          # Execução de ferramentas
│   │   ├── registry.ts          # Registro de tools
│   │   ├── parser.ts            # Parser de <tool_call> tags
│   │   ├── schema.ts            # Validação JSON Schema
│   │   └── types.ts             # Tipos do sistema de tools
│   ├── utils/
│   │   ├── json.ts              # Parser JSON robusto
│   │   ├── context-truncation.ts # Truncamento de contexto
│   │   └── types.ts             # Re-exports de tipos
│   └── types/
│       └── openai.ts            # Tipos compatíveis com OpenAI
├── data/                        # Banco SQLite (gitignored)
├── minimax_profiles/               # Perfis de navegador por conta (gitignored)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Troubleshooting

| Problema | Solução |
|----------|---------|
| Porta em uso | Altere `PORT` no `.env` ou encerre o processo na porta 3000 |
| Navegador não abre | Execute `npx playwright install` |
| Sessão expirada | Execute `npm run login` para renovar cookies |
| Rate limit em todas as contas | Adicione mais contas via `npm run login` |
| Banco corrompido | Apague `data/minimaxproxy.db` e re-adicione as contas |

---

## Disclaimer

> Este projeto é fornecido estritamente para fins educacionais e de pesquisa.

Os autores não incentivam ou endossam:
- Violação dos Termos de Serviço da plataforma Minimax.
- Automação não autorizada em larga escala.
- Uso para atividades maliciosas.

**Use por sua conta e risco.**
