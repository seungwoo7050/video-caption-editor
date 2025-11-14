export type TrimRange = { startMs: number; endMs: number };

export function normalizeTrimRange(
  trimRange: TrimRange | null | undefined,
  durationMs: number | null | undefined,
): { trimStart: number; trimEnd: number } | null {
  if (!trimRange) return null;
  if (!Number.isFinite(trimRange.startMs) || !Number.isFinite(trimRange.endMs)) return null;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null;

  const rawStart = Math.min(trimRange.startMs, trimRange.endMs);
  const rawEnd = Math.max(trimRange.startMs, trimRange.endMs);
  const trimStart = Math.max(0, Math.min(rawStart, durationMs));
  const trimEnd = Math.max(trimStart, Math.min(rawEnd, durationMs));
  if (trimEnd <= trimStart) return null;
  return { trimStart, trimEnd };
}
