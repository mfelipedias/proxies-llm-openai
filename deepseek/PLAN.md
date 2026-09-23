# DeepSeekProxy — notas técnicas

Porte do **QwenProxy** para o **DeepSeek** (`chat.deepseek.com`): proxy local
compatível com OpenAI que automatiza o chat web via Playwright (multi-conta,
streaming, tool-calling). Pasta isolada de `qwen/`.

> **Status: COMPLETO E FUNCIONANDO** ✅ — `/v1/chat/completions` responde com
> modelos reais do DeepSeek, em streaming e não-streaming, com `content` +
> `reasoning_content` (R1) + `usage` + tool-calling. Validado via HTTP. Suíte de
> testes verde (24/24). Container Docker self-contained (login via Xvfb).

---

## 1. Como funciona (visão geral)

Mesma arquitetura do Qwen: um servidor Hono expõe a API OpenAI; por trás, o
Playwright mantém uma sessão autenticada no `chat.deepseek.com` e o serviço
replica as chamadas internas do app web. As diferenças vs. Qwen estão todas
resolvidas:

| Camada | Qwen | DeepSeek |
|---|---|---|
| Autenticação | cookie + `bx-ua` | **Bearer token** colhido do header `authorization` |
| Anti-bot | headers `bx-*` cacheáveis | **Proof-of-Work por request** (WASM) |
| Sessão | implícita | `POST /api/v0/chat_session/create` (stateless: 1 sessão/req) |
| Completion | `/api/v2/chat/completions` | `/api/v0/chat/completion` |
| Stream SSE | `delta.phase` | deltas por **path/operação** (`{v,p,o}`) |
| Modelos | `/api/models` dinâmico | estáticos: `deepseek-chat`, `deepseek-reasoner` |

Provedor-**agnóstico** e reaproveitado intacto: `core/account-manager`,
`core/database`, `core/metrics`, `core/logger`, `core/watchdog`,
`core/stream-registry`, `cache/`, `tools/`, `utils/`, `types/`, `api/server.ts`,
`index.ts`.

---

## 2. Detalhes da API DeepSeek (confirmados ao vivo)

- **Login**: por UI em `/sign_in` (preencher email + senha, clicar "Log in"). O
  app guarda o token no `localStorage["userToken"] = {"value":"<token>"}` após
  carregar a home `/`. Em runtime, porém, `getDeepSeekAuth` **colhe o token do
  header `authorization: Bearer …`** de uma requisição real do app (mais
  confiável que o localStorage, reescrito de forma assíncrona).
- **Headers obrigatórios**: `x-app-version: 2.0.0`, `x-client-version: 2.0.0`,
  `x-client-platform: web`, `authorization: Bearer <token>`, cookie (inclui
  `aws-waf-token`). Chamadas fetch no Node com o cookie encaminhado **passam pelo
  AWS WAF**.
- **Sessão**: `POST /api/v0/chat_session/create` → id em
  `data.biz_data.chat_session.id`.
- **PoW**: `POST /api/v0/chat/create_pow_challenge {target_path}` → challenge em
  `data.biz_data.challenge` (`{algorithm, challenge, salt, difficulty, expire_at,
  signature, target_path}`). Resolvido pelo **WASM oficial**
  ([sha3_wasm_bg.wasm](src/services/sha3_wasm_bg.wasm), autocontido): `prefix =
  ${salt}_${expire_at}_`; `wasm_solve(retptr, challenge, len, prefix, len,
  difficulty)`; resposta = `f64` em `retptr+8`. Enviado no header
  `x-ds-pow-response = base64(JSON{algorithm,challenge,salt,answer,signature,target_path})`.
- **Completion**: `POST /api/v0/chat/completion`, body:
  ```json
  {"chat_session_id","parent_message_id":null,"model_type":"default","prompt",
   "ref_file_ids":[],"thinking_enabled":bool,"search_enabled":false,
   "action":null,"preempt":false}
  ```
