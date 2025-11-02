import type { Video } from './types'

export const seededVideos: Video[] = [
  {
    id: 'v_seed_001',
    title: '샘플 비디오 1',
    createdAt: 1700000000000,
    durationMs: 42_000,
    width: 1280,
    height: 720,
  },
  {
    id: 'v_seed_002',
    title: '샘플 비디오 2',
    createdAt: 1700001000000,
    durationMs: 15_000,
    width: 1920,
    height: 1080,
  },
  {
    id: 'v_seed_003',
    title: '샘플 비디오 3',
    createdAt: 1700002000000,
  },
]
