# PLAN — Proxy Kimi (kimi.com / Moonshot AI) → porta 3004

> **Status: Fase 2 concluída (base do qwen copiada e compilando).** A infra genérica
> (core/, cache/, tools/, types/, utils/, api/, routes/, services/) foi copiada do
> qwen e renomeada qwen→kimi; `npm run typecheck` passa limpo. **PENDENTE: Fase 1
> (recon manual) — a lógica de chat/login em `services/kimi.ts` e `services/playwright.ts`
> ainda é a do qwen, com URLs `*.kimi.ai` como PLACEHOLDERS.** O chat só funciona depois
> que a recon mapear os endpoints reais do kimi.com e eles substituírem os placeholders.

## O que já se sabe da plataforma

- **URL**: https://www.kimi.com (internacional) / https://kimi.moonshot.cn (China).
- **Login**: e-mail/senha ou Google OAuth na versão internacional. Captcha possível.
- **Modelos esperados**: `kimi-k2` (e variantes), contexto longo (128K+). Confirmar na fase 1 —
  a lista real deve vir da plataforma, como no glm (model-registry dinâmico).
- **Hipótese de arquitetura**: projetos antigos (ex.: kimi-free-api) sugerem que o backend
  aceita chamadas diretas com bearer/refresh token, **sem assinatura de corpo**. Se isso se
  confirmar, o caminho é o **modelo qwen** (API direta interceptada, mais simples), e não a
  bridge de UI do glm/minimax. Verificar na fase 1 — pode ter mudado.

## Fases

### Fase 1 — Reconhecimento ✅ (capturado via src/recon.ts em 2026-06-14)

**DECISÃO DE ARQUITETURA: API direta (estilo qwen).** Replay do endpoint de chat com
fetch direto do Node, usando só o Bearer capturado, retornou **HTTP 200 com e sem o
`x-msh-shield-data`** → não há assinatura de corpo obrigatória. Playwright é necessário
APENAS para capturar a sessão no login; o chat é fetch direto.

**Endpoint de chat (server-streaming):**
- `POST https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat`
- Protocolo **Connect-RPC** (não OpenAI). Headers obrigatórios:
  - `authorization: Bearer <JWT>`  ← token (ver abaixo)
  - `content-type: application/connect+json`
  - `connect-protocol-version: 1`
  - `x-msh-device-id`, `x-msh-session-id`, `x-traffic-id` (do `sub`/space do JWT),
    `x-msh-platform: web`, `x-msh-version: 1.0.0`, `x-language`, `r-timezone`
  - `x-msh-shield-data: sg:...` muda por request mas **é OPCIONAL** (testado: 200 sem ele). Ignorar.
- **Enquadramento Connect** (req e resp): cada mensagem = `[1 byte flag][4 bytes len BE][payload JSON]`.
  Frame final tem flag bit `0x02` (end-of-stream, payload = trailers `{}`).

**Corpo da requisição (JSON dentro do frame):**
```jsonc
// 1ª mensagem (chat novo): sem chat_id, sem parent_id
{"scenario":"SCENARIO_K2D5","tools":[],
 "message":{"role":"user","blocks":[{"message_id":"","text":{"content":"..."}}],"scenario":"SCENARIO_K2D5"},
 "options":{"thinking":false}}
// mensagem seguinte (mesmo chat): inclui chat_id + message.parent_id = id da última msg do assistant
{"chat_id":"<id>","scenario":"SCENARIO_K2D5","tools":[],
 "message":{"parent_id":"<assistant msg id>","role":"user","blocks":[{"message_id":"","text":{"content":"..."}}],"scenario":"SCENARIO_K2D5"},
 "options":{"thinking":false}}
```
`tools:[]` funciona (a UI manda `TOOL_TYPE_SEARCH` mas é opcional).

