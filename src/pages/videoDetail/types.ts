import type { Caption as DataCaption, Video as DataVideo } from '@/datasource/types';
import type { WaveformWorkerRequest } from '@/workers/waveformWorker';

export type Caption = DataCaption;
export type Video = DataVideo;

export type CaptionErrors = {
  startMs?: string;
  endMs?: string;
  text?: string;
};

export type HotkeyConfig = {
  togglePlay: string;
  setStart: string;
  setEnd: string;
  confirm: string;
};

export type TrimRange = {
  startMs: number;
  endMs: number;
};

export type Viewport = {
  startMs: number;
  endMs: number;
};

export type WaveformRasterCacheEntry = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  bytes: number;
  rasterWidth: number;
};

export type WebglResources = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  texCoordBuffer: WebGLBuffer;
  texture: WebGLTexture;
  attributes: {
    position: number;
    texCoord: number;
  };
  uniforms: {
    texture: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    grayscale: WebGLUniformLocation | null;
  };
};

export type WaveformWorkerPayload =
  | Omit<Extract<WaveformWorkerRequest, { type: 'load-samples' }>, 'requestId'>
  | Omit<Extract<WaveformWorkerRequest, { type: 'compute-peaks' }>, 'requestId'>;
