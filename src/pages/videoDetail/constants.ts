import type { HotkeyConfig } from './types';

export const DEFAULT_HOTKEYS: HotkeyConfig = {
  togglePlay: ' ',
  setStart: '[',
  setEnd: ']',
  confirm: 'Enter',
};

export const HOTKEY_STORAGE_KEY = 'caption_hotkeys';
export const CAPTION_GAP_MS_STORAGE_KEY = 'caption_gap_ms';
export const TRIM_LOOP_EPSILON_MS = 60;

export const WAVEFORM_VIEWPORT_MIN_DURATION_MS = 500;
export const WAVEFORM_MIN_BUCKET_COUNT = 64;
export const WAVEFORM_MAX_LOD_SCALE = 16;
export const WAVEFORM_PEAK_CACHE_LIMIT = 6;
export const WAVEFORM_MAX_BUCKET_COUNT = 131072;
export const WAVEFORM_RASTER_CACHE_LIMIT = 4;
export const WAVEFORM_RASTER_MAX_WIDTH = 8192;
export const WAVEFORM_RASTER_MEMORY_BUDGET_BYTES = 48 * 1024 * 1024;
export const WAVEFORM_RASTER_MIN_WIDTH = WAVEFORM_MIN_BUCKET_COUNT;
export const WAVEFORM_PLAYHEAD_RATIO = 0.5;
export const WAVEFORM_FOLLOW_RESUME_MS = 1800;
