import type { Caption } from '@/datasource/types'

import type { CaptionWorkerRequest, CaptionWorkerResponse } from './captionScanner.types'

let captions: Caption[] = []
let lastActiveId: string | null = null
function findActiveCaption(currentTimeMs: number) {
  let nextActiveId: string | null = null

  for (const caption of captions) {
    if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) continue
    if (currentTimeMs >= caption.startMs && currentTimeMs < caption.endMs) {
      nextActiveId = caption.id
      break
    }
  }

  return nextActiveId
}

self.addEventListener('message', (event: MessageEvent<CaptionWorkerRequest>) => {
  const message = event.data

  if (message.type === 'syncCaptions') {
    captions = message.captions
    lastActiveId = null
    self.postMessage({
      type: 'log',
      message: `[worker] synced ${message.captions.length} captions`,
    } satisfies CaptionWorkerResponse)
    return
  }

  if (message.type === 'scanActiveCaption') {
    const { currentTimeMs } = message
    const activeCaptionId = findActiveCaption(currentTimeMs)

    if (activeCaptionId === lastActiveId) return
    lastActiveId = activeCaptionId

    self.postMessage({
      type: 'activeCaption',
      activeCaptionId,
      currentTimeMs,
    } satisfies CaptionWorkerResponse)
  }
})

export {}