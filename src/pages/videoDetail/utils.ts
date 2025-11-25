import { DEFAULT_HOTKEYS } from './constants';

import type { Caption, HotkeyConfig, Video } from './types';

export function normalizeEventKey(key: string) {
  // 일부 구형/특정 환경 대응
  if (key === 'Spacebar') return ' ';
  return key;
}

const INVALID_HOTKEY_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
]);

export function isInvalidHotkeyKey(key: string) {
  return INVALID_HOTKEY_KEYS.has(key);
}

export function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export function formatMeta(video: Video) {
  const duration =
    typeof video.durationMs === 'number'
      ? `${Math.round(video.durationMs / 1000)}s`
      : null;
  const resolution =
    typeof video.width === 'number' && typeof video.height === 'number'
      ? `${video.width}x${video.height}`
      : null;

  return [duration, resolution].filter(Boolean).join(' · ');
}

export function sortCaptions(captions: Caption[]) {
  return [...captions].sort((a, b) => {
    const aStart = Number.isFinite(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
    const bStart = Number.isFinite(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });
}

export function getLastValidEndMs(captions: Caption[]) {
  for (let i = captions.length - 1; i >= 0; i -= 1) {
    const endMs = captions[i]?.endMs;
    if (Number.isFinite(endMs)) return endMs as number;
  }
  return 0;
}

export function createCaptionId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `caption_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function snapToStep(ms: number, stepMs: number) {
  if (!Number.isFinite(ms) || stepMs <= 0) return ms;
  return Math.round(ms / stepMs) * stepMs;
}

export function formatSeconds(valueMs: number) {
  if (!Number.isFinite(valueMs)) return '';
  return (Math.max(0, valueMs) / 1000).toFixed(2);
}

export function formatMsWithSeconds(valueMs: number) {
  if (!Number.isFinite(valueMs)) return '--';
  const clamped = Math.max(0, Math.round(valueMs));
  const seconds = (clamped / 1000).toFixed(2);
  return `${clamped}ms (${seconds}s)`;
}

export function sanitizeHotkeyConfig(value: unknown): HotkeyConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_HOTKEYS };

  const parsed = value as Record<keyof HotkeyConfig, unknown>;
  const next: HotkeyConfig = { ...DEFAULT_HOTKEYS };

  for (const key of Object.keys(DEFAULT_HOTKEYS) as (keyof HotkeyConfig)[]) {
    const candidate = parsed[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      next[key] = candidate;
    }
  }

  return next;
}

export function formatKeyLabel(key: string) {
  if (key === ' ') return 'Space';
  if (key === 'Enter') return 'Enter';
  if (key === 'ArrowLeft') return 'ArrowLeft';
  if (key === 'ArrowRight') return 'ArrowRight';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function parseCaptionGapMs(raw: unknown) {
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.round(parsed));
}

export function sanitizeForFileName(text: string, fallback: string) {
  const safe = text.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return safe || fallback;
}

export function formatNowForFileName(now = new Date()) {
  const yyyy = now.getFullYear().toString();
  const MM = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

export function autoAlignCaptions(captions: Caption[], gapMs: number) {
  const sorted = sortCaptions(captions);
  let prevEnd: number | null = null;

  return sorted.map((caption) => {
    let startMs = caption.startMs;
    let endMs = caption.endMs;

    if (!Number.isFinite(startMs)) {
      startMs = Number.isFinite(prevEnd) ? (prevEnd as number) + gapMs : 0;
    } else if (Number.isFinite(prevEnd) && startMs < (prevEnd as number) + gapMs) {
      startMs = (prevEnd as number) + gapMs;
    }

    if (!Number.isFinite(endMs) || (Number.isFinite(startMs) && endMs <= startMs)) {
      endMs = (Number.isFinite(startMs) ? (startMs as number) : 0) + 1000;
    }

    prevEnd = Number.isFinite(endMs) ? endMs : prevEnd;

    return { ...caption, startMs, endMs };
  });
}
