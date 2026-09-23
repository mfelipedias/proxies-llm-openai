// Janelas de contexto dos modelos expostos pelo proxy.
// O chat web do DeepSeek opera essencialmente com UM modelo e um toggle
// "DeepThink (R1)". Expomos dois ids OpenAI-compatíveis:
//   - deepseek-chat      -> resposta direta (sem reasoning)
//   - deepseek-reasoner  -> com DeepThink/R1 (reasoning ligado)
// Os valores abaixo são estimativas; ajuste após confirmar no chat.deepseek.com.
const modelContextWindows: Record<string, number> = {
  'deepseek-chat': 65536,
  'deepseek-reasoner': 65536,
  'deepseek-v3': 65536,
  'deepseek-r1': 65536,
}

const defaultContextWindow = 65536

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
