import Dexie, { type Table } from 'dexie'

import type { Caption } from '@/datasource/types'

const DB_NAME = 'video-caption-editor-captions'
const TABLE_CAPTIONS = 'captions'

type StoredCaptions = {
  videoId: string
  captions: Caption[]
  createdAt: number
  updatedAt: number
}

class CaptionDatabase extends Dexie {
  captions!: Table<StoredCaptions, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      [TABLE_CAPTIONS]: 'videoId,updatedAt,createdAt',
    })
  }
}

const db = new CaptionDatabase()

function assertIndexedDbAvailable() {
  if (typeof indexedDB === 'undefined') {
    throw new Error('Caption store requires IndexedDB, but indexedDB is not available in this environment.')
  }
}

class CaptionStoreError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CaptionStoreError'
    this.cause = cause
  }
}

export async function saveCaptions(videoId: string, captions: Caption[]) {
  assertIndexedDbAvailable()
  try {
    const existing = await db.captions.get(videoId)
    const timestamp = Date.now()

    await db.captions.put({
      videoId,
      captions,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
  } catch (err) {
    throw new CaptionStoreError(`Failed to save captions for videoId=${videoId}`, err)
  }
}

export async function getCaptions(videoId: string): Promise<Caption[]> {
  assertIndexedDbAvailable()
  try {
    const stored = await db.captions.get(videoId)
    return stored?.captions ?? []
  } catch (err) {
    throw new CaptionStoreError(`Failed to load captions for videoId=${videoId}`, err)
  }
}

export async function __devCaptionStoreSmoke(videoId: string, captions: Caption[]) {
  if (!import.meta.env.DEV) return
  await saveCaptions(videoId, captions)
  return getCaptions(videoId)
}
