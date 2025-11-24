import Dexie, { type Table } from 'dexie'

export type StoredBlob = {
  id: string
  blob: Blob
  createdAt: number
  updatedAt: number
}

export type StoredVideoRecord = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  videoBlobKey: string
  durationMs?: number
  width?: number
  height?: number
}

class LocalAssetDatabase extends Dexie {
  videos!: Table<StoredBlob, string>
  thumbnails!: Table<StoredBlob, string>
  videoRecords!: Table<StoredVideoRecord, string>

  constructor() {
    super('video-caption-editor-assets')

    this.version(1).stores({
      videos: 'id,updatedAt,createdAt',
      thumbnails: 'id,updatedAt,createdAt',
    })

    this.version(2).stores({
      videos: 'id,updatedAt,createdAt',
      thumbnails: 'id,updatedAt,createdAt',
      videoRecords: 'id,updatedAt,createdAt',
    })
  }
}

const db = new LocalAssetDatabase()

type StoreKey = 'videos' | 'thumbnails'

function normalizeVideoRecord(record: StoredVideoRecord): StoredVideoRecord {
  return {
    ...record,
    videoBlobKey: record.videoBlobKey || record.id,
  }
}

async function upsertBlob(tableKey: StoreKey, id: string, blob: Blob, createdAt?: number) {
  const table = db[tableKey]
  const existing = await table.get(id)
  const timestamp = Date.now()
  const fallbackCreatedAt = createdAt ?? timestamp

  await table.put({
    id,
    blob,
    createdAt: existing?.createdAt ?? fallbackCreatedAt,
    updatedAt: timestamp,
  })
}

async function fetchBlob(tableKey: StoreKey, id: string): Promise<StoredBlob | undefined> {
  return db[tableKey].get(id)
}

export async function saveVideoBlob(id: string, blob: Blob, createdAt?: number) {
  await upsertBlob('videos', id, blob, createdAt)
}

export async function saveThumbnailBlob(id: string, blob: Blob, createdAt?: number) {
  await upsertBlob('thumbnails', id, blob, createdAt)
}

export async function getVideoBlob(id: string): Promise<StoredBlob | undefined> {
  return fetchBlob('videos', id)
}

export async function getThumbnailBlob(id: string): Promise<StoredBlob | undefined> {
  return fetchBlob('thumbnails', id)
}

export async function saveVideoRecord(record: Omit<StoredVideoRecord, 'updatedAt'>) {
  const normalized = normalizeVideoRecord({ ...record, updatedAt: record.createdAt })
  const existing = await db.videoRecords.get(normalized.id)
  const timestamp = Date.now()
  const createdAt = existing?.createdAt ?? normalized.createdAt ?? timestamp

  await db.videoRecords.put({
    ...normalized,
    createdAt,
    updatedAt: timestamp,
  })
}

export async function getVideoRecord(id: string): Promise<StoredVideoRecord | undefined> {
  const record = await db.videoRecords.get(id)
  return record ? normalizeVideoRecord(record) : undefined
}

export async function listVideoRecords(): Promise<StoredVideoRecord[]> {
  const records = await db.videoRecords.toArray()
  return records.map(normalizeVideoRecord)
}

export async function deleteVideoAssets(id: string) {
  const record = await db.videoRecords.get(id)
  const blobKey = record?.videoBlobKey ?? id

  await db.transaction('rw', db.videos, db.thumbnails, db.videoRecords, async () => {
    await db.videoRecords.delete(id)
    await db.videos.delete(blobKey)
    await db.thumbnails.delete(blobKey)
  })
}

export async function saveVideoAssetsAtomically(params: {
  record: Omit<StoredVideoRecord, 'updatedAt'>
  videoBlob: Blob
  thumbnailBlob?: Blob
}) {
  const normalizedRecord = normalizeVideoRecord({ ...params.record, updatedAt: params.record.createdAt })
  const now = Date.now()

  await db.transaction('rw', db.videos, db.thumbnails, db.videoRecords, async () => {
    const existingRecord = await db.videoRecords.get(normalizedRecord.id)
    const createdAt = existingRecord?.createdAt ?? normalizedRecord.createdAt ?? now

    await db.videos.put({
      id: normalizedRecord.videoBlobKey,
      blob: params.videoBlob,
      createdAt,
      updatedAt: now,
    })

    if (params.thumbnailBlob) {
      await db.thumbnails.put({
        id: normalizedRecord.videoBlobKey,
        blob: params.thumbnailBlob,
        createdAt,
        updatedAt: now,
      })
    }

    await db.videoRecords.put({
      ...normalizedRecord,
      createdAt,
      updatedAt: now,
    })
  })
}
