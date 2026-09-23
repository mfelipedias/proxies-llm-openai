import { metrics } from './metrics.js'
import { config } from './config.js'

const activeStreams = new Map<string, {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
  startedAt: number;
}>();

// Rede de segurança: aborta streams registrados há mais de streamMaxAge.
// Com os timeouts de primeiro chunk/inatividade do bridge isso raramente
// dispara, mas garante que nenhum stream órfão segure recursos para sempre.
let sweeper: ReturnType<typeof setInterval> | null = null

function ensureSweeper(): void {
  if (sweeper || !(config.timeouts.streamMaxAge > 0)) return
  sweeper = setInterval(() => {
    const cutoff = Date.now() - config.timeouts.streamMaxAge
    for (const [key, entry] of activeStreams) {
      if (entry.startedAt < cutoff) {
        console.warn(`[StreamRegistry] Aborting stale stream ${key} (older than ${config.timeouts.streamMaxAge}ms)`)
        try { entry.abortController.abort() } catch { /* noop */ }
        activeStreams.delete(key)
        metrics.increment('streams.stale_aborted')
      }
    }
    metrics.gauge('streams.active', activeStreams.size)
  }, 60_000)
  sweeper.unref?.()
}

export function registerStream(key: string, entry: {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
}): void {
  ensureSweeper()
  activeStreams.set(key, { ...entry, startedAt: Date.now() })
  metrics.gauge('streams.active', activeStreams.size)
}

export function getStream(key: string): ReturnType<typeof activeStreams.get> {
  return activeStreams.get(key)
}

export function removeStream(key: string): void {
  activeStreams.delete(key)
  metrics.gauge('streams.active', activeStreams.size)
}

export function abortStream(key: string): boolean {
  const entry = activeStreams.get(key)
  if (entry) {
    entry.abortController.abort()
    activeStreams.delete(key)
    metrics.gauge('streams.active', activeStreams.size)
    return true
  }
  return false
}