**Stream de resposta (eventos JSON, um por frame):**
- `{"heartbeat":{}}` → ignorar
- `{"op":"set","chat":{"id":"...","name":"..."}}` → **capturar `chat.id`** (necessário p/ multi-turn)
- `{"op":"set","mask":"message","message":{id,role:"assistant",status:"MESSAGE_STATUS_GENERATING"}}` → **id da msg do assistant** (vira o próximo parent_id)
- `{"op":"set","mask":"block.text","block":{"id":"1","text":{"content":"T"}}}` → 1º pedaço do texto
- `{"op":"append","mask":"block.text.content","block":{"id":"1","text":{"content":"udo"}}}` → deltas
- `{"op":"set","mask":"message.status","message":{status:"MESSAGE_STATUS_COMPLETED"}}` → fim da geração
- `{"done":{}}` → fim do stream. (Com `thinking:true`, esperar um bloco de reasoning separado — confirmar.)

**Token / sessão:**
- Vem do cookie **`kimi-auth`** (httpOnly, lido via `context.cookies()` no Playwright).
  É um JWT `HS512`; payload tem `sub`, `space_id`, `device_id`, `region:"overseas"`, `membership.level`.
- **Validade: 30 dias** (`exp - iat = 2592000s`). Renovação ainda não mapeada (provável endpoint
  de refresh; por ora, relogar quando expirar). `x-msh-device-id` = `device_id` do JWT.

**Modelos (de `ConfigService/GetAvailableModels`):** mapear para OpenAI:
- `kimi-k2.6` → scenario `SCENARIO_K2D5`, `options.thinking:false`
- `kimi-k2.6-thinking` → scenario `SCENARIO_K2D5`, `options.thinking:true`
- (Agent/Swarm = `SCENARIO_OK_COMPUTER` + `agentMode`; mais complexo, fica para depois.)

**Pendências de recon:** rate limit do tier free (não medido); fluxo de refresh do token;
formato exato do bloco de reasoning com `thinking:true`; multimodal (imagem) — fora do escopo v1.

### Fase 2 — Base do projeto ✅
- [x] Copiar de `qwen/src/` os módulos genéricos:
      `core/` (config, database, logger, metrics, account-manager, accounts, model-registry,
      stream-registry, watchdog), `api/`, `routes/`, `tools/`, `types/`, `utils/`, `cache/`.
      (Inclui `services/playwright.ts` + `services/kimi.ts` e os entrypoints `index.ts`/`login.ts`,
      como molde para as Fases 3–4. `tests/` e `benchmarks/` ficaram para a Fase 5.)
- [x] Renomear referências (qwen→kimi), ajustar `config.ts` (PORT=3004, KIMI_*, kimi_profiles/).
- [x] `npm install && npm run typecheck` limpo.

### Fase 3 — Login e sessão
- [ ] `src/login.ts`: menu [A]/[M]/[R]/[L]/[Q] como no qwen (multi-conta + SQLite).
- [ ] `src/manual-login.ts`: navegador visível para captcha/OAuth (referência: glm).
- [ ] `src/export-session.ts`: gerar `kimi_session.json` portável para Docker.
- [ ] Persistência em `kimi_profiles/<account-id>/`.

### Fase 4 — Chat completion
- [ ] `src/services/kimi.ts`: criação de conversa + envio de prompt.
- [ ] Stream SSE → deltas OpenAI (`choices[].delta`), com `reasoning_content` se o modelo pensar.
- [ ] Variantes `-no-thinking` no model-registry.
- [ ] Watchdog de stream (60s 1º chunk / 120s entre chunks — padrão do repo).

### Fase 5 — Tool calling e paridade
- [ ] Adaptar `tools/parser.ts` ao formato que o Kimi emitir (testar com prompts de tool).
- [ ] Rotação multi-conta + cooldown em rate limit (padrão: 3 min ou o que a plataforma indicar).
- [ ] `/health`, `/metrics`, `/v1/chat/completions/stop` reais.
- [ ] Testes: copiar suite de `qwen/src/tests/` e adaptar.

### Fase 6 — Docker e integração
- [ ] `Dockerfile` + `docker-compose.yml` (referência: glm; Xvfb se o login exigir tela).
- [ ] Adicionar ao `docker-compose.yml` da raiz e ao Open WebUI (porta 3004).
- [ ] Atualizar README da raiz: tirar o Kimi da seção "Roadmap" e pôr na tabela principal.

## Decisões em aberto
- API direta (estilo qwen) ou bridge de UI (estilo glm)? → responde-se na Fase 1.
- A conta free do kimi.com tem rate limit por mensagens/dia? Medir e documentar.
