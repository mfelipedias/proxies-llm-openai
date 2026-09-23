/*
 * File: minimax.ts
 * Project: minimaxproxy
 *
 * Camada de serviço do MiniMax (agent.minimax.io). Usa a arquitetura "bridge"
 * (ver playwright.ts): o app assina/envia e nós capturamos o SSE. Aqui só
 * disparamos o stream e expomos os modelos.
 */
import { createBridgeStream } from './playwright.ts';

export class RetryableMinimaxStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableMinimaxStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class MinimaxUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'MinimaxUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

// Modelos descobertos via archon/api/v1/config (estáveis). A seleção efetiva de
// modelo é a da UI (a assinatura cobre o corpo), então isto é informativo p/
// /v1/models. Variantes "-no-thinking" expostas por conveniência OpenAI.
export const MINIMAX_MODELS = [
  { id: 'MiniMax-M3', context_limit: 450000 },
  { id: 'MiniMax-M2.7', context_limit: 200000 },
  { id: 'MiniMax-M2.7-highspeed', context_limit: 200000 },
];

export async function fetchMinimaxModels(): Promise<any[]> {
  const base = MINIMAX_MODELS.map(m => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'minimax',
    context_window: m.context_limit,
  }));
  const extended = [...base];
  for (const m of base) extended.push({ ...m, id: `${m.id}-no-thinking` });
  return extended;
}

// Stateless: cada request abre uma sessão nova na UI. Mantido p/ compat com chat.ts.
export function updateSessionParent(_sessionId: string, _parentId: string | null) { /* no-op */ }

/**
 * Dispara um completion via bridge. `enableThinking`/`modelId`/`forcedParentId`
 * são aceitos por compat, mas o modelo/variante efetivos são os da UI.
 */
export async function createMinimaxStream(
  prompt: string,
  _enableThinking?: boolean,
  _modelId?: string,
  _forcedParentId?: string | null,
  accountId?: string,
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string }> {
  const { stream, controller, uiSessionId, accountId: usedAccount } = await createBridgeStream(prompt, accountId);
  return { stream, headers: {}, uiSessionId, controller, accountId: usedAccount };
}
