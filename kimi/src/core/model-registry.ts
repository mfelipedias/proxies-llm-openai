// Janela de contexto por modelo do Kimi (K2.6). Usado para truncar o histórico
// serializado antes de enviar. Valores conservadores até medir o limite real.
const modelContextWindows: Record<string, number> = {
  'kimi-k2.6': 131072,
  'kimi-k2.6-thinking': 131072,
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
