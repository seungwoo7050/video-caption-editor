import type { Caption } from '@/datasource/types'

export type CaptionWorkerRequest =
  | { type: 'syncCaptions'; captions: Caption[] }
  | { type: 'scanActiveCaption'; currentTimeMs: number }

export type CaptionWorkerResponse =
  | { type: 'activeCaption'; activeCaptionId: string | null; currentTimeMs: number }
  | { type: 'log'; message: string }