/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';

export type TrimWorkerRequest = {
  type: 'trim';
  requestId: number;
  videoData: ArrayBuffer;
  startMs: number;
  endMs: number;
};

export type TrimWorkerResponse =
  | {
      type: 'progress';
      requestId: number;
      progress?: number; // 0~1
      message?: string;
    }
  | {
      type: 'done';
      requestId: number;
      output: ArrayBuffer;
    }
  | {
      type: 'error';
      requestId: number;
      message: string;
    };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const ffmpeg = new FFmpeg();
let isLoaded = false;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

async function loadFfmpeg(requestIdForLog: number) {
  if (isLoaded) return;

  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

  ctx.postMessage({
    type: 'progress',
    requestId: requestIdForLog,
    progress: 0,
    message: 'ffmpeg.wasm 로딩 중…',
  });

  await withTimeout(
    ffmpeg.load({
      coreURL: `${baseURL}/ffmpeg-core.js`,
      wasmURL: `${baseURL}/ffmpeg-core.wasm`,
    }),
    30_000,
    'ffmpeg-load-timeout',
  );

  isLoaded = true;

  ctx.postMessage({
    type: 'progress',
    requestId: requestIdForLog,
    message: 'ffmpeg.wasm 로딩 완료',
  });
}

ctx.addEventListener('message', async (event: MessageEvent<TrimWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'trim') return;

  const { requestId, videoData } = message;
  const startMs = Math.max(0, Math.min(message.startMs, message.endMs));
  const endMs = Math.max(startMs, Math.max(message.startMs, message.endMs));
  const durationMs = endMs - startMs;

  const progressHandler = ({ progress }: { progress?: number }) => {
    if (typeof progress === 'number') {
      ctx.postMessage({ type: 'progress', requestId, progress });
    }
  };

  const logHandler = ({ message: logMessage }: { message?: string }) => {
    if (!logMessage) return;
    console.log('[ffmpeg-log]:', logMessage);
    ctx.postMessage({ type: 'progress', requestId, message: logMessage });
  };

  try {
    if (durationMs <= 0) throw new Error('invalid-trim-range');

    ctx.postMessage({
      type: 'progress',
      requestId,
      message: `trim-range(ms): ${Math.round(startMs)}~${Math.round(endMs)} (dur ${Math.round(durationMs)}ms)`,
    });

    await loadFfmpeg(requestId);

    ffmpeg.on('progress', progressHandler);
    ffmpeg.on('log', logHandler);

    const inputFile = `input_${requestId}.mp4`;
    const outputFile = `output_${requestId}.mp4`;

    await ffmpeg.writeFile(inputFile, new Uint8Array(videoData));

    const startSeconds = (startMs / 1000).toFixed(3);
    const durationSeconds = (durationMs / 1000).toFixed(3);

    const runEncode = async (videoCodecArgs: string[]) => {
      await ffmpeg.exec([
        '-i',
        inputFile,
        '-ss',
        startSeconds,
        '-t',
        durationSeconds,
        ...videoCodecArgs,
        '-c:a',
        'aac',
        '-movflags',
        'faststart',
        outputFile,
      ]);
    };

    try {
      await runEncode(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']);
    } catch {
      ctx.postMessage({
        type: 'progress',
        requestId,
        message: 'libx264 인코더를 사용할 수 없어 mpeg4로 재시도합니다.',
      });
      await runEncode(['-c:v', 'mpeg4', '-q:v', '5']);
    }

    const out = await ffmpeg.readFile(outputFile);
    const outBytes = out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
    const payload = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength);

    ctx.postMessage({ type: 'done', requestId, output: payload }, [payload]);

    for (const file of [inputFile, outputFile]) {
      try {
        await ffmpeg.deleteFile(file);
      } catch {
        // ignore
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.postMessage({ type: 'error', requestId, message: msg });
  } finally {
    ffmpeg.off?.('progress', progressHandler);
    ffmpeg.off?.('log', logHandler);
  }
});
