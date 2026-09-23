const modelContextWindows: Record<string, number> = {
  // modelos reais do agent.minimax.io (archon/api/v1/config)
  'MiniMax-M3': 450000,
  'MiniMax-M2.7': 200000,
  'MiniMax-M2.7-highspeed': 200000,
}

const defaultContextWindow = 200000

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
