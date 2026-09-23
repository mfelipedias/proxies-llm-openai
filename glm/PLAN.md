# GLMProxy — plano de bootstrap (chat.z.ai / Zhipu)

Porte do `qwenproxy` para o **GLM (chat.z.ai)**. A estrutura está completa e
compila (`npx tsc --noEmit` limpo). Falta a etapa de **confirmação ao vivo** dos
endpoints/shapes (igual foi feito no `deepseek/`), porque o z.ai não foi
interceptado ainda — os valores abaixo são as **hipóteses** codificadas.

Por que base Qwen (e não DeepSeek): o chat.z.ai é **Open WebUI**, então tem
`GET /api/models` dinâmico (como o Qwen) e SSE em chunks (não o formato path/op
do DeepSeek). A única troca foi a camada de auth: em vez de interceptar headers
anti-bot (`bx-ua` do Qwen), usamos **Bearer token** (harvest + localStorage),
técnica emprestada do DeepSeek. Não há Proof-of-Work.

## Arquitetura (o que mudou vs. qwen)

| Camada | Qwen | GLM (este projeto) |
|---|---|---|
| Auth | cookie + `bx-ua`/`bx-umidtoken` interceptados | **Bearer token** (`getGLMAuth`) |
| Login | API/UI `chat.qwen.ai/auth` | UI `chat.z.ai/auth` (Open WebUI) |
| Completion | `POST /api/v2/chat/completions` | `POST /api/chat/completions` |
| Models | `GET /api/models` | `GET /api/models` (igual) |
| SSE | `choices[0].delta.phase` inline | parser dedicado `glm-stream.ts` |
| PoW | não | não |
| Porta | 3000 | **3002** |
| Perfis | `qwen_profiles/` | `glm_profiles/` |
| Banco | `qwenproxy.db` | `glmproxy.db` |

## Confirmado ao vivo (2026-06-06)

- **Auth**: Bearer JWT em `localStorage["token"]`. Sem login, o z.ai cria um
  token de **convidado** que já permite completar chat.
- **Modelos**: `GET /api/models` (200). Ids reais: `GLM-5.1`, `GLM-5-Turbo`,
  `glm-5`, `glm-4.7`, `glm-4.6v`, `0727-360B-API`, `deep-research`, etc.
- **Completion**: fluxo de 2 passos `POST /api/v1/chats/new` → `POST
  /api/v2/chat/completions?<query>`. Exige `x-signature` (HMAC-SHA256 ofuscado,
  rotativo), `x-fe-version`, e `captcha_verify_param` (CAPTCHA) no body.
- **SSE**: `data: {"type":"chat:completion","data":{"phase":"thinking|answer|
  other|done","delta_content","usage","done"}}`. `glm-stream.ts` parseia certo.

## Arquitetura bridge (por que não fetch direto)

`x-signature` é ofuscado e muda a cada deploy do frontend; `captcha_verify_param`
é um token de CAPTCHA. Replicar em Node é inviável/frágil. Então o
`createBridgeStream` (em `playwright.ts`) deixa o **app do navegador** assinar e
enviar: injeta o prompt no textarea, e um hook de `window.fetch` (via
`addInitScript` + `exposeBinding`) faz o tee do stream SSE de volta pro Node.
`model`/`enable_thinking` não entram na assinatura → são sobrescritos no hook.

Algoritmo da assinatura (decodificado, só pra referência):
`v=floor(ts/300000)`; `m=HMAC256(CONST, str(v))`; `h=sortedPayload+"|"+
base64(prompt)+"|"+ts`; `x-signature=HMAC256(m, h)`.

## Status

- [x] Estrutura/portagem (compila limpo)
- [x] Auth por Bearer token (harvest + localStorage)
- [x] Endpoints/SSE confirmados ao vivo
- [x] **Bridge** implementada e validada E2E (servidor :3002 respondeu
      `/v1/models`, completion non-stream e streaming com `reasoning_content`)
- [x] Multi-conta, rotação, cooldown, watchdog, métricas (herdados)
- [x] **Login real** — feito via `npx tsx src/manual-login.ts` (ou `npm run
      login:manual`): abre o perfil da conta, pré-preenche email/senha e você
      resolve o CAPTCHA UMA vez; a sessão persiste em `glm_profiles/<id>`.
      Login 100% automático é impossível (signin exige captcha:
      `{"detail":"The captcha verification failed."}`). `isGuestToken()`
      distingue guest de real; `extractAccountInfoFromContext` só reporta
      logado com token não-guest. Validado: servidor roda como a conta real.
- [x] **Headless** — `HEADLESS=true` funciona (a sessão persistida carrega
      logada; bridge dirige a UI normalmente). Validado: completion + streaming.
- [ ] **Stop** server-side (hoje só aborta local).
- [ ] Portar testes (hoje são do Qwen; vão falhar — mesma pendência do `deepseek/`)

## Primeiro uso (local)

1. `npm run login` → Add account (email+senha) — cria a linha no DB.
2. `npm run login:manual` → resolve o CAPTCHA uma vez (headful).
3. `npm run start` (ou `HEADLESS=true`) → servidor na :3002.

## Deploy headless / Docker (sessão portável)

O login (captcha) é feito **uma vez na máquina com tela**; a sessão (token +
cookies) vira um arquivo portável e o servidor headless roda logado.

1. Local: `npm run login` + `npm run login:manual` (resolve captcha).
2. Local: `npm run session:export` → gera **`glm_session.json`** (token não
   expira: `exp:null`). Validado: perfil zerado + headless carrega logado.
3. Copie `glm_session.json` para o servidor (`scp`/`rsync`). ⚠️ É CREDENCIAL
   DE ACESSO TOTAL — está no `.gitignore` e **nunca** deve ser versionado.
4. Servidor: `docker compose up -d`. Modo **zero-config**: sem conta no DB, o
   `account-manager` roteia pra página global, que carrega `glm_session.json`.
   Sem o arquivo, roda como **convidado** (limites menores) automaticamente.

Detalhes Docker resolvidos: `--no-sandbox` no Chromium; `/app/glm_profiles`
criado com dono `appuser` antes do VOLUME (ownership do volume nomeado); `.env`
opcional (`required:false`); `glm_session.json` copiado na imagem (`COPY . .`).
Re-login (se a sessão cair): repita 1-3 e `docker compose up -d --build`.
