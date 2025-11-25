import { captionsToSrt, parseCaptionsFromJson, serializeCaptionsToJson } from '@/lib/captionIO';

import { autoAlignCaptions, sortCaptions } from '../utils';

import type { Caption, TrimRange } from '../types';

type ExportOptions = {
  applyTrimOnExport: boolean;
  trimRange: TrimRange | null;
};

export function getCaptionsForExport(
  captions: Caption[],
  { applyTrimOnExport, trimRange }: ExportOptions,
): Caption[] {
  if (!applyTrimOnExport || !trimRange) return captions;

  const { startMs, endMs } = trimRange;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return captions;

  const trimStart = Math.max(0, Math.min(startMs, endMs));
  const trimEnd = Math.max(trimStart, Math.max(startMs, endMs));
  if (trimEnd <= trimStart) return [];

  const trimmed = captions
    .filter((caption) => Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs))
    .filter((caption) => caption.endMs > trimStart && caption.startMs < trimEnd)
    .map((caption) => {
      const clippedStart = Math.max(caption.startMs, trimStart);
      const clippedEnd = Math.min(caption.endMs, trimEnd);
      return {
        ...caption,
        startMs: clippedStart - trimStart,
        endMs: clippedEnd - trimStart,
      };
    });
  return sortCaptions(trimmed);
}

export function createCaptionExportJson(captions: Caption[], options: ExportOptions) {
  const captionsForExport = getCaptionsForExport(captions, options);
  return serializeCaptionsToJson(captionsForExport);
}

export function createCaptionExportSrt(captions: Caption[], options: ExportOptions) {
  const captionsForExport = getCaptionsForExport(captions, options);
  return captionsToSrt(captionsForExport);
}

export function parseCaptionJsonForPage(
  text: string,
  createCaptionId: () => string,
  gapMs: number,
): Caption[] {
  const imported = parseCaptionsFromJson(text, createCaptionId);
  return autoAlignCaptions(imported, gapMs);
}
