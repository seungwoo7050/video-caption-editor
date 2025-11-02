import type { Caption, CreateVideoInput, DataSource, Video, VideoId } from './types'

export function createMockDataSource(): DataSource {
  return {
    async listVideos(): Promise<Video[]> {
      return []
    },

    async getVideo(_id: VideoId): Promise<Video | null> {
      void _id
      return null
    },

    async createVideo(input: CreateVideoInput): Promise<Video> {
      const now = Date.now()
      return {
        id: `mock_${now}`,
        title: input.title,
        createdAt: now,
      }
    },

    async deleteVideo(_id: VideoId): Promise<void> {
      void _id
    },

    async listCaptions(_videoId: VideoId): Promise<Caption[]> {
      void _videoId
      return []
    },

    async saveCaptions(_videoId: VideoId, _captions: Caption[]): Promise<void> {
      void _videoId
      void _captions
    },

    async putVideoBlob(_videoId: VideoId, _blob: Blob): Promise<void> {
      void _videoId
      void _blob
    },

    async getVideoBlob(_videoId: VideoId): Promise<Blob | null> {
      void _videoId
      return null
    },

    async putThumbBlob(_videoId: VideoId, _blob: Blob): Promise<void> {
      void _blob
      void _videoId
    },

    async getThumbBlob(_videoId: VideoId): Promise<Blob | null> {
      void _videoId
      return null
    },
  }
}
