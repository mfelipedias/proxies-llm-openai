# 🤖 proxies-llm-openai — Proxies OpenAI-compatible para chats web

Este repositório reúne **4 proxies locais** que expõem os chats web de grandes modelos (Qwen, DeepSeek, GLM e MiniMax) através de uma **API compatível com OpenAI**. Na prática: você usa sua **conta pessoal gratuita** de cada plataforma com qualquer SDK/ferramenta que fale o protocolo OpenAI (Python, Node, Open WebUI, opencode, etc.).

> ⚠️ **Projeto não oficial**, sem qualquer vínculo com Alibaba (Qwen), DeepSeek, Zhipu (z.ai), MiniMax, Moonshot ou Mistral. Ele automatiza a interface web dessas plataformas, que pode mudar a qualquer momento e quebrar o proxy. Leia os [avisos](#️-avisos) antes de usar.

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Seu app /  │ ───▶ │  Proxy (Node +   │ ───▶ │  Chat web oficial   │
│  OpenAI SDK │ ◀─── │  Playwright)     │ ◀─── │  (sessão logada)    │
└─────────────┘      └──────────────────┘      └─────────────────────┘
   localhost:300x      navegador headless          qwen / deepseek
                       com sua sessão              z.ai / minimax
```

## 📦 Visão geral dos proxies

| Proxy | Porta | Plataforma | Modelos principais | Dificuldade de setup |
|-------|:-----:|------------|--------------------|:--------------------:|
| [**qwen**](qwen/) | `3000` | chat.qwen.ai | `qwen-max`, `qwen-plus`, `qwen-turbo`, `qwen-long` (1M ctx), `qwen-coder` | 🟢 Fácil |
| [**deepseek**](deepseek/) | `3001` | chat.deepseek.com | `deepseek-chat`, `deepseek-reasoner` (R1) | 🟡 Média |
| [**glm**](glm/) | `3002` | chat.z.ai | `glm-4.6` (200K ctx), `glm-4.5`, `glm-4.5-air`, e mais | 🟡 Média |
| [**minimax**](minimax/) | `3003` | agent.minimax.io | `MiniMax-M3` (450K ctx), `MiniMax-M2.7` | 🔴 Manual |

Todos seguem a **mesma arquitetura** (Hono + Playwright + SQLite) e expõem os **mesmos endpoints**:

| Endpoint | Descrição |
|----------|-----------|
| `POST /v1/chat/completions` | Chat completion (streaming SSE e não-streaming, com tool calling) |
| `POST /v1/chat/completions/stop` | Aborta uma geração em andamento |
| `GET /v1/models` | Lista os modelos disponíveis |
| `GET /health` | Status do navegador, login e cooldowns das contas |
| `GET /metrics` | Métricas em formato Prometheus |

> 💡 **Sufixo `-no-thinking`**: todo modelo com reasoning ganha uma variante automática, ex. `qwen-plus-no-thinking`, `deepseek-reasoner-no-thinking`, `glm-4.6-no-thinking`, `MiniMax-M3-no-thinking` — usa o mesmo modelo, mas com o "pensamento" desligado.

---

## 🚀 Início rápido (qualquer proxy)

**Requisitos:** Node.js 20+ e npm. Docker é opcional (cada proxy tem seu `docker-compose.yml`).

```bash
git clone https://github.com/mfelipedias/proxies-llm-openai.git
cd proxies-llm-openai/<proxy>   # qwen | deepseek | glm | minimax
npm install
npx playwright install     # instala os navegadores do Playwright
cp .env.example .env       # ajuste se necessário
# ... configure a conta (veja a seção do proxy escolhido!) ...
npm start
```

Teste:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"Olá!"}]}'
```

Ou com o SDK da OpenAI:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-no-key")
resp = client.chat.completions.create(
    model="qwen-plus",
    messages=[{"role": "user", "content": "Olá!"}],
)
print(resp.choices[0].message.content)
```

> ⚠️ **Cada proxy tem sua particularidade de login.** O quadro abaixo resume; os detalhes vêm em seguida.

| | Login por email/senha automático | Precisa de navegador com tela (1ª vez) | Precisa resolver CAPTCHA | Sessão exportável p/ Docker |
|---|:---:|:---:|:---:|:---:|
| **qwen** | ✅ | ❌ | só se a plataforma pedir | — (perfil persistente) |
| **deepseek** | ✅ | ✅ (AWS WAF) | ❌ | — (Docker faz login sozinho via Xvfb) |
| **glm** | parcial | ✅ | ✅ (uma vez) | ✅ `glm_session.json` |
| **minimax** | ❌ (só manual) | ✅ | ✅ (OAuth + captcha) | ✅ `minimax_session.json` |

---

## 🟢 Qwen (porta 3000) — o mais simples

O Qwen aceita **login automático com email e senha**, inclusive em modo headless. É o único que normalmente não exige nenhuma intervenção manual.

### Configurar conta

**Opção A — menu interativo (recomendado, suporta várias contas):**

```bash
cd qwen
npm run login
```

```
[A] Add account (with credentials)   ← digite email + senha
[M] Add account (manual browser login)
[R] Remove an account
[L] Login all accounts               ← autentica todas e salva os cookies
[Q] Quit
```

Fluxo típico: `[A]` para cada conta → `[L]` para logar todas → `Q`.

**Opção B — direto no `.env`:**

```env
QWEN_EMAIL=seu-email@exemplo.com
QWEN_PASSWORD=sua-senha

# Contas extras: numere o sufixo (viram acc2, acc3, ...)
QWEN_EMAIL2=outra-conta@exemplo.com
QWEN_PASSWORD2=outra-senha
```

Na primeira execução do `npm start` com o banco vazio, as contas do `.env` são cadastradas (com ids fixos `acc1`, `acc2`, ...) e logadas automaticamente. Ter **2+ contas** dá ao proxy para onde rotacionar se uma delas cair no anti-bot.

### Onde fica a sessão

- Contas: `data/qwenproxy.db` (SQLite)
- Cookies/sessão: `qwen_profiles/<account-id>/` (perfil persistente do Chromium — sobrevive a restarts)

### Particularidades

- **Rotação multi-conta** round-robin: rate limit em uma conta (cooldown de 3 min, ou o tempo que o Qwen indicar) → a próxima assume automaticamente.
- 1 requisição por vez **por conta** (mutex interno) — mais contas = mais paralelismo.
- Se aparecer CAPTCHA, o proxy rotaciona na hora para outra conta. Para destravar a conta afetada, resolva o captcha uma vez com o navegador visível: `npx tsx relogin.ts acc1 --browser=chrome` (ou a opção `[M]` do menu). A sessão renovada fica salva no perfil.
- Modelo destaque: `qwen-long` com **1 milhão de tokens** de contexto.

---

## 🟡 DeepSeek (porta 3001) — exige navegador com tela no 1º login

O chat.deepseek.com fica atrás de um **AWS WAF** que bloqueia navegadores headless no login. Além disso, cada requisição exige resolver um **Proof-of-Work (PoW)** — o proxy resolve isso sozinho usando o WASM oficial do DeepSeek; você não precisa fazer nada.

### Configurar conta

**Rodando local — o 1º login precisa ser com a janela visível:**

```bash
cd deepseek
HEADLESS=false npm run login
# Menu igual ao do Qwen: [A] adicionar com credenciais → [L] logar todas
```

Depois do primeiro login bem-sucedido, a sessão fica persistida e o servidor pode rodar headless normalmente:

```bash
npm start
```

**Rodando via Docker — login 100% automático:**

O container usa **Xvfb** (display virtual), então o navegador "com tela" roda dentro do container sem você ver nada. Basta preencher o `.env`:

```env
DEEPSEEK_EMAIL=seu-email@exemplo.com
DEEPSEEK_PASSWORD=sua-senha
```

```bash
docker compose up --build -d
```

A conta é cadastrada e logada sozinha no primeiro start. 🎉

### Onde fica a sessão

- Contas: `data/deepseekproxy.db`
- Cookies/token (incluindo o do AWS WAF): `deepseek_profiles/<account-id>/`

### Particularidades

- **PoW automático**: resolvido por requisição via WASM (`sha3_wasm_bg.wasm`) — transparente.
- **Modelos fixos**: `deepseek-chat` (rápido) e `deepseek-reasoner` (R1 com `reasoning_content`), ambos 64K de contexto.
- Token expirado → o proxy renova sozinho; se as credenciais estiverem no `.env`, refaz até o login.
- Se o WAF bloquear até em modo visível: aguarde alguns minutos ou tente outro navegador (`npm run login:firefox`).
- Rate limit no DeepSeek pode pedir horas de espera — o proxy respeita o tempo indicado e rotaciona para outra conta.

---

## 🟡 GLM / chat.z.ai (porta 3002) — CAPTCHA uma vez, depois nunca mais

O z.ai protege o login com **CAPTCHA** e assina cada requisição com um **`x-signature` ofuscado** que muda a cada deploy do frontend — impossível de replicar fora do navegador. Por isso o proxy usa uma **bridge**: o Playwright digita o prompt na UI real do z.ai e intercepta o stream de resposta. Para você, isso significa apenas: **resolver o CAPTCHA uma única vez**.

### Configurar conta — 3 passos

```bash
cd glm

# 1. Cadastrar a conta no banco (email + senha)
npm run login          # → [A] Add account

# 2. Resolver o CAPTCHA uma vez (navegador abre com tudo pré-preenchido)
npm run login:manual   # → resolva o CAPTCHA, clique "Sign in", aguarde "LOGIN OK"

# 3. Rodar
npm start
```

### Deploy headless / Docker — exporte a sessão

Como o Docker não tem tela para resolver CAPTCHA, exporte a sessão já autenticada:

```bash
npm run session:export   # gera glm_session.json (token JWT + cookies, portável)
docker compose up -d     # o container carrega o glm_session.json
```

O `glm_session.json` é **portável entre máquinas** — pode copiá-lo para o servidor. O token não expira (`exp: null`).

### Onde fica a sessão

- Contas: `data/glmproxy.db`
- Sessão por conta: `glm_profiles/<account-id>/` + `glm_session.json` (exportada)

### Particularidades

- **Modo guest**: sem nenhuma conta configurada, o proxy funciona como convidado — mas com rate limit bem mais restritivo. Bom para testar, ruim para usar.
- **Modelos dinâmicos**: a lista vem da própria plataforma (`GET /v1/models` sempre reflete o que sua conta tem acesso). Destaque: `glm-4.6` com 200K de contexto.
- Sessão expirou / stream nunca começa → rode `npm run login:manual` de novo e re-exporte.
- Debug visual: `HEADLESS=false npm start` para ver o navegador trabalhando.

---

## 🔴 MiniMax (porta 3003) — login exclusivamente manual

O agent.minimax.io usa **OAuth2 (Ory) com captcha** e assina o corpo inteiro de cada requisição (`x-signature` + `x-timestamp`) no frontend. Igual ao GLM, o proxy opera como **bridge** sobre a UI real — e aqui **não existe login por credenciais**: as variáveis `MINIMAX_EMAIL`/`MINIMAX_PASSWORD` do `.env` são ignoradas.

### Configurar conta — 2 passos

```bash
cd minimax

# 1. Login manual (abre o navegador; entre com email/senha ou Google e resolva o captcha)
npm run login:manual
# O proxy detecta sozinho quando a sessão é criada e salva o perfil.

# 2. Rodar
npm start
```

### Deploy headless / Docker — exporte a sessão

```bash
npm run session:export   # gera minimax_session.json (cookies + localStorage)
docker compose up -d
```

### Onde fica a sessão

- Contas: `data/minimaxproxy.db`
- Perfis: `minimax_profiles/_default/` (login manual) e `minimax_profiles/acc1..N/` (multi-conta)
- Sessão exportada: `minimax_session.json` (portável; o JWT tem data de expiração — quando vencer, repita o login manual e re-exporte)

### Particularidades

- **O modelo real é o selecionado na UI** do MiniMax — o campo `model` da requisição é usado para listar e calcular contexto, mas a assinatura cobre o corpo, então a troca efetiva acontece na interface. Destaque: `MiniMax-M3` com **450K tokens** de contexto.
- **Tool calling robusto**: parser multi-formato (`<tool_call>`, `<minimax:tool_call>`, etc.); a instrução de tools é injetada como último turno de *user* porque o harness do MiniMax descarta system prompts.
- **Reasoning**: `MiniMax-M3` pensa por padrão (`reasoning_content` na resposta); use `MiniMax-M3-no-thinking` para desligar.
- A bridge fecha popups da UI sozinha (ex.: "Download desktop app") e tem watchdog de stream (60s para o 1º chunk, 120s entre chunks).
- Debug: `HEADLESS=false npm start` ou `LOG_CONSOLE=true npm start`.

---

## 🖥️ Open WebUI — interface única para os 4 proxies

O `docker-compose.yml` da **raiz** sobe um [Open WebUI](https://github.com/open-webui/open-webui) já pré-configurado com os 4 proxies:

```bash
# 1. Suba os proxies que quiser (cada um no seu diretório)
cd qwen && npm start          # ou docker compose up -d

# 2. Suba o Open WebUI (na raiz do repositório)
docker compose up -d

# 3. Acesse http://localhost:2999
#    (o primeiro usuário cadastrado vira admin)
```

Os modelos de cada proxy aparecem automaticamente (o WebUI consulta `/v1/models` de cada um). Já vem com busca web (DuckDuckGo), code interpreter (pyodide) e upload de documentos (RAG) habilitados. Para trocar URLs/keys sem editar o compose, use o `.env` da raiz (veja `.env.example`).

> 💡 Defina `WEBUI_SECRET_KEY` no `.env` da raiz para não ser deslogado a cada restart do container.

---

## ⚙️ Variáveis de ambiente comuns

Cada proxy tem seu próprio `.env` (copie de `.env.example`). As mais importantes:

| Variável | Default | O que faz |
|----------|---------|-----------|
| `PORT` | 3000–3003 | Porta do proxy (cada um tem a sua) |
| `API_KEY` | *(vazio)* | Se definida, exige `Authorization: Bearer <key>` nos endpoints `/v1/*`. Vazio = sem autenticação |
| `HEADLESS` | `true` | `false` abre o navegador visível (essencial para 1º login e debug) |
| `BROWSER` | `chromium` | `chromium` \| `firefox` \| `chrome` \| `edge` |
| `<NOME>_EMAIL` / `<NOME>_PASSWORD` | *(vazio)* | Credenciais para login automático (funciona no qwen e deepseek; ignorado no minimax) |
| `USER_DATA_DIR` | `./<nome>_profiles` | Onde ficam os perfis de navegador (sessões) |
| `CHAT_TIMEOUT` | `120000` | Timeout (ms) de um completion |
| `LOG_CONSOLE` | `false` | Loga o console do navegador (debug) |

Os timeouts de stream, watchdog e thresholds de RAM/streams também são configuráveis — veja o `.env.example` de cada proxy.

---

## 👥 Múltiplas contas e rate limit

Todos os proxies suportam **várias contas com rotação automática**:

1. Adicione contas pelo menu (`npm run login` → `[A]` ou `[M]`).
2. As requisições são distribuídas em **round-robin** entre as contas.
3. Conta que tomar rate limit entra em **cooldown** (3 min por padrão, ou o tempo que a plataforma indicar) e é pulada até voltar.
4. Cada conta processa **1 requisição por vez** (mutex) — mais contas = mais throughput.

Acompanhe o estado em tempo real:

```bash
curl http://localhost:3000/health
# → status, login de cada conta e cooldowns ativos com tempo restante
```

---

## 🔧 Troubleshooting rápido

| Sintoma | Provável causa | Solução |
|---------|----------------|---------|
| `401` / `loggedIn: false` no `/health` | Sessão expirou | `npm run login` → `[L]` (qwen/deepseek) ou `npm run login:manual` + `session:export` (glm/minimax) |
| Todas as requisições dão erro de rate limit | Todas as contas em cooldown | Aguarde (veja `remainingMs` no `/health`) ou adicione mais contas |
| `Browser is not available` | Navegadores do Playwright não instalados | `npx playwright install --with-deps` |
| `profile appears to be in use` / `SingletonLock` | Crash anterior deixou lock órfão | O proxy limpa sozinho; manual: delete `<nome>_profiles/<id>/SingletonLock` |
| Stream trava no meio | Stall no upstream | Watchdog aborta sozinho; aumente `STREAM_*_TIMEOUT` se sua rede for lenta |
| `database disk image is malformed` | SQLite corrompido | Delete `data/<nome>proxy.db` e re-cadastre as contas |
| Porta em uso | Outro processo na porta | Linux/macOS: `lsof -i :3000` · Windows: `netstat -ano \| findstr :3000` — encerre o processo ou mude `PORT` no `.env` |
| Docker do glm/minimax não loga | Falta o arquivo de sessão | Rode `npm run session:export` local e copie o `*_session.json` para o servidor (`scp`/`rsync` — nunca via git) |

Para investigar qualquer proxy de perto:

```bash
HEADLESS=false LOG_CONSOLE=true npm start   # navegador visível + console da página
```

---

## 📁 Estrutura do repositório

```
proxies-llm-openai/
├── docker-compose.yml   # Open WebUI (porta 2999) apontando para os 4 proxies
├── .env.example         # Configuração opcional do Open WebUI
├── qwen/                # Proxy Qwen        → localhost:3000
├── deepseek/            # Proxy DeepSeek    → localhost:3001
├── glm/                 # Proxy GLM (z.ai)  → localhost:3002
├── minimax/             # Proxy MiniMax     → localhost:3003
├── kimi/                # 🚧 Scaffold — futuro proxy Kimi    → localhost:3004
└── mistral/             # 🚧 Scaffold — futuro proxy Mistral → localhost:3005
```

Cada proxy é um projeto Node independente (com seu próprio `package.json`, `.env` e `README.md` com detalhes de arquitetura e API).

---

## 🗺️ Roadmap — próximos proxies

Duas pastas já reservam estrutura e plano para os próximos proxies (ainda **não implementados** — apenas scaffold com servidor stub e roteiro):

| Proxy | Porta | Plataforma | Status |
|-------|:-----:|------------|--------|
| [**kimi**](kimi/) | `3004` | kimi.com (Moonshot AI, Kimi K2) | 🚧 Scaffold — plano em [kimi/PLAN.md](kimi/PLAN.md) |
| [**mistral**](mistral/) | `3005` | chat.mistral.ai (Le Chat) | 🚧 Scaffold — plano em [mistral/PLAN.md](mistral/PLAN.md) |

Cada `PLAN.md` define as 6 fases de implementação, começando pelo **reconhecimento da plataforma** (API direta estilo qwen vs bridge de UI estilo glm/minimax). Os stubs já respondem `/health` com `status: "scaffold"` e `501` nos endpoints de chat.

> 💡 **Gemma não precisa de proxy**: é modelo open-weight — rode local com [Ollama](https://ollama.com) (`ollama run gemma3`) e aponte qualquer cliente OpenAI para `http://localhost:11434/v1`.

---

## ⚠️ Avisos

- Estes proxies automatizam **suas próprias contas pessoais** nos chats web. Automação pode violar os termos de serviço de cada plataforma e levar a bloqueio da conta — use por sua conta e risco, com moderação, e prefira as APIs oficiais para uso comercial.
- Projeto para fins educacionais e de uso pessoal; é fornecido "como está", sem garantias.
- Não exponha as portas dos proxies à internet sem definir `API_KEY` — por padrão eles aceitam requisições sem autenticação.

## 🔒 Segurança dos seus dados

Vários arquivos gerados em uso local contêm **credenciais da sua conta** e já estão no `.gitignore` (na raiz e em cada proxy):

| Arquivo | Conteúdo |
|---------|----------|
| `.env` | E-mail e senha em texto puro |
| `data/*.db` | Banco de contas (e-mail e senha em texto puro) |
| `*_profiles/` | Perfis de navegador com cookies de sessão logada |
| `*_session.json` | Token + cookies exportados (acesso total à conta) |
| `recon-*.jsonl`, `discover-*` | Capturas de tráfego com headers/tokens |

Nunca os versione — nem em repositório privado. Para levar uma sessão para outro servidor, copie o arquivo diretamente (`scp`/`rsync`).

## 🙏 Créditos e licença

A base do proxy Qwen (e, por consequência, a arquitetura reaproveitada nos demais) vem do [**qwenproxy**](https://github.com/pedrofariasx/qwenproxy), de Pedro Farias, sob licença ISC — os arquivos `LICENSE` originais foram mantidos em cada subprojeto.

As demais contribuições deste repositório também são distribuídas sob a licença [ISC](LICENSE).
