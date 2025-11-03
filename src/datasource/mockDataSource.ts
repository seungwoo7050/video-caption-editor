import {
  getThumbnailBlob as getStoredThumbnail,
  getVideoBlob as getStoredVideo,
  saveThumbnailBlob,
  saveVideoBlob,
} from '@/lib/localAssetStore'

import { seededVideos } from './fixtures'

import type { Caption, CreateVideoInput, DataSource, Video, VideoId } from './types'

export function createMockDataSource(): DataSource {
  const videosById = new Map<VideoId, Video>()
  for (const v of seededVideos) videosById.set(v.id, v)

  let seq = 1
  const nextId = () => `v_mock_${String(seq++).padStart(4, '0')}`

  return {
    async listVideos(): Promise<Video[]> {
      return Array.from(videosById.values()).sort((a, b) => b.createdAt - a.createdAt)
    },

    async getVideo(id: VideoId): Promise<Video | null> {
      return videosById.get(id) ?? null
    },

    async createVideo(input: CreateVideoInput): Promise<Video> {
      const now = Date.now()
      const v: Video = {
        id: input.id ?? nextId(),
        title: input.title,
        createdAt: now,
      }
      videosById.set(v.id, v)
      return v
    },

    async deleteVideo(id: VideoId): Promise<void> {
      videosById.delete(id)
    },

    async updateVideoMetadata(
      id: VideoId,
      meta: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>>,
    ): Promise<void> {
      const prev = videosById.get(id)
      if (!prev) return

      const next: Video = {
        ...prev,
        ...(typeof meta.durationMs === 'number' ? { durationMs: meta.durationMs } : null),
        ...(typeof meta.width === 'number' ? { width: meta.width } : null),
        ...(typeof meta.height === 'number' ? { height: meta.height } : null),
      }
      videosById.set(id, next)
    },

    async listCaptions(_videoId: VideoId): Promise<Caption[]> {
      void _videoId
      return []
    },

    async saveCaptions(_videoId: VideoId, _captions: Caption[]): Promise<void> {
      void _videoId
      void _captions
    },

    async putVideoBlob(videoId: VideoId, blob: Blob): Promise<void> {
      await saveVideoBlob(videoId, blob)
    },

    async getVideoBlob(videoId: VideoId): Promise<Blob | null> {
      const stored = await getStoredVideo(videoId)
      return stored?.blob ?? null
    },

    async putThumbBlob(videoId: VideoId, blob: Blob): Promise<void> {
      await saveThumbnailBlob(videoId, blob)
    },

    async getThumbBlob(videoId: VideoId): Promise<Blob | null> {
      const stored = await getStoredThumbnail(videoId)
      return stored?.blob ?? null
    },
  }
}
