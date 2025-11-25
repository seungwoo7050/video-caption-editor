import { getActiveCaptionAtMs } from '@/lib/captionActive';

import type { Caption } from '../types';

export function getActiveCaption(captions: Caption[], currentTimeMs: number | null) {
  if (typeof currentTimeMs !== 'number' || !Number.isFinite(currentTimeMs)) return null;
  return getActiveCaptionAtMs(captions, currentTimeMs);
}
