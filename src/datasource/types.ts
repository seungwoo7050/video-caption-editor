export type VideoId = string
export type CaptionId = string

export type Video = {
  id: VideoId
  title: string
  createdAt: number
  durationMs?: number
  width?: number
  height?: number
}

export type Caption = {
  id: CaptionId
  startMs: number
  endMs: number
  text: string
}

export type CreateVideoInput = {
  title: string
}

export type DataSource = {
  listVideos(): Promise<Video[]>
  getVideo(id: VideoId): Promise<Video | null>
  createVideo(input: CreateVideoInput): Promise<Video>
  deleteVideo(id: VideoId): Promise<void>

  listCaptions(videoId: VideoId): Promise<Caption[]>
  saveCaptions(videoId: VideoId, captions: Caption[]): Promise<void>

  putVideoBlob(videoId: VideoId, blob: Blob): Promise<void>
  getVideoBlob(videoId: VideoId): Promise<Blob | null>
  putThumbBlob(videoId: VideoId, blob: Blob): Promise<void>
  getThumbBlob(videoId: VideoId): Promise<Blob | null>
}

export type DataSourceKind = 'mock' | 'api'