- **Stream SSE** (deltas por path/op): o 1º `data` traz o objeto raiz com
  `fragments:[{type:"THINK"|"RESPONSE",content}]`; depois `{p:".../content",
  o:"APPEND", v:X}` e deltas puros `{v:X}` continuam o último path; um novo
  fragment chega via `{p:"response/fragments", o:"APPEND", v:[…]}`; fim em
  `{p:"response/status", o:"SET", v:"FINISHED"}`; usage em
  `accumulated_token_usage`. Parser em
  [deepseek-stream.ts](src/services/deepseek-stream.ts) (`THINK→reasoning_content`,
  `RESPONSE→content`).

---

## 3. Como rodar

```bash
cd deepseek
npm install && npx playwright install     # (ou reuse o node_modules do pai)
cp .env.example .env                       # preencher DEEPSEEK_EMAIL/PASSWORD

# 1º login: precisa de navegador headful (passa pelo AWS WAF) e persiste a sessão
HEADLESS=false npx tsx src/validate.ts     # valida o pipeline e cria deepseek_profiles/
# depois, o servidor headless reusa a sessão:
npm start                                  # http://localhost:3001/v1/chat/completions

npm test           # 24 testes
npm run typecheck
```

### Docker (turnkey)
`docker compose up --build -d` — funciona out-of-the-box:
- Chromium **headful sob Xvfb** (`HEADLESS=false` + `xvfb-run`) → 1º login dentro
  do container sem tela real.
- **Auto-cadastro da conta** do `.env` no startup se o DB estiver vazio
  (`server.ts`) — sem `npm run login`.
- Persistência em **volumes nomeados** (`ds_data`, `ds_profiles`) → evita o erro
  de *File Sharing* do Docker Desktop (macOS) com paths fora das pastas
  compartilhadas. Para bind mounts no host, edite o `docker-compose.yml` e
  habilite o path nas configs do Docker.

### Modelos
- `deepseek-chat` → resposta direta (thinking off).
- `deepseek-reasoner` (ou `*-r1`) → DeepThink/R1 (thinking on → `reasoning_content`).
- sufixo `-no-thinking` força thinking off em qualquer modelo.

---

## 4. Mapa de arquivos (específicos do DeepSeek)

```
src/
├── routes/chat.ts              # /v1/chat/completions (usa DeepSeekStreamParser)
├── services/
│   ├── deepseek.ts             # auth + sessão + PoW + completion (stateless)
│   ├── deepseek-stream.ts      # parser do SSE (path/op) -> deltas OpenAI
│   ├── pow.ts                  # PoW via WASM (requestPowChallenge/solveChallenge)
│   ├── sha3_wasm_bg.wasm       # WASM oficial do DeepSeek (solver de PoW)
│   └── playwright.ts           # login UI + token harvest + sessão persistida
├── api/models.ts               # /v1/models estático
├── core/{config,database,model-registry,accounts}.ts  # adaptados
└── tests/                      # deepseek-stream, pow, account-manager, index, + genéricos
```

---

## 5. Limitações / próximos passos (opcionais)

- **Multi-turn**: o proxy é stateless — cada request cria uma sessão nova e manda
  o histórico completo no prompt (padrão para proxy OpenAI; funciona). Sessão
  nativa do DeepSeek com `parent_message_id` não é usada.
- **1º login no container**: precisa do Xvfb (já configurado). Reusar
  `deepseek_profiles/` evita relogar.
- **Stop/cancel**: endpoint `/api/v0/chat/completion/cancel` é uma hipótese
  (ver `chatCompletionsStop` em [chat.ts](src/routes/chat.ts)); não validado.

---

## 6. Notas

- Porta default **3001** (Qwen usa 3000) para rodarem lado a lado.
- Perfis em `deepseek_profiles/`, banco em `data/deepseekproxy.db` (gitignored).
- DB redirecionável por `DEEPSEEK_DATA_DIR` (usado pelos testes).
- **Disclaimer**: uso educacional/pesquisa. Respeite os ToS do DeepSeek.
