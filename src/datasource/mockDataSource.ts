import { getCaptions as loadCaptions, saveCaptions as persistCaptions } from '@/lib/captionStore'
import {
  deleteVideoAssets,
  getThumbnailBlob as getStoredThumbnail,
  getVideoBlob as getStoredVideo,
  listVideoRecords,
  saveThumbnailBlob,
  saveVideoBlob,
  saveVideoRecord,
} from '@/lib/localAssetStore'

import { seededVideos } from './fixtures'

import type { Caption, CreateVideoInput, DataSource, Video, VideoId } from './types'

export function createMockDataSource(): DataSource {
  const videosById = new Map<VideoId, Video>()
  const videoBlobKeyById = new Map<VideoId, string>()
  for (const v of seededVideos) videosById.set(v.id, v)
  for (const v of seededVideos) videoBlobKeyById.set(v.id, v.id)

  let seq = 1
  const nextId = () => `v_mock_${String(seq++).padStart(4, '0')}`

  let hydratePromise: Promise<void> | null = null

  const ensureHydrated = async () => {
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      try {
        const records = await listVideoRecords()
        for (const record of records) {
          if (videosById.has(record.id)) continue
          const video: Video = {
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            durationMs: record.durationMs,
            width: record.width,
            height: record.height,
          }
          videosById.set(video.id, video)
          videoBlobKeyById.set(video.id, record.videoBlobKey ?? video.id)
        }
      } catch (error) {
        // IndexedDB 문제로 앱 전체가 죽지 않게: seed만이라도 동작하게 둔다.
        console.warn('[mock-datasource] failed to rehydrate videos from IndexedDB', error)
      }
    })()
    return hydratePromise
  }

  return {
    async listVideos(): Promise<Video[]> {
      await ensureHydrated()
      return Array.from(videosById.values()).sort((a, b) => b.createdAt - a.createdAt)
    },

    async getVideo(id: VideoId): Promise<Video | null> {
      await ensureHydrated()
      return videosById.get(id) ?? null
    },

    async createVideo(input: CreateVideoInput): Promise<Video> {
      await ensureHydrated()
      const now = input.createdAt ?? Date.now()
      const v: Video = {
        id: input.id ?? nextId(),
        title: input.title,
        createdAt: now,
        durationMs: input.durationMs,
        width: input.width,
        height: input.height,
      }
      videosById.set(v.id, v)
      videoBlobKeyById.set(v.id, v.id)
      await saveVideoRecord({ ...v, videoBlobKey: v.id })
      return v
    },

    async deleteVideo(id: VideoId): Promise<void> {
      await ensureHydrated()
      videosById.delete(id)
      videoBlobKeyById.delete(id)
      await deleteVideoAssets(id)
    },

    async updateVideoMetadata(
      id: VideoId,
      meta: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>>,
    ): Promise<void> {
      await ensureHydrated()
      const prev = videosById.get(id)
      if (!prev) return

      const next: Video = {
        ...prev,
        ...(typeof meta.durationMs === 'number' ? { durationMs: meta.durationMs } : null),
        ...(typeof meta.width === 'number' ? { width: meta.width } : null),
        ...(typeof meta.height === 'number' ? { height: meta.height } : null),
      }
      videosById.set(id, next)
      const videoBlobKey = videoBlobKeyById.get(id) ?? id
      await saveVideoRecord({ ...next, videoBlobKey })
    },

    async listCaptions(videoId: VideoId): Promise<Caption[]> {
      return loadCaptions(videoId)
    },

    async saveCaptions(videoId: VideoId, captions: Caption[]): Promise<void> {
      await persistCaptions(videoId, captions)
    },

    async putVideoBlob(videoId: VideoId, blob: Blob): Promise<void> {
      await ensureHydrated()
      videoBlobKeyById.set(videoId, videoId)
      const createdAt = videosById.get(videoId)?.createdAt
      await saveVideoBlob(videoId, blob, createdAt)
    },

    async getVideoBlob(videoId: VideoId): Promise<Blob | null> {
      await ensureHydrated()
      const blobKey = videoBlobKeyById.get(videoId) ?? videoId
      const stored = await getStoredVideo(blobKey)
      return stored?.blob ?? null
    },

    async putThumbBlob(videoId: VideoId, blob: Blob): Promise<void> {
      await ensureHydrated()
      const blobKey = videoBlobKeyById.get(videoId) ?? videoId
      videoBlobKeyById.set(videoId, blobKey)
      const createdAt = videosById.get(videoId)?.createdAt
      await saveThumbnailBlob(blobKey, blob, createdAt)
    },

    async getThumbBlob(videoId: VideoId): Promise<Blob | null> {
      await ensureHydrated()
      const blobKey = videoBlobKeyById.get(videoId) ?? videoId
      const stored = await getStoredThumbnail(blobKey)
      return stored?.blob ?? null
    },
  }
}
