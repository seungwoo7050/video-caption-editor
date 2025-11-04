export async function captureThumbnailFromFile(file: File, atSeconds = 0.5): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    const TIMEOUT_MS = 8000;
    let timeoutId: number | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      video.removeEventListener('error', onError);
      video.removeEventListener('seeked', onSeeked as EventListener);
      video.removeEventListener('loadedmetadata', onLoadedMetadata as EventListener);
      video.removeEventListener('loadeddata', onLoadedData as EventListener);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const handleError = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    const onSeeked = () => {
      const width = video.videoWidth || 320;
      const height = video.videoHeight || 180;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext('2d');
      if (!context) {
        handleError('썸네일 캔버스를 준비하지 못했어요.');
        return;
      }

      context.drawImage(video, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            handleError('썸네일 Blob을 만들지 못했어요.');
            return;
          }
          if (settled) return;
          settled = true;
          cleanup();
          resolve(blob);
        },
        'image/jpeg',
        0.92,
      );
    };

    const seekToSafeTime = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : undefined;
      const safeTime = duration ? Math.min(atSeconds, Math.max(0, duration - 0.05)) : atSeconds;
      
      try {
        video.currentTime = safeTime;
      } catch {
        handleError('썸네일 캡처를 위해 탐색(seek)하지 못했어요.');
      }
    };

    const onLoadedData = () => {
      seekToSafeTime();
    };

    const onLoadedMetadata = () => {
      if (video.readyState >= 2) {
        seekToSafeTime();
        return;
      }
      video.addEventListener('loadeddata', onLoadedData, { once: true });
    };

    const onError = () => handleError('비디오를 불러오지 못했어요.');

    timeoutId = window.setTimeout(() => {
      handleError('썸네일 생성 시간이 초과됐어요.');
    }, TIMEOUT_MS);

    video.addEventListener('error', onError, { once: true });
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });

    video.src = objectUrl;
    video.load();
  });
}