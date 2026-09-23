export interface PromptSegment {
  role: string;
  text: string;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const TRUNCATION_MARKER = '[...older conversation history truncated to fit the context window...]\n\n';
const RESPONSE_RESERVE_TOKENS = 1000;

/**
 * Trunca o histórico JÁ SERIALIZADO (um segmento por mensagem, no mesmo
 * formato `User:`/`Assistant:`/`Tool Response:` montado pelo chat.ts),
 * preservando:
 *   - o system prompt na ÍNTEGRA (é nele que vivem as instruções de
 *     <tool_call>; sem ele o modelo deixa de saber chamar tools);
 *   - turnos inteiros (nunca corta uma mensagem ao meio);
 *   - o turno mais recente, sempre;
 *   - sem respostas de tool órfãs no início do histórico mantido.
 *
 * Os turnos mais antigos são descartados primeiro.
 */
export function truncateSerializedHistory(
  systemPrompt: string,
  segments: PromptSegment[],
  maxContextTokens: number
): string {
  const sysTokens = estimateTokenCount(systemPrompt);
  const budget = maxContextTokens - sysTokens - RESPONSE_RESERVE_TOKENS - estimateTokenCount(TRUNCATION_MARKER);

  // Caminha do fim para o início mantendo os turnos mais recentes que couberem.
  // `start` é o índice do primeiro turno mantido (sempre mantém o último).
  let start = segments.length;
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const t = estimateTokenCount(segments[i].text);
    if (used + t > budget && start < segments.length) break;
    used += t;
    start = i;
  }
  if (start >= segments.length && segments.length > 0) {
    start = segments.length - 1; // garante pelo menos o turno atual
  }

  // Não começar o histórico com respostas de tool sem o tool_call correspondente.
  while (start < segments.length - 1 && (segments[start].role === 'tool' || segments[start].role === 'function')) {
    start++;
  }

  const marker = start > 0 ? TRUNCATION_MARKER : '';
  const history = marker + segments.slice(start).map(s => s.text).join('');
  return systemPrompt ? `${systemPrompt}\n${history}` : history;
}
