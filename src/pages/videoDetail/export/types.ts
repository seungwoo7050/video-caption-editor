import type { Caption, TrimRange } from '../types';

export type NormalizedTrimRange = { trimStart: number; trimEnd: number } | null;

export interface UseBurnInExportParams {
  captionDrafts: Caption[];
  durationMs: number | null;
  safeTitleOrId: string;
  videoBlob: Blob | null | undefined;
}

export interface UseBurnInExportResult {
  burnInError: string | null;
  burnInFileName: string | null;
  burnInMessage: string | null;
  burnInProgress: number | null;
  burnInResultUrl: string | null;
  handleBurnInExport: () => Promise<void>;
  handleCancelBurnIn: () => void;
  isBurningIn: boolean;
}

export interface UseTrimExportParams {
  applyTrimOnExport: boolean;
  effectiveDurationMs: number | null | undefined;
  normalizedTrimRange: NormalizedTrimRange;
  safeTitleOrId: string;
  trimRange: TrimRange | null;
  videoBlob: Blob | null | undefined;
}

export interface UseTrimExportResult {
  handleCancelTrim: () => void;
  handleTrimExport: () => Promise<void>;
  isTrimming: boolean;
  trimError: string | null;
  trimFileName: string | null;
  trimMessage: string | null;
  trimProgress: number | null;
  trimResultUrl: string | null;
}
