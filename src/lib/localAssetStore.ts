import Dexie from 'dexie'

import type { Table } from 'dexie';

export type StoredBlob = {
  id: string;
  blob: Blob;
  createdAt: number;
  updatedAt: number;
};

class LocalAssetDatabase extends Dexie {
  videos!: Table<StoredBlob, string>;
  thumbnails!: Table<StoredBlob, string>;

  constructor() {
    super('video-caption-editor-assets');

    this.version(1).stores({
      videos: 'id,updatedAt,createdAt',
      thumbnails: 'id,updatedAt,createdAt',
    });
  }
}

const db = new LocalAssetDatabase();

type StoreKey = 'videos' | 'thumbnails';

async function upsertBlob(tableKey: StoreKey, id: string, blob: Blob) {
  const table = db[tableKey];
  const existing = await table.get(id);
  const timestamp = Date.now();

  await table.put({
    id,
    blob,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
}

async function fetchBlob(tableKey: StoreKey, id: string): Promise<StoredBlob | undefined> {
  return db[tableKey].get(id);
}

export async function saveVideoBlob(id: string, blob: Blob) {
  await upsertBlob('videos', id, blob);
}

export async function saveThumbnailBlob(id: string, blob: Blob) {
  await upsertBlob('thumbnails', id, blob);
}

export async function getVideoBlob(id: string): Promise<StoredBlob | undefined> {
  return fetchBlob('videos', id);
}

export async function getThumbnailBlob(id: string): Promise<StoredBlob | undefined> {
  return fetchBlob('thumbnails', id);
}
