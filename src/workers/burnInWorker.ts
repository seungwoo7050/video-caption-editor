/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';

export type BurnInWorkerRequest = {
  type: 'burn-in';
  requestId: number;
  videoData: ArrayBuffer;
  srtText: string;
  fontUrl: string;
};

export type BurnInWorkerResponse =
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

async function fetchAsUint8(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch-failed:${res.status}:${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFfmpeg(requestIdForLog: number) {
  if (isLoaded) return;

  // @ffmpeg/ffmpeg(0.12.10)과 core 버전 맞추기
  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

  ctx.postMessage({
    type: 'progress',
    requestId: requestIdForLog,
    progress: 0,
    message: 'ffmpeg.wasm 로딩 중…',
  });

  await withTimeout(
    ffmpeg.load({
      // jsDelivr는 CORS OK라 direct URL로 로드(Blob URL 변환 안 함)
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

ctx.addEventListener('message', async (event: MessageEvent<BurnInWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'burn-in') return;

  const { requestId, videoData, srtText, fontUrl } = message;

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
    await loadFfmpeg(requestId);

    ffmpeg.on('progress', progressHandler);
    ffmpeg.on('log', logHandler);

    const inputFile = `input_${requestId}.mp4`;
    const subtitleFile = `captions_${requestId}.srt`;
    const fontFile = 'NotoSansKR-Regular.ttf';
    const outputFile = `output_${requestId}.mp4`;

    // 입력 파일 기록
    await ffmpeg.writeFile(inputFile, new Uint8Array(videoData));
    await ffmpeg.writeFile(subtitleFile, srtText);

    // 폰트(선택): 실패해도 계속 진행(단, 한글은 깨질 수 있음)
    let hasFont = false;
    try {
      const fontData = await fetchAsUint8(fontUrl);
      if (fontData.byteLength > 0) {
        await ffmpeg.writeFile(fontFile, fontData);
        hasFont = true;
      }
    } catch {
      ctx.postMessage({
        type: 'progress',
        requestId,
        message: '폰트를 불러오지 못해 기본 폰트로 진행합니다.',
      });
      hasFont = false;
    }

    // subtitles 필터
    // force_style 내부에 콤마(,)가 있으므로 반드시 따옴표로 감싸야 함.
    const style = hasFont
      ? 'FontName=Noto Sans KR,OutlineColour=&H22000000,BorderStyle=1,Shadow=0,BackColour=&H22000000,MarginV=32'
      : 'OutlineColour=&H22000000,BorderStyle=1,Shadow=0,BackColour=&H22000000,MarginV=32';

    const filter = `subtitles=${subtitleFile}:fontsdir=.:force_style='${style}'`;

    const runEncode = async (videoCodecArgs: string[]) => {
      await ffmpeg.exec([
        '-i',
        inputFile,
        '-vf',
        filter,
        ...videoCodecArgs,
        '-c:a',
        'aac',
        '-movflags',
        'faststart',
        outputFile,
      ]);
    };

    // 인코더 폴백
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

    // 결과 반환
    const out = await ffmpeg.readFile(outputFile);
    const outBytes = out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
    const payload = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength);

    ctx.postMessage({ type: 'done', requestId, output: payload }, [payload]);

    // 정리
    for (const file of [inputFile, subtitleFile, outputFile]) {
      try {
        await ffmpeg.deleteFile(file);
      } catch {
        // ignore
      }
    }
    if (hasFont) {
      try {
        await ffmpeg.deleteFile(fontFile);
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
