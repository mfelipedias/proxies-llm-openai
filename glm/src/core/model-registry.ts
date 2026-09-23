// Janelas de contexto dos modelos GLM (z.ai). syncModelContextWindows()
// sobrescreve com os valores reais vindos de GET /api/models quando disponíveis.
// Obs.: a interface web (chat.z.ai) entrega 131072 mesmo para modelos cujo
// catálogo de API anuncia janelas maiores (ex.: glm-5.2 = 1M só via API paga).
// Os valores abaixo refletem o teto do caminho web (o que o bridge consegue
// usar de fato); syncModelContextWindows() ajusta com o live quando difere.
const modelContextWindows: Record<string, number> = {
  // ids conforme aparecem no GET /api/models (caixa preservada p/ match exato)
  'glm-5.2': 131072,
  'GLM-5.1': 131072,
  'GLM-5-Turbo': 131072,
  'GLM-5v-Turbo': 131072,
  'glm-4.7': 131072,
  'glm-4.6v': 131072,
  'glm-4.6': 200000,
  'glm-4.5': 131072,
  'glm-4.5-air': 131072,
  'glm-4.5v': 65536,
  'glm-4-32b': 131072,
}

const defaultContextWindow = 131072

export function setModelContextWindow(modelId: string, contextWindow: number): void {
  modelContextWindows[modelId] = contextWindow
}

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace('-no-thinking', '')
  return modelContextWindows[baseId] ?? defaultContextWindow
}

export function syncModelContextWindows(models: Array<{ id: string; context_window?: number }>): void {
  for (const m of models) {
    if (m.context_window) {
      modelContextWindows[m.id] = m.context_window
    }
  }
}
