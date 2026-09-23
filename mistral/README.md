# 🚧 Mistral Proxy (Le Chat / chat.mistral.ai) — porta 3005

> **Status: SCAFFOLD — ainda não implementado.** Esta pasta existe para reservar a
> estrutura e o roteiro do futuro proxy. O plano de implementação completo está em
> [PLAN.md](PLAN.md).

Quando pronto, este proxy seguirá o mesmo padrão dos demais (Hono + Playwright + SQLite)
e exporá o Le Chat via API OpenAI-compatible em `http://localhost:3005/v1`.

## O que o stub atual faz

```bash
npm install
npm start          # sobe em :3005
curl http://localhost:3005/health   # → { "status": "scaffold", ... }
```

- `GET /health` → `status: "scaffold"` (deixa claro que não está implementado)
- `GET /v1/models` → lista vazia
- `POST /v1/chat/completions` → `501 Not Implemented`

## Por onde retomar

1. Leia o [PLAN.md](PLAN.md) — a **Fase 1 (reconhecimento)** decide tudo: se o Le Chat
   aceita API direta com sessão (caminho qwen, mais simples) ou exige bridge de UI
   (caminho glm/minimax).
2. Os módulos genéricos (`core/`, `tools/`, `routes/`, etc.) vêm prontos do qwen ou do glm —
   o trabalho específico é login + serviço de chat/stream.
