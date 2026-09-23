# PLAN — Proxy Mistral Le Chat (chat.mistral.ai) → porta 3005

> **Status: scaffold.** Nada implementado além do servidor stub. Este documento é o
> roteiro para retomar o trabalho do zero sem redescobrir nada.

## O que já se sabe da plataforma

- **URL**: https://chat.mistral.ai
- **Login**: e-mail/senha ou OAuth (Google / Apple / Microsoft). Proteção Cloudflare
  moderada — esperar Turnstile no login, provavelmente não por requisição.
- **Modelos esperados**: tier free do Le Chat (Mistral Large/Medium, Codestral no modo
  código, Pixtral para imagem). Confirmar na fase 1 — lista real deve vir da plataforma.
- **Hipótese de arquitetura**: o Le Chat é um app Next.js; verificar se o chat usa uma
  API JSON limpa com bearer/cookie de sessão (caminho qwen, API direta) ou se há
  assinatura/ofuscação por requisição (caminho glm/minimax, bridge de UI).
- **Atenção**: o Le Chat tem recursos extras (web search, canvas, libraries) que podem
  vir ligados por padrão — na fase 1, verificar como desligá-los por flag na requisição
  para a resposta ser texto puro.

## Fases

### Fase 1 — Reconhecimento (fazer ANTES de escrever código)
- [ ] Abrir chat.mistral.ai com DevTools e mapear o fluxo de login (endpoints, cookies de sessão, Turnstile?).
- [ ] Enviar um prompt e inspecionar a chamada de chat: endpoint, headers, formato do stream.
- [ ] Verificar assinatura de request → decide API direta vs bridge.
- [ ] Mapear flags de web search/tools internos para conseguir resposta "crua".
- [ ] Anotar aqui: formato/validade da sessão, como renova, rate limits do tier free.

### Fase 2 — Base do projeto
- [ ] Copiar de `qwen/src/` (ou `glm/src/` se for bridge) os módulos genéricos:
      `core/`, `api/`, `routes/`, `tools/`, `types/`, `utils/`, `cache/`.
- [ ] Renomear referências (qwen→mistral), ajustar `config.ts` (PORT=3005, MISTRAL_*, mistral_profiles/).
- [ ] `npm install && npm run typecheck` limpo.

### Fase 3 — Login e sessão
- [ ] `src/login.ts`: menu [A]/[M]/[R]/[L]/[Q] como no qwen (multi-conta + SQLite).
- [ ] `src/manual-login.ts`: navegador visível para Turnstile/OAuth (referência: glm).
- [ ] `src/export-session.ts`: gerar `mistral_session.json` portável para Docker.
- [ ] Persistência em `mistral_profiles/<account-id>/`.

### Fase 4 — Chat completion
- [ ] `src/services/mistral.ts`: criação de conversa + envio de prompt.
- [ ] Stream → deltas OpenAI (`choices[].delta`).
- [ ] Variantes `-no-thinking` se houver modelo com reasoning (ex.: Magistral).
- [ ] Watchdog de stream (60s 1º chunk / 120s entre chunks — padrão do repo).

### Fase 5 — Tool calling e paridade
- [ ] Adaptar `tools/parser.ts` ao formato que o Le Chat emitir (testar com prompts de tool).
- [ ] Rotação multi-conta + cooldown em rate limit.
- [ ] `/health`, `/metrics`, `/v1/chat/completions/stop` reais.
- [ ] Testes: copiar suite de `qwen/src/tests/` e adaptar.

### Fase 6 — Docker e integração
- [ ] `Dockerfile` + `docker-compose.yml` (referência: glm; Xvfb se o login exigir tela).
- [ ] Adicionar ao `docker-compose.yml` da raiz e ao Open WebUI (porta 3005).
- [ ] Atualizar README da raiz: tirar o Mistral da seção "Roadmap" e pôr na tabela principal.

## Decisões em aberto
- API direta (estilo qwen) ou bridge de UI (estilo glm)? → responde-se na Fase 1.
- O tier free limita mensagens/dia por modelo? Medir e documentar.
