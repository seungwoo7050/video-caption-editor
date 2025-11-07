import type { Caption } from '@/datasource/types'

export function getActiveCaptionAtMs(captions: Caption[], ms: number): Caption | null {
  if (!Number.isFinite(ms)) return null

  let candidate: Caption | null = null

  for (const caption of captions) {
    if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) continue
    if (!caption.text.trim()) continue
    if (caption.startMs > ms || caption.endMs <= ms) continue
    if (candidate === null || caption.startMs >= candidate.startMs) {
      candidate = caption
    }
  }

  return candidate
}
