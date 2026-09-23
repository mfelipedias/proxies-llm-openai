# MiniMax Agent — API descoberta (engenharia reversa ao vivo)

Capturado em 2026-06-07 via `src/discover.ts` (Playwright interceptando o tráfego
real de `agent.minimax.io`, logado com uma conta real).

## Hosts
- `agent.minimax.io` — API principal: superfícies `archon/api/v1/*`, `matrix/api/v1/*`, `v1/api/*`
- `agent-stream.minimax.io` — streaming: `archon/api/v1/events` (canal SSE persistente) e o POST de mensagem
- `account.minimax.io` — autenticação (OAuth2 / Ory)
- `cdn.hailuo.ai` — assets do front-end "mavis-chat" (FE version `prod-web-va-0.1.38`)

## Auth
- **OAuth2 (Ory)**. Login: `POST account.minimax.io/oauth2/login` com body
  `{"loginType":"20","email":"...","authToken":"<blob criptografado>","countryCode":"+86","deviceID":"...","login_redirect":"/oauth2/authorize?client_id=agent-minimax&..."}`.
  `authToken` é um blob criptografado pelo FE (não é a senha em texto).
- Depois: redirect para `agent.minimax.io/auth/callback?code=ory_ac_...&state=...` → o app troca o code por um **JWT (HS256)**.
- **O token vai como query param `?token=<JWT>` em TODA chamada** (não é header Authorization).
- Refresh: `POST agent.minimax.io/v1/api/user/renewal?...&token=<JWT>`.
- Info do usuário: `GET agent.minimax.io/v1/api/user/info?...&token=<JWT>`.

## Anti-bot (BLOQUEIO para fetch direto)
Toda request carrega:
- `x-signature`: 32 hex (estilo MD5), **único por request**
- `x-timestamp`: unix em segundos

Calculados por um interceptor do FE. Replicar em Node é frágil (igual ao z.ai/GLM).
→ **Arquitetura recomendada: bridge** (deixar a própria página assinar/enviar e
capturar o stream), como o porte `glm/`.

## Query params comuns (em toda chamada)
`device_platform=web&biz_id=3&app_id=3001&version_code=22201&unix=<ms>&timezone_offset=<min>&lang=en&sys_language=en&uuid=<uuid>&device_id=<id>&os_name=...&browser_name=...&device_memory=16&cpu_core_num=8&browser_language=pt-BR&browser_platform=...&user_id=<id>&screen_width=...&screen_height=...&client=web&region=en`

## Modelos
`GET agent.minimax.io/archon/api/v1/config?...` → `{"models":[...]}`:
| model_id | context_limit | variants | thinking |
|---|---|---|---|
| `MiniMax-M3` | 450000 | `["","thinking"]` | switchable |
| `MiniMax-M2.7` | 200000 | `[""]` | forced_on |
| `MiniMax-M2.7-highspeed` | 200000 | `[""]` | — |

(também há mapeamento `chat_type_model_map` no config: `{"0":"Auto","1":"MiniMax-M2.1","2":"Auto"}`)

## Fluxo de chat (agêntico)
1. **Criar sessão**: `POST agent.minimax.io/archon/api/v1/agent/<agent_id>/session?...&token=` → `{"session":{"session_id":"..."}}`.
   Agent padrão (conta nova): `406779552788772` (existe também `...771`). `team_mode:true`.
2. **Enviar mensagem**: `POST agent-stream.minimax.io/archon/api/v1/session/<session_id>/message?...&token=`
   - headers: `content-type: application/json`, `x-signature`, `x-timestamp`
   - body: `{"content":"Oi","model":{"provider_id":"minimax","model_id":"MiniMax-M3","variant":"thinking"},"turn_id":"<uuid>","enable_team":true,"worktreeMode":false}`
   - **resposta: `text/event-stream`** (a resposta do agente streama aqui). ⚠️ formato do SSE ainda não capturado (próximo passo).
3. Canal SSE persistente em paralelo: `GET agent-stream.minimax.io/archon/api/v1/events?...&token=`.
4. Status: `GET agent.minimax.io/archon/api/v1/session/<id>` é "pollado" (`status.type`: 0=ocioso, 1=rodando); o app também auto-gera o `title` da sessão após a resposta.

## Envelope de resposta
`{... , "base_resp":{"status_code":0,"status_msg":"success"}}` ou `{"statusInfo":{"code":0,...}}`.

## ⚠️ Conta sem créditos
`matrix/api/v1/commerce/get_membership_info` → `plan_type:1` (free), `total_remains_credit:0`,
`opcredit_balance:0`, `has_token_plan:false`. **Risco: a geração pode ser bloqueada por falta de crédito.**
Validar se o "oi" realmente gerou resposta (a sessão foi auto-titulada, o que sugere que sim).

## Outras superfícies vistas (não essenciais p/ chat)
`archon/api/v1/{agent,cron,channel,skill,skill-hub,sidebar/session/tree,preferences/pinned-items-order}`,
`matrix/api/v1/{bot/list,user/get_user_extra_info,commerce/*,metric/report}`,
`v1/api/config/web/common_config`.

## Pendências
1. **Capturar o formato do SSE** da resposta (`/message` e/ou `/events`) → mapear delta/thinking/answer.
2. Implementar a **bridge** (hook de `window.fetch`) em `playwright.ts` + reescrever `services/minimax.ts` e `routes/chat.ts`.
3. Confirmar se a conta free consegue gerar (créditos).
