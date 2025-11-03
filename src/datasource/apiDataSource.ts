import type { Caption, CreateVideoInput, DataSource, Video, VideoId } from './types'
import type { VideoMetadataPatch } from './types';


export function createApiDataSource(): DataSource {
  return {
    async listVideos(): Promise<Video[]> {
      throw new Error('API datasource not implemented yet')
    },

    async getVideo(_id: VideoId): Promise<Video | null> {
      void _id
      throw new Error('API datasource not implemented yet')
    },

    async createVideo(_input: CreateVideoInput): Promise<Video> {
      void _input
      throw new Error('API datasource not implemented yet')
    },

    async deleteVideo(_id: VideoId): Promise<void> {
      void _id
      throw new Error('API datasource not implemented yet')
    },

    async listCaptions(_videoId: VideoId): Promise<Caption[]> {
      void _videoId
      throw new Error('API datasource not implemented yet')
    },

    async saveCaptions(_videoId: VideoId, _captions: Caption[]): Promise<void> {
      void _videoId
      void _captions
      throw new Error('API datasource not implemented yet')
    },

    async putVideoBlob(_videoId: VideoId, _blob: Blob): Promise<void> {
      void _videoId
      void _blob
      throw new Error('API datasource not implemented yet')
    },

    async getVideoBlob(_videoId: VideoId): Promise<Blob | null> {
      void _videoId
      throw new Error('API datasource not implemented yet')
    },

    async putThumbBlob(_videoId: VideoId, _blob: Blob): Promise<void> {
      void _videoId
      void _blob
      throw new Error('API datasource not implemented yet')
    },

    async getThumbBlob(_videoId: VideoId): Promise<Blob | null> {
      void _videoId
      throw new Error('API datasource not implemented yet')
    },

    async updateVideoMetadata(_id: string, _patch: VideoMetadataPatch): Promise<void> {
      void _id;
      void _patch;
    },
  }
}
