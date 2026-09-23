# proxies-llm-openai

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)

Proxies locais que expõem os chats web do **Qwen**, **DeepSeek**, **GLM (z.ai)** e **MiniMax** por meio de uma **API compatível com a OpenAI**. Com eles, a conta pessoal de cada plataforma pode ser usada a partir de qualquer SDK ou ferramenta que fale o protocolo OpenAI, como os SDKs de Python e Node, o Open WebUI ou o opencode.

> **Projeto não oficial.** Não há vínculo com Alibaba (Qwen), DeepSeek, Zhipu (z.ai), MiniMax, Moonshot ou Mistral. Os proxies automatizam a interface web dessas plataformas, que pode mudar a qualquer momento. Leia os [avisos](#avisos) antes de usar.

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Aplicação  │ ───▶ │  Proxy (Node +   │ ───▶ │  Chat web oficial   │
│  OpenAI SDK │ ◀─── │  Playwright)     │ ◀─── │  (sessão logada)    │
└─────────────┘      └──────────────────┘      └─────────────────────┘
   localhost:300x      navegador headless          qwen / deepseek
                       com a sessão salva          z.ai / minimax
```

## Sumário

- [Proxies disponíveis](#proxies-disponíveis)
- [Início rápido](#início-rápido)
- [Configuração por proxy](#configuração-por-proxy)
  - [Qwen](#qwen)
  - [DeepSeek](#deepseek)
  - [GLM (z.ai)](#glm-zai)
  - [MiniMax](#minimax)
- [Open WebUI](#open-webui)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Múltiplas contas e rate limit](#múltiplas-contas-e-rate-limit)
- [Solução de problemas](#solução-de-problemas)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Roadmap](#roadmap)
- [Avisos](#avisos)
- [Segurança dos dados](#segurança-dos-dados)
- [Créditos e licença](#créditos-e-licença)

## Proxies disponíveis

| Proxy | Porta | Plataforma | Modelos principais | Setup |
|-------|:-----:|------------|--------------------|-------|
| [qwen](qwen/) | `3000` | chat.qwen.ai | `qwen-max`, `qwen-plus`, `qwen-turbo`, `qwen-long` (1M de contexto), `qwen-coder` | Automático |
| [deepseek](deepseek/) | `3001` | chat.deepseek.com | `deepseek-chat`, `deepseek-reasoner` (R1) | Navegador visível no 1º login |
| [glm](glm/) | `3002` | chat.z.ai | `glm-4.6` (200K de contexto), `glm-4.5`, `glm-4.5-air` | CAPTCHA uma única vez |
| [minimax](minimax/) | `3003` | agent.minimax.io | `MiniMax-M3` (450K de contexto), `MiniMax-M2.7` | Login manual |

Todos compartilham a mesma arquitetura (Hono, Playwright e SQLite) e expõem os mesmos endpoints:

| Endpoint | Descrição |
|----------|-----------|
| `POST /v1/chat/completions` | Chat completion com streaming (SSE) ou sem, incluindo tool calling |
| `POST /v1/chat/completions/stop` | Interrompe uma geração em andamento |
| `GET /v1/models` | Lista os modelos disponíveis |
| `GET /health` | Estado do navegador, do login e dos cooldowns de cada conta |
| `GET /metrics` | Métricas no formato Prometheus |

Todo modelo com raciocínio (reasoning) tem uma variante com o sufixo `-no-thinking`, por exemplo `qwen-plus-no-thinking` ou `MiniMax-M3-no-thinking`. Ela usa o mesmo modelo com o raciocínio desligado.

## Início rápido

**Requisitos:** Node.js 20 ou superior e npm. Docker é opcional; cada proxy traz o seu `docker-compose.yml`.

```bash
git clone https://github.com/mfelipedias/proxies-llm-openai.git
cd proxies-llm-openai/<proxy>   # qwen | deepseek | glm | minimax
npm install
npx playwright install          # instala os navegadores do Playwright
cp .env.example .env
# configure a conta conforme a seção do proxy escolhido
npm start
```

Teste com `curl`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"Olá!"}]}'
```

Ou com o SDK oficial da OpenAI:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-no-key")
resp = client.chat.completions.create(
    model="qwen-plus",
    messages=[{"role": "user", "content": "Olá!"}],
)
print(resp.choices[0].message.content)
```

## Configuração por proxy

O processo de login varia conforme as proteções de cada plataforma:

| Proxy | Login automático (e-mail/senha) | Navegador visível no 1º login | CAPTCHA | Sessão exportável para Docker |
|-------|:---:|:---:|:---:|:---:|
| qwen | Sim | Não | Somente se a plataforma exigir | Não se aplica (perfil persistente) |
| deepseek | Sim | Sim (AWS WAF) | Não | Não se aplica (login via Xvfb no container) |
| glm | Parcial | Sim | Uma vez | `glm_session.json` |
| minimax | Não | Sim | Sim (OAuth + CAPTCHA) | `minimax_session.json` |

### Qwen

Porta `3000`. Aceita login automático com e-mail e senha, inclusive em modo headless, e normalmente não exige intervenção manual.

**Menu interativo** (recomendado para várias contas):

```bash
cd qwen
npm run login
```

```
[A] Add account (with credentials)
[M] Add account (manual browser login)
[R] Remove an account
[L] Login all accounts
[Q] Quit
```

Fluxo típico: `[A]` para cada conta, depois `[L]` para autenticar todas.

**Via `.env`:**

```env
QWEN_EMAIL=seu-email@exemplo.com
QWEN_PASSWORD=sua-senha

# Contas adicionais: numere o sufixo (acc2, acc3, ...)
QWEN_EMAIL2=outra-conta@exemplo.com
QWEN_PASSWORD2=outra-senha
```

Na primeira execução com o banco vazio, as contas do `.env` são cadastradas com ids fixos (`acc1`, `acc2`, ...) e autenticadas automaticamente. Recomenda-se manter ao menos duas contas, para que o proxy tenha para onde rotacionar caso uma delas seja bloqueada pelo anti-bot.

**Armazenamento:** contas em `data/qwenproxy.db`; sessões em `qwen_profiles/<account-id>/` (perfil persistente do Chromium).

**Observações:**

- Rotação round-robin entre contas. Uma conta que atinge o rate limit entra em cooldown de 3 minutos (ou pelo tempo informado pela plataforma).
- Cada conta processa uma requisição por vez; mais contas significam mais paralelismo.
- Quando surge um CAPTCHA, o proxy rotaciona imediatamente para outra conta. Para liberar a conta afetada, resolva o desafio uma vez com o navegador visível: `npx tsx relogin.ts acc1 --browser=chrome` (ou a opção `[M]` do menu).
- `qwen-long` oferece contexto de 1 milhão de tokens.

### DeepSeek

Porta `3001`. O chat.deepseek.com fica atrás de um AWS WAF que bloqueia navegadores headless no login. Cada requisição também exige um Proof-of-Work, resolvido automaticamente pelo proxy com o WASM oficial da plataforma.

**Execução local:** o primeiro login precisa de janela visível.

```bash
cd deepseek
HEADLESS=false npm run login   # [A] para adicionar a conta, [L] para autenticar
npm start                      # depois disso, roda em modo headless
```

**Execução via Docker:** o container usa Xvfb (display virtual), então o login é totalmente automático. Basta preencher o `.env`:

```env
DEEPSEEK_EMAIL=seu-email@exemplo.com
DEEPSEEK_PASSWORD=sua-senha
```

```bash
docker compose up --build -d
```

**Armazenamento:** contas em `data/deepseekproxy.db`; cookies e token (incluindo o do WAF) em `deepseek_profiles/<account-id>/`.

**Observações:**

- Modelos fixos: `deepseek-chat` e `deepseek-reasoner` (R1, com `reasoning_content`), ambos com 64K de contexto.
- Tokens expirados são renovados automaticamente; com credenciais no `.env`, o proxy refaz o login quando necessário.
- Se o WAF bloquear mesmo em modo visível, aguarde alguns minutos ou use outro navegador (`npm run login:firefox`).
- O rate limit do DeepSeek pode durar horas; o proxy respeita o tempo informado e rotaciona para outra conta.

### GLM (z.ai)

Porta `3002`. O z.ai protege o login com CAPTCHA e assina cada requisição com um `x-signature` ofuscado, que muda a cada deploy do frontend. Por isso o proxy opera como **bridge**: o Playwright envia o prompt pela interface real e intercepta o stream de resposta. Na prática, basta resolver o CAPTCHA uma única vez.

```bash
cd glm
npm run login          # [A] para cadastrar a conta
npm run login:manual   # resolva o CAPTCHA e aguarde a mensagem "LOGIN OK"
npm start
```

**Deploy headless ou Docker:** como não há tela para o CAPTCHA, exporte a sessão já autenticada e copie o arquivo para o servidor.

```bash
npm run session:export   # gera glm_session.json (token + cookies)
docker compose up -d
```

O `glm_session.json` é portável entre máquinas e o token não expira.

**Armazenamento:** contas em `data/glmproxy.db`; sessões em `glm_profiles/<account-id>/` e `glm_session.json`.

**Observações:**

- Sem contas configuradas, o proxy funciona em modo convidado, com rate limit bem mais restritivo.
- A lista de modelos vem da própria plataforma e reflete o que a conta tem acesso.
- Se a sessão expirar ou o stream não iniciar, repita `npm run login:manual` e exporte a sessão novamente.

### MiniMax

Porta `3003`. O agent.minimax.io usa OAuth2 (Ory) com CAPTCHA e assina o corpo de cada requisição no frontend. Assim como no GLM, o proxy opera como bridge sobre a interface real. **Não há login por credenciais**: as variáveis `MINIMAX_EMAIL` e `MINIMAX_PASSWORD` são ignoradas.

```bash
cd minimax
npm run login:manual   # faça login no navegador e resolva o CAPTCHA
npm start
```

**Deploy headless ou Docker:**

```bash
npm run session:export   # gera minimax_session.json (cookies + localStorage)
docker compose up -d
```

**Armazenamento:** contas em `data/minimaxproxy.db`; perfis em `minimax_profiles/`; sessão exportada em `minimax_session.json` (o JWT expira; quando isso ocorrer, repita o login manual e a exportação).

**Observações:**

- O modelo efetivamente usado é o selecionado na interface do MiniMax. O campo `model` da requisição serve para listagem e cálculo de contexto, pois a assinatura cobre o corpo da requisição.
- Tool calling com parser multiformato (`<tool_call>`, `<minimax:tool_call>` etc.). As instruções de ferramentas são injetadas como último turno de usuário, já que a plataforma descarta system prompts.
- `MiniMax-M3` usa raciocínio por padrão; use `MiniMax-M3-no-thinking` para desativá-lo.
- A bridge fecha popups da interface automaticamente e tem watchdog de stream (60 s para o primeiro chunk, 120 s entre chunks).

## Open WebUI

O `docker-compose.yml` da raiz sobe um [Open WebUI](https://github.com/open-webui/open-webui) já configurado com os quatro proxies:

```bash
# 1. Suba os proxies desejados, cada um no seu diretório
(cd qwen && docker compose up -d)

# 2. Suba o Open WebUI a partir da raiz do repositório
docker compose up -d
```

Acesse `http://localhost:2999`; o primeiro usuário cadastrado torna-se administrador. Os modelos de cada proxy aparecem automaticamente. Busca web (DuckDuckGo), code interpreter (Pyodide) e upload de documentos (RAG) já vêm habilitados.

URLs e chaves podem ser ajustadas no `.env` da raiz (veja `.env.example`). Defina `WEBUI_SECRET_KEY` para manter as sessões do Open WebUI entre reinicializações.

## Variáveis de ambiente

Cada proxy tem o seu `.env` (baseado em `.env.example`). As principais variáveis:

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3000`–`3003` | Porta do proxy |
| `API_KEY` | vazio | Quando definida, exige `Authorization: Bearer <key>` nos endpoints `/v1/*` |
| `HEADLESS` | `true` | `false` abre o navegador visível (necessário no primeiro login e útil para depuração) |
| `BROWSER` | `chromium` | `chromium`, `firefox`, `chrome` ou `edge` |
| `<NOME>_EMAIL` / `<NOME>_PASSWORD` | vazio | Credenciais para login automático (qwen e deepseek) |
| `USER_DATA_DIR` | `./<nome>_profiles` | Diretório dos perfis de navegador |
| `CHAT_TIMEOUT` | `120000` | Timeout de um completion, em ms |
| `LOG_CONSOLE` | `false` | Registra o console do navegador |

Timeouts de stream, watchdog e limites de memória também são configuráveis; consulte o `.env.example` de cada proxy.

## Múltiplas contas e rate limit

Todos os proxies suportam várias contas com rotação automática:

1. Adicione contas pelo menu (`npm run login`, opção `[A]` ou `[M]`).
2. As requisições são distribuídas em round-robin.
3. Contas que atingem o rate limit entram em cooldown e são ignoradas até se recuperarem.
4. Cada conta processa uma requisição por vez.

O estado atual pode ser consultado em `GET /health`, que informa o login de cada conta e os cooldowns ativos com o tempo restante.

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---------|----------------|---------|
| `401` ou `loggedIn: false` no `/health` | Sessão expirada | `npm run login` e `[L]` (qwen, deepseek); `npm run login:manual` e `session:export` (glm, minimax) |
| Todas as requisições retornam rate limit | Todas as contas em cooldown | Aguarde (veja `remainingMs` no `/health`) ou adicione contas |
| `Browser is not available` | Navegadores do Playwright ausentes | `npx playwright install --with-deps` |
| `profile appears to be in use` / `SingletonLock` | Lock órfão após falha | O proxy remove automaticamente; manualmente, apague `<nome>_profiles/<id>/SingletonLock` |
| Stream interrompido no meio | Travamento no upstream | O watchdog aborta a requisição; aumente `STREAM_*_TIMEOUT` em redes lentas |
| `database disk image is malformed` | Banco SQLite corrompido | Apague `data/<nome>proxy.db` e cadastre as contas novamente |
| Porta em uso | Outro processo na porta | `lsof -i :3000` (Linux/macOS) ou `netstat -ano \| findstr :3000` (Windows); ou altere `PORT` |
| Docker do glm/minimax sem login | Arquivo de sessão ausente | Gere com `npm run session:export` e copie o `*_session.json` para o servidor via `scp`/`rsync` |

Para depuração detalhada, rode com o navegador visível e o console da página:

```bash
HEADLESS=false LOG_CONSOLE=true npm start
```

## Estrutura do repositório

```
proxies-llm-openai/
├── docker-compose.yml   # Open WebUI (porta 2999) conectado aos proxies
├── .env.example         # Configuração opcional do Open WebUI
├── qwen/                # Proxy Qwen      (porta 3000)
├── deepseek/            # Proxy DeepSeek  (porta 3001)
├── glm/                 # Proxy GLM       (porta 3002)
├── minimax/             # Proxy MiniMax   (porta 3003)
├── kimi/                # Em desenvolvimento (porta 3004)
└── mistral/             # Em desenvolvimento (porta 3005)
```

Cada proxy é um projeto Node independente, com `package.json`, `.env` e `README.md` próprios, este último com detalhes de arquitetura e API.

## Roadmap

| Proxy | Porta | Plataforma | Status |
|-------|:-----:|------------|--------|
| [kimi](kimi/) | `3004` | kimi.com (Moonshot AI) | Estrutura inicial; plano em [kimi/PLAN.md](kimi/PLAN.md) |
| [mistral](mistral/) | `3005` | chat.mistral.ai (Le Chat) | Estrutura inicial; plano em [mistral/PLAN.md](mistral/PLAN.md) |

Cada `PLAN.md` descreve as fases de implementação, começando pelo reconhecimento da plataforma (API direta, como no qwen, ou bridge de interface, como no glm e no minimax). Os stubs já respondem em `/health` com `status: "scaffold"` e retornam `501` nos endpoints de chat.

Modelos open-weight como o Gemma não precisam de proxy: podem rodar localmente com o [Ollama](https://ollama.com), que já oferece uma API compatível com a OpenAI em `http://localhost:11434/v1`.

## Avisos

- Os proxies automatizam contas pessoais nos chats web. Esse uso pode violar os termos de serviço das plataformas e resultar em bloqueio da conta. Use com moderação e por sua conta e risco; para uso comercial, prefira as APIs oficiais.
- Projeto destinado a fins educacionais e uso pessoal, fornecido "como está", sem garantias.
- Não exponha as portas dos proxies à internet sem definir `API_KEY`: por padrão, as requisições não são autenticadas.

## Segurança dos dados

Os arquivos abaixo são gerados durante o uso, contêm credenciais e já estão no `.gitignore` da raiz e de cada proxy:

| Arquivo | Conteúdo |
|---------|----------|
| `.env` | E-mail e senha em texto puro |
| `data/*.db` | Banco de contas, com e-mail e senha em texto puro |
| `*_profiles/` | Perfis de navegador com cookies de sessão |
| `*_session.json` | Token e cookies exportados, com acesso total à conta |
| `recon-*.jsonl`, `discover-*` | Capturas de tráfego com headers e tokens |

Não versione esses arquivos, nem mesmo em repositórios privados. Para transferir uma sessão para outro servidor, copie o arquivo diretamente (`scp`/`rsync`).

## Créditos e licença

A base do proxy Qwen, cuja arquitetura foi reaproveitada nos demais, vem do [qwenproxy](https://github.com/pedrofariasx/qwenproxy), de Pedro Farias, distribuído sob a licença ISC. Os arquivos `LICENSE` originais foram mantidos em cada subprojeto.

As demais contribuições deste repositório são distribuídas sob a licença [ISC](LICENSE).
