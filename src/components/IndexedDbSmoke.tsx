import { useEffect } from "react";

import {
  getThumbnailBlob,
  getVideoBlob,
  saveThumbnailBlob,
  saveVideoBlob,
} from "@/lib/localAssetStore";

const SMOKE_VIDEO_ID = "smoke-video-upload";
const SMOKE_THUMBNAIL_ID = "smoke-thumbnail-upload";

export function IndexedDbSmoke() {
  useEffect(() => {
    // 임시 검증 목적: DEV에서만
    if (!import.meta.env.DEV) return;
    if (typeof window === "undefined") return;
    if (!("indexedDB" in window)) {
      console.warn("[idb smoke] indexedDB is not available in this environment");
      return;
    }

    const runSmoke = async () => {
      try {
        const existingVideo = await getVideoBlob(SMOKE_VIDEO_ID);
        const existingThumbnail = await getThumbnailBlob(SMOKE_THUMBNAIL_ID);

        if (existingVideo) {
          console.info(
            "[idb smoke] Retrieved existing video blob",
            existingVideo.blob.type,
            `${existingVideo.blob.size} bytes`,
          );
        }

        if (existingThumbnail) {
          console.info(
            "[idb smoke] Retrieved existing thumbnail blob",
            existingThumbnail.blob.type,
            `${existingThumbnail.blob.size} bytes`,
          );
        }

        if (!existingVideo) {
          const sampleVideo = new Blob([`video-payload-${Date.now()}`], { type: "text/plain" });
          await saveVideoBlob(SMOKE_VIDEO_ID, sampleVideo);
          console.info("[idb smoke] Saved video blob", sampleVideo.type, sampleVideo.size);
        }

        if (!existingThumbnail) {
          const sampleThumbnail = new Blob([`thumb-payload-${Date.now()}`], { type: "text/plain" });
          await saveThumbnailBlob(SMOKE_THUMBNAIL_ID, sampleThumbnail);
          console.info(
            "[idb smoke] Saved thumbnail blob",
            sampleThumbnail.type,
            sampleThumbnail.size,
          );
        }

        const fetchedVideo = await getVideoBlob(SMOKE_VIDEO_ID);
        const fetchedThumbnail = await getThumbnailBlob(SMOKE_THUMBNAIL_ID);

        console.info(
          "[idb smoke] Fetch after put",
          fetchedVideo?.blob.size,
          fetchedThumbnail?.blob.size,
        );
      } catch (error) {
        console.error("[idb smoke] Smoke test failed", error);
      }
    };

    void runSmoke();
  }, []);

  return null;
}
