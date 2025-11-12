import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { dataSource } from '@/datasource';
import { dataSourceKind } from '@/datasource';
import type { Caption, Video } from '@/datasource/types';
import { getActiveCaptionAtMs } from '@/lib/captionActive';
import { captionsToSrt, downloadTextFile, parseCaptionsFromJson, serializeCaptionsToJson } from '@/lib/captionIO';
import { queryClient } from '@/lib/queryClient';
import type { BurnInWorkerResponse } from '@/workers/burnInWorker';
import type { WaveformWorkerRequest, WaveformWorkerResponse } from '@/workers/waveformWorker';

import type { ChangeEvent, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';

import './VideoDetailPage.css';

function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

function formatMeta(video: Video) {
  const duration =
    typeof video.durationMs === 'number'
      ? `${Math.round(video.durationMs / 1000)}s`
      : null;
  const resolution =
    typeof video.width === 'number' && typeof video.height === 'number'
      ? `${video.width}x${video.height}`
      : null;

  return [duration, resolution].filter(Boolean).join(' · ');
}

type CaptionErrors = {
  startMs?: string;
  endMs?: string;
  text?: string;
};

function sortCaptions(captions: Caption[]) {
  return [...captions].sort((a, b) => {
    const aStart = Number.isFinite(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
    const bStart = Number.isFinite(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });
}

function getLastValidEndMs(captions: Caption[]) {
  for (let i = captions.length - 1; i >= 0; i -= 1) {
    const endMs = captions[i]?.endMs;
    if (Number.isFinite(endMs)) return endMs as number;
  }
  return 0;
}

function createCaptionId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `caption_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function snapToStep(ms: number, stepMs: number) {
  if (!Number.isFinite(ms) || stepMs <= 0) return ms;
  return Math.round(ms / stepMs) * stepMs;
}

function formatTimestamp(ms: number) {
  if (!Number.isFinite(ms)) return '--:--.---';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  const milliseconds = Math.abs(ms % 1000)
    .toString()
    .padStart(3, '0');
  return `${minutes}:${seconds}.${milliseconds}`;
}

function sanitizeForFileName(text: string, fallback: string) {
  const safe = text.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function formatNowForFileName(now = new Date()) {
  const yyyy = now.getFullYear().toString();
  const MM = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

type WebglResources = {
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

function getCaptionErrors(caption: Caption): CaptionErrors {
  const errors: CaptionErrors = {};
  const hasStart = Number.isFinite(caption.startMs);
  const hasEnd = Number.isFinite(caption.endMs);

  if (!hasStart) errors.startMs = '시작 시간을 입력하세요.';
  if (!hasEnd) errors.endMs = '종료 시간을 입력하세요.';

  if (hasStart && hasEnd && caption.startMs >= caption.endMs) {
    errors.endMs = '종료 시간은 시작 시간보다 커야 해요.';
  }

  if (!caption.text.trim()) {
    errors.text = '자막 내용을 입력하세요.';
  }

  return errors;
}

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const videoId = id ?? '';
  const [appliedMetadataForId, setAppliedMetadataForId] = useState<string | null>(null);

  const [captionDrafts, setCaptionDrafts] = useState<Caption[]>([]);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [trimRange, setTrimRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [applyTrimOnExport, setApplyTrimOnExport] = useState(false);
  const [snapStepMs, setSnapStepMs] = useState<100 | 1000>(100);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const trimRangeRef = useRef<{ startMs: number; endMs: number } | null>(null);
  const [dragTarget, setDragTarget] = useState<'start' | 'end' | 'new' | null>(null);

  const {
    data: video,
    isPending: isVideoLoading,
    isError: isVideoError,
  } = useQuery({
    queryKey: ['video', videoId],
    enabled: Boolean(videoId),
    queryFn: async () => {
      const fetched = await dataSource.getVideo(videoId);
      if (!fetched) throw new Error('비디오 정보를 찾을 수 없어요.');
      return fetched;
    },
  });

  const hasExistingMetadata = Boolean(
    video &&
      (typeof video.durationMs === 'number' ||
        typeof video.width === 'number' ||
        typeof video.height === 'number'),
  );
  const hasAppliedMetadata = appliedMetadataForId === videoId;
  const isMetadataReady = hasAppliedMetadata || hasExistingMetadata;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglContainerRef = useRef<HTMLDivElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const waveformDataRef = useRef<Uint8Array | null>(null);
  const waveformRafIdRef = useRef<number | null>(null);
  const waveformWorkerRef = useRef<Worker | null>(null);
  const waveformWorkerResolversRef = useRef<Map<number, (response: WaveformWorkerResponse) => void>>(new Map());
  const waveformRequestIdRef = useRef(0);
  const waveformSamplesReadyRef = useRef(false);
  const waveformOverviewPeaksRef = useRef<Int16Array | null>(null);
  const waveformBucketCountRef = useRef<number | null>(null);
  const waveformPendingBucketRef = useRef<number | null>(null);
  const waveformComputeTimeoutRef = useRef<number | null>(null);
  const waveformComputeTokenRef = useRef<number>(0);
  const waveformLastComputeAtRef = useRef<number>(0);
  const waveformModeRef = useRef<'overview' | 'live' | 'loading'>('loading');
  const currentTimeMsRef = useRef<number | null>(null);
  const captionRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState<number | null>(null);
  const [lastFocusedCaptionId, setLastFocusedCaptionId] = useState<string | null>(null);
  const [shouldUseLiveWaveform, setShouldUseLiveWaveform] = useState(false);
  const videoFrameRequestIdRef = useRef<number | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const webglResourcesRef = useRef<WebglResources | null>(null);
  const webglVideoFrameRequestIdRef = useRef<number | null>(null);
  const webglAnimationFrameIdRef = useRef<number | null>(null);
  const [isWebglSupported, setIsWebglSupported] = useState(true);
  const [isWebglReady, setIsWebglReady] = useState(false);
  const [isGrayscale, setIsGrayscale] = useState(false);
  const burnInWorkerRef = useRef<Worker | null>(null);
  const [isBurningIn, setIsBurningIn] = useState(false);
  const [burnInProgress, setBurnInProgress] = useState<number | null>(null);
  const [burnInMessage, setBurnInMessage] = useState<string | null>(null);
  const [burnInError, setBurnInError] = useState<string | null>(null);
  const [burnInResultUrl, setBurnInResultUrl] = useState<string | null>(null);
  const [burnInFileName, setBurnInFileName] = useState<string | null>(null);

  const {
    data: videoBlob,
    error: videoBlobError,
    isPending: isBlobLoading,
  } = useQuery({
    queryKey: ['video-blob', videoId],
    enabled: Boolean(videoId),
    queryFn: async () => {
      const blob = await dataSource.getVideoBlob(videoId);
      if (!blob) throw new Error('영상 파일을 불러올 수 없어요.');
      return blob;
    },
  });

  const {
    data: thumbnailBlob,
    error: thumbnailBlobError,
    isPending: isThumbLoading,
  } = useQuery({
    queryKey: ['thumbnail-blob', videoId],
    enabled: Boolean(videoId),
    queryFn: () => dataSource.getThumbBlob(videoId),
  });  

  const videoUrl = useMemo(() => {
    if (!videoBlob) return null;
    return URL.createObjectURL(videoBlob);
  }, [videoBlob]);

  const activeCaption = useMemo(() => {
    return getActiveCaptionAtMs(captionDrafts, currentTimeMs ?? Number.NaN);
  }, [captionDrafts, currentTimeMs]);

  const activeCaptionId = activeCaption?.id ?? null;

  const activeCaptionText = useMemo(() => {
    const text = activeCaption?.text.trim();
    return text ? text : null;
  }, [activeCaption]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const thumbnailUrl = useMemo(() => {
    if (!thumbnailBlob) return null;
    return URL.createObjectURL(thumbnailBlob);
  }, [thumbnailBlob]);

  useEffect(() => {
    return () => {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
  }, [thumbnailUrl]);

  useEffect(() => {
    return () => {
      if (burnInResultUrl) {
        URL.revokeObjectURL(burnInResultUrl);
      }
      const worker = burnInWorkerRef.current;
      if (worker) worker.terminate();
    };
  }, [burnInResultUrl]);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/waveformWorker.ts', import.meta.url), {
      type: 'module',
    });

    waveformWorkerRef.current = worker;
    const resolverMap = waveformWorkerResolversRef.current;

    const handleMessage = (event: MessageEvent<WaveformWorkerResponse>) => {
      const { requestId } = event.data ?? {};
      if (typeof requestId !== 'number') return;
      const resolver = resolverMap.get(requestId);
      if (resolver) {
        resolver(event.data);
        resolverMap.delete(requestId);
      }
    };

    const handleError = (errorEvent: ErrorEvent) => {
      console.error('[waveform] worker error', errorEvent);
      resolverMap.forEach((resolver, requestId) => {
        resolver({ type: 'error', requestId, message: 'worker-error' });
      });
      resolverMap.clear();
      setShouldUseLiveWaveform(true);
      waveformModeRef.current = 'live';
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      worker.terminate();
      resolverMap.clear();
      waveformWorkerRef.current = null;
    };
  }, []);

  const {
    data: captions,
    isPending: isCaptionsLoading,
    isError: isCaptionsError,
    error: captionsError,
  } = useQuery({
    queryKey: ['captions', videoId],
    enabled: Boolean(videoId),
    queryFn: () => dataSource.listCaptions(videoId),
  });

  useEffect(() => {
    if (captions) {

      setCaptionDrafts(sortCaptions(captions));
    }
  }, [captions]);

  const hasCaptionErrors = useMemo(
    () => captionDrafts.some((c) => Object.keys(getCaptionErrors(c)).length > 0),
    [captionDrafts],
  );

  const {
    mutate: persistCaptions,
    isPending: isSavingCaptions,
    isError: isSaveCaptionsError,
    error: saveCaptionsError,
    reset: resetSaveCaptionsError,
  } = useMutation({
    mutationFn: async (nextCaptions: Caption[]) => {
      const sorted = sortCaptions(nextCaptions);
      await dataSource.saveCaptions(videoId, sorted);
      return sorted;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['captions', videoId], saved);
      setCaptionDrafts(saved);
      setLastSavedAt(Date.now());
    },
  });

  const handleCaptionFieldChange = useCallback(
    (captionId: string, field: keyof Pick<Caption, 'startMs' | 'endMs' | 'text'>, value: string) => {
      resetSaveCaptionsError();
      setImportError(null);
      const nextNumber =
        value.trim() === '' ? Number.NaN : Number(value);
      setCaptionDrafts((prev) =>
        sortCaptions(
          prev.map((caption) =>
            caption.id === captionId
              ? {
                  ...caption,
                  [field]: field === 'text' ? value : nextNumber,
                }
              : caption,
          ),
        ),
      );
    },
    [resetSaveCaptionsError],
  );

  const getCurrentTimeMs = useCallback(() => {
    const video = videoRef.current;
    if (!video) return Number.NaN;

    const currentTimeMs = Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000)
      : Number.NaN;

    return currentTimeMs;
  }, []);

  const updateCurrentTime = useCallback(() => {
    const next = getCurrentTimeMs();
    setCurrentTimeMs(Number.isFinite(next) ? next : null);
  }, [getCurrentTimeMs]);

  useEffect(() => {
    currentTimeMsRef.current = currentTimeMs;
  }, [currentTimeMs]);

  const cancelTimeTracking = useCallback(() => {
    const video = videoRef.current;
    if (video && typeof video.cancelVideoFrameCallback === 'function' && videoFrameRequestIdRef.current !== null) {
      video.cancelVideoFrameCallback(videoFrameRequestIdRef.current);
    }
    if (animationFrameIdRef.current !== null) {
      window.cancelAnimationFrame(animationFrameIdRef.current);
    }
    videoFrameRequestIdRef.current = null;
    animationFrameIdRef.current = null;
  }, []);

  const stopWebglRenderLoop = useCallback(() => {
    const video = videoRef.current;
    if (video && typeof video.cancelVideoFrameCallback === 'function' && webglVideoFrameRequestIdRef.current !== null) {
      video.cancelVideoFrameCallback(webglVideoFrameRequestIdRef.current);
    }
    if (webglAnimationFrameIdRef.current !== null) {
      window.cancelAnimationFrame(webglAnimationFrameIdRef.current);
    }
    webglVideoFrameRequestIdRef.current = null;
    webglAnimationFrameIdRef.current = null;
  }, []);

  const scheduleTimeTracking = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    cancelTimeTracking();

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = () => {
        updateCurrentTime();
        videoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      };

      videoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      return;
    }

    if (video.paused || video.ended) return;

    const loop = () => {
      updateCurrentTime();
      if (!video.paused && !video.ended) {
        animationFrameIdRef.current = window.requestAnimationFrame(loop);
      } else {
        animationFrameIdRef.current = null;
      }
    };

    animationFrameIdRef.current = window.requestAnimationFrame(loop);
  }, [cancelTimeTracking, updateCurrentTime]);

  const renderWebglFrame = useCallback(() => {
    const resources = webglResourcesRef.current;
    const canvas = webglCanvasRef.current;
    const video = videoRef.current;
    if (!resources || !canvas || !video) return;

    const gl = resources.gl;

    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const videoWidth = video.videoWidth || video.width || 0;
    const videoHeight = video.videoHeight || video.height || 0;
    if (videoWidth === 0 || videoHeight === 0) return;

    const canvasAspect = targetWidth / targetHeight;
    const videoAspect = videoWidth / videoHeight;
    let scaleX = 1;
    let scaleY = 1;
    if (videoAspect > canvasAspect) {
      scaleY = canvasAspect / videoAspect;
    } else {
      scaleX = videoAspect / canvasAspect;
    }

    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(resources.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
    gl.enableVertexAttribArray(resources.attributes.position);
    gl.vertexAttribPointer(resources.attributes.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, resources.texCoordBuffer);
    gl.enableVertexAttribArray(resources.attributes.texCoord);
    gl.vertexAttribPointer(resources.attributes.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      return;
    }

    if (resources.uniforms.texture) gl.uniform1i(resources.uniforms.texture, 0);
    if (resources.uniforms.scale) gl.uniform2f(resources.uniforms.scale, scaleX, scaleY);
    if (resources.uniforms.grayscale) gl.uniform1i(resources.uniforms.grayscale, isGrayscale ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [isGrayscale]);

  const scheduleWebglRenderLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video || !webglResourcesRef.current) return;

    stopWebglRenderLoop();

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = () => {
        renderWebglFrame();
        webglVideoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      };

      webglVideoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      return;
    }

    if (video.paused || video.ended) {
      renderWebglFrame();
      return;
    }

    const loop = () => {
      renderWebglFrame();
      if (!video.paused && !video.ended) {
        webglAnimationFrameIdRef.current = window.requestAnimationFrame(loop);
      } else {
        webglAnimationFrameIdRef.current = null;
      }
    };

    renderWebglFrame();
    webglAnimationFrameIdRef.current = window.requestAnimationFrame(loop);
  }, [renderWebglFrame, stopWebglRenderLoop]);

  const cleanupWebglResources = useCallback(() => {
    stopWebglRenderLoop();
    const resources = webglResourcesRef.current;
    if (!resources) return;

    const { gl, program, positionBuffer, texCoordBuffer, texture } = resources;
    try {
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(texCoordBuffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    } catch (error) {
      console.error('[webgl] cleanup failed', error);
    }

    webglResourcesRef.current = null;
    setIsWebglReady(false);
  }, [stopWebglRenderLoop]);

  const handleAddCaption = useCallback(() => {
    resetSaveCaptionsError();
    setImportError(null);
    const nextCaptionId = createCaptionId();
    const currentTimeMs = getCurrentTimeMs();
    setCaptionDrafts((prev) => {
      const startMs = Number.isFinite(currentTimeMs) ? currentTimeMs : getLastValidEndMs(prev);
      const endMs = startMs + 1000;
      const next = [...prev, { id: nextCaptionId, startMs, endMs, text: '' }];
      return sortCaptions(next);
    });
    setLastFocusedCaptionId(nextCaptionId);
  }, [getCurrentTimeMs, resetSaveCaptionsError]);

  const handleSetCaptionTimeFromVideo = useCallback(
    (captionId: string, field: keyof Pick<Caption, 'startMs' | 'endMs'>) => {
      const currentTimeMs = getCurrentTimeMs();
      if (!Number.isFinite(currentTimeMs)) return;

      handleCaptionFieldChange(captionId, field, currentTimeMs.toString());
      setLastFocusedCaptionId(captionId);
    },
    [getCurrentTimeMs, handleCaptionFieldChange],
  );

  const initWebgl = useCallback(() => {
    cleanupWebglResources();

    const canvas = webglCanvasRef.current;
    const videoElement = videoRef.current;
    if (!canvas || !videoElement || !videoUrl) return;

    setIsWebglSupported(true);

    const gl =
      (canvas.getContext('webgl', { premultipliedAlpha: false }) as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl', { premultipliedAlpha: false }) as
        | WebGLRenderingContext
        | null);
    if (!gl) {
      setIsWebglSupported(false);
      return;
    }

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Failed to create shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Failed to compile shader: ${info ?? 'unknown error'}`);
      }
      return shader;
    };

    const vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      uniform vec2 u_scale;
      void main() {
        vec2 scaled = a_position * u_scale;
        gl_Position = vec4(scaled, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    const fragmentShaderSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_texture;
      uniform bool u_grayscale;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        if (u_grayscale) {
          float g = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(vec3(g), color.a);
        } else {
          gl_FragColor = color;
        }
      }
    `;

    try {
      const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

      const program = gl.createProgram();
      if (!program) throw new Error('Failed to create program');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        throw new Error(`Failed to link program: ${info ?? 'unknown error'}`);
      }

      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      const positionBuffer = gl.createBuffer();
      const texCoordBuffer = gl.createBuffer();
      const texture = gl.createTexture();

      if (!positionBuffer || !texCoordBuffer || !texture) {
        throw new Error('Failed to allocate WebGL buffers');
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1,
          1, -1,
          -1, 1,
          1, 1,
        ]),
        gl.STATIC_DRAW,
      );

      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          0, 1,
          1, 1,
          0, 0,
          1, 0,
        ]),
        gl.STATIC_DRAW,
      );

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      const textureLocation = gl.getUniformLocation(program, 'u_texture');
      const scaleLocation = gl.getUniformLocation(program, 'u_scale');
      const grayscaleLocation = gl.getUniformLocation(program, 'u_grayscale');

      if (positionLocation < 0 || texCoordLocation < 0) {
        throw new Error('Failed to get WebGL attribute locations');
      }

      webglResourcesRef.current = {
        gl,
        program,
        positionBuffer,
        texCoordBuffer,
        texture,
        attributes: {
          position: positionLocation,
          texCoord: texCoordLocation,
        },
        uniforms: {
          texture: textureLocation,
          scale: scaleLocation,
          grayscale: grayscaleLocation,
        },
      };

      gl.useProgram(program);
      if (textureLocation) gl.uniform1i(textureLocation, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );

      setIsWebglReady(true);
      renderWebglFrame();
    } catch (error) {
      console.error('[webgl] init failed', error);
      setIsWebglSupported(false);
      cleanupWebglResources();
    }
  }, [cleanupWebglResources, renderWebglFrame, videoUrl]);

  const baseFileName = useMemo(() => {
    if (!video) return 'captions';
    return sanitizeForFileName(video.title, 'captions');
  }, [video]);

  const safeTitleOrId = useMemo(() => {
    if (video?.title) return sanitizeForFileName(video.title, videoId || 'video');
    if (videoId) return sanitizeForFileName(videoId, 'video');
    return 'video';
  }, [video, videoId]);

  const burnInFontUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URL('/fonts/NotoSansKR-Regular.ttf', window.location.origin).toString();
  }, []);

  const getCaptionsForExport = useCallback(() => {
    if (!applyTrimOnExport || !trimRange) return captionDrafts;

    const { startMs, endMs } = trimRange;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return captionDrafts;

    const trimStart = Math.max(0, Math.min(startMs, endMs));
    const trimEnd = Math.max(trimStart, Math.max(startMs, endMs));
    if (trimEnd <= trimStart) return [];

    const trimmed = captionDrafts
      .filter((caption) => Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs))
      .filter((caption) => caption.endMs > trimStart && caption.startMs < trimEnd)
      .map((caption) => {
        const clippedStart = Math.max(caption.startMs, trimStart);
        const clippedEnd = Math.min(caption.endMs, trimEnd);
        return {
          ...caption,
          startMs: clippedStart - trimStart,
          endMs: clippedEnd - trimStart,
        };
      });
    return sortCaptions(trimmed);
  }, [applyTrimOnExport, captionDrafts, trimRange]);

  const handleExportJson = useCallback(() => {
    const captionsForExport = getCaptionsForExport();
    const json = serializeCaptionsToJson(captionsForExport);
    downloadTextFile(`${baseFileName}.json`, json, 'application/json;charset=utf-8');
  }, [baseFileName, getCaptionsForExport]);

  const handleExportSrt = useCallback(() => {
    const captionsForExport = getCaptionsForExport();
    const srt = captionsToSrt(captionsForExport);
    downloadTextFile(`${baseFileName}.srt`, srt, 'application/x-subrip;charset=utf-8');
  }, [baseFileName, getCaptionsForExport]);

  const stopBurnInWorker = useCallback(() => {
    const worker = burnInWorkerRef.current;
    if (worker) {
      worker.terminate();
      burnInWorkerRef.current = null;
    }
  }, []);

  const handleCancelBurnIn = useCallback(() => {
    stopBurnInWorker();
    setIsBurningIn(false);
    setBurnInProgress(null);
    setBurnInMessage('번인 내보내기를 취소했어요.');
  }, [stopBurnInWorker]);

  const handleBurnInExport = useCallback(async () => {
    if (!videoBlob) {
      setBurnInError('영상 파일을 찾지 못했어요. 다시 시도해 주세요.');
      return;
    }

    if (!burnInFontUrl) {
      setBurnInError('폰트 파일 경로를 준비하지 못했어요.');
      return;
    }

    const mime = videoBlob.type || '';
    if (!mime.includes('mp4')) {
      setBurnInError('mp4 영상만 번인 내보내기를 지원해요.');
      return;
    }

    if (videoBlob.size > 50 * 1024 * 1024) {
      setBurnInError('50MB 이하의 mp4만 번인 내보내기를 지원해요.');
      return;
    }

    if (typeof durationMs === 'number' && durationMs > 30_000) {
      setBurnInError('길이 30초 이하의 영상을 사용해 주세요.');
      return;
    }

    const captionsForExport = getCaptionsForExport();
    const srt = captionsToSrt(captionsForExport);

    stopBurnInWorker();
    if (burnInResultUrl) {
      URL.revokeObjectURL(burnInResultUrl);
      setBurnInResultUrl(null);
    }

    setBurnInError(null);
    setBurnInProgress(0);
    setBurnInMessage('ffmpeg.wasm을 로드하는 중이에요…');
    setIsBurningIn(true);

    const worker = new Worker(new URL('../workers/burnInWorker.ts', import.meta.url), {
      type: 'module',
    });

    burnInWorkerRef.current = worker;
    const requestId = Date.now();

    const fileName = `${safeTitleOrId}_burnin_${formatNowForFileName()}.mp4`;
    setBurnInFileName(fileName);

    function handleError(errorEvent: ErrorEvent) {
      console.error('[burn-in-worker] crashed', errorEvent);
      setBurnInError('번인 작업 중 오류가 발생했어요. 다시 시도해 주세요.');
      setIsBurningIn(false);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      stopBurnInWorker();
    }

    function handleMessage(event: MessageEvent<BurnInWorkerResponse>) {
      const data = event.data;
      if (!data || data.requestId !== requestId) return;

      if (data.type === 'progress') {
        if (typeof data.progress === 'number') setBurnInProgress(data.progress);
        if (data.message) setBurnInMessage(data.message);
        return;
      }

      if (data.type === 'done') {
        const blob = new Blob([data.output], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        setBurnInResultUrl(url);
        setBurnInMessage('자막이 포함된 mp4가 준비됐어요.');
        setIsBurningIn(false);
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        stopBurnInWorker();

        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        return;
      }

      if (data.type === 'error') {
        setBurnInError('번인 내보내기에 실패했어요. 잠시 후 다시 시도해 주세요.');
        console.error('[burn-in-worker] error', data.message);
        setIsBurningIn(false);
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        stopBurnInWorker();
      }
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    const videoBuffer = await videoBlob.arrayBuffer();
    worker.postMessage(
      { type: 'burn-in', requestId, videoData: videoBuffer, srtText: srt, fontUrl: burnInFontUrl },
      [videoBuffer],
    );
  }, [
    burnInFontUrl,
    burnInResultUrl,
    durationMs,
    getCaptionsForExport,
    safeTitleOrId,
    stopBurnInWorker,
    videoBlob,
  ]);

  const handleImportJsonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportJsonFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = parseCaptionsFromJson(text, createCaptionId);
        setCaptionDrafts(sortCaptions(imported));
        setImportError(null);
        resetSaveCaptionsError();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '자막 JSON을 불러오지 못했어요.');
      } finally {
        event.target.value = '';
      }
    },
    [resetSaveCaptionsError],
  );

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const getShortcutTargetCaptionId = useCallback(() => {
    return (
      lastFocusedCaptionId ??
      activeCaptionId ??
      captionDrafts[captionDrafts.length - 1]?.id ??
      null
    );
  }, [activeCaptionId, captionDrafts, lastFocusedCaptionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'A' ||
          target.isContentEditable);
      if (isTypingTarget) return;

      if (event.key === ' ') {
        event.preventDefault();
        togglePlayback();
        return;
      }

      if (event.key === '[') {
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'startMs');
        return;
      }

      if (event.key === ']') {
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'endMs');
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        handleAddCaption();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [getShortcutTargetCaptionId, handleAddCaption, handleSetCaptionTimeFromVideo, togglePlayback]);

  const handleDeleteCaption = useCallback((captionId: string) => {
    resetSaveCaptionsError();
    setImportError(null);
    setCaptionDrafts((prev) => prev.filter((caption) => caption.id !== captionId));
    setLastFocusedCaptionId((prev) => (prev === captionId ? null : prev));
  }, [resetSaveCaptionsError]);

  const handleSaveCaptions = useCallback(() => {
    if (!videoId || hasCaptionErrors) return;
    persistCaptions(captionDrafts);
  }, [captionDrafts, hasCaptionErrors, persistCaptions, videoId]);

  const handleMetadata = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      if (!video) return;
      const target = event.currentTarget;
      const durationMs = Number.isFinite(target.duration)
        ? Math.round(target.duration * 1000)
        : undefined;
      const width = target.videoWidth || undefined;
      const height = target.videoHeight || undefined;

      if (
        durationMs === video.durationMs &&
        width === video.width &&
        height === video.height
      ) {
        setAppliedMetadataForId(videoId);
        return;
      }

      const patch: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>> = {};
      if (typeof durationMs === 'number') patch.durationMs = durationMs;
      if (typeof width === 'number') patch.width = width;
      if (typeof height === 'number') patch.height = height;

      const next: Video = { ...video, ...patch };

      queryClient.setQueryData(['video', videoId], next);
      queryClient.setQueryData(['videos'], (prev: Video[] | undefined) =>
        prev?.map((v) => (v.id === next.id ? { ...v, ...next } : v)) ?? prev,
      );
      if (dataSourceKind === 'mock') {
        const maybe = dataSource as unknown as {
          updateVideoMetadata?: (
            id: string,
            meta: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>>
          ) => Promise<void>;
        };
        if (typeof maybe.updateVideoMetadata === 'function') {
          void maybe.updateVideoMetadata(videoId, patch);
        }
      }

      setAppliedMetadataForId(videoId);
      if (typeof durationMs === 'number') setDurationMs(durationMs);
    },
    [video, videoId],
  );

  useEffect(() => {
    if (typeof video?.durationMs === 'number') {
      setDurationMs(video.durationMs);
    }
  }, [video]);

  useEffect(() => {
    if (!videoUrl) {
      cleanupWebglResources();
      return undefined;
    }

    initWebgl();

    return () => {
      cleanupWebglResources();
    };
  }, [cleanupWebglResources, initWebgl, videoUrl]);

  useEffect(() => {
    if (typeof durationMs !== 'number') return;
    setTrimRange((prev) => {
      if (prev && Number.isFinite(prev.startMs) && Number.isFinite(prev.endMs)) {
        const clampedStart = Math.max(0, Math.min(prev.startMs, durationMs));
        const clampedEnd = Math.max(clampedStart, Math.min(prev.endMs, durationMs));
        return { startMs: clampedStart, endMs: clampedEnd };
      }
      return { startMs: 0, endMs: durationMs };
    });
  }, [durationMs]);

  useEffect(() => {
    trimRangeRef.current = trimRange;
  }, [trimRange]);

  const effectiveDurationMs = useMemo(() => {
    if (typeof durationMs === 'number') return durationMs;
    if (typeof video?.durationMs === 'number') return video.durationMs;
    return null;
  }, [durationMs, video]);

  useEffect(() => {
    if (!isWebglReady) return undefined;

    const handleResize = () => {
      renderWebglFrame();
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handleResize);
      if (webglContainerRef.current) observer.observe(webglContainerRef.current);
    }
    window.addEventListener('resize', handleResize);

    handleResize();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [isWebglReady, renderWebglFrame]);

  type WaveformWorkerPayload =
    | Omit<Extract<WaveformWorkerRequest, { type: 'load-samples' }>, 'requestId'>
    | Omit<Extract<WaveformWorkerRequest, { type: 'compute-peaks' }>, 'requestId'>;

  const postWaveformWorkerMessage = useCallback(
    (message: WaveformWorkerPayload, transfer: Transferable[] = []) => {
      const worker = waveformWorkerRef.current;
      if (!worker) return Promise.reject(new Error('waveform-worker-unavailable'));

      const requestId = waveformRequestIdRef.current + 1;
      waveformRequestIdRef.current = requestId;

      return new Promise<WaveformWorkerResponse>((resolve, reject) => {
        waveformWorkerResolversRef.current.set(requestId, (response) => {
          if (response.type === 'error') {
            reject(new Error(response.message));
            return;
          }

          resolve(response);
        });

        worker.postMessage({ ...(message as WaveformWorkerRequest), requestId }, transfer);
      });
    },
    [],
  );

  const resetWaveformOverview = useCallback(() => {
    waveformSamplesReadyRef.current = false;
    waveformOverviewPeaksRef.current = null;
    waveformBucketCountRef.current = null;
    waveformPendingBucketRef.current = null;
    waveformLastComputeAtRef.current = 0;
    waveformModeRef.current = 'loading';
    if (waveformComputeTimeoutRef.current !== null) {
      window.clearTimeout(waveformComputeTimeoutRef.current);
      waveformComputeTimeoutRef.current = null;
    }
  }, []);

  const getWaveformBucketCount = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    return Math.max(64, width);
  }, []);

  const renderOverviewWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    const peaks = waveformOverviewPeaksRef.current;
    const bucketCount = waveformBucketCountRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.clearRect(0, 0, width, height);
    if (!peaks || !bucketCount) return;

    const halfHeight = height / 2;
    const barWidth = width / bucketCount;

    context.lineWidth = Math.max(1, dpr);
    context.strokeStyle = '#2b7bff';
    context.beginPath();

    for (let i = 0; i < bucketCount; i += 1) {
      const min = (peaks[i * 2] ?? 0) / 32768;
      const max = (peaks[i * 2 + 1] ?? 0) / 32767;
      const x = i * barWidth;
      const yMin = halfHeight + min * halfHeight;
      const yMax = halfHeight + max * halfHeight;
      context.moveTo(x, yMin);
      context.lineTo(x, yMax);
    }

    context.stroke();

    if (typeof currentTimeMsRef.current === 'number' && typeof effectiveDurationMs === 'number' && effectiveDurationMs > 0) {
      const ratio = Math.min(1, Math.max(0, currentTimeMsRef.current / effectiveDurationMs));
      const x = ratio * width;
      context.strokeStyle = '#ef4444';
      context.lineWidth = Math.max(1, dpr * 1.2);
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  }, [effectiveDurationMs]);

  const computeOverviewPeaks = useCallback(
    async (bucketCount: number) => {
      try {
        const token = waveformComputeTokenRef.current + 1;
        waveformComputeTokenRef.current = token;
        const response = await postWaveformWorkerMessage({ type: 'compute-peaks', bucketCount });
        if (response.type !== 'peaks-ready') return;
        if (token !== waveformComputeTokenRef.current) return;

        waveformOverviewPeaksRef.current = new Int16Array(response.peaks);
        waveformBucketCountRef.current = response.bucketCount;
        waveformLastComputeAtRef.current = Date.now();
        waveformPendingBucketRef.current = null;

        if (import.meta.env.DEV) {
          console.debug(
            `[waveform] overview peaks computed in ${response.durationMs.toFixed(1)}ms via ${response.impl}`,
          );
        }

        renderOverviewWaveform();
      } catch (error) {
        console.error('[waveform] peak computation failed', error);
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
      }
    },
    [postWaveformWorkerMessage, renderOverviewWaveform],
  );

  const queueWaveformComputation = useCallback(
    (bucketCount: number | null) => {
      if (!bucketCount || bucketCount <= 0 || shouldUseLiveWaveform) return;

      waveformPendingBucketRef.current = bucketCount;

      if (waveformComputeTimeoutRef.current !== null) {
        window.clearTimeout(waveformComputeTimeoutRef.current);
      }

      const now = Date.now();
      if (waveformBucketCountRef.current === bucketCount && now - waveformLastComputeAtRef.current < 1000) {
        renderOverviewWaveform();
        return;
      }

      const delay = waveformLastComputeAtRef.current === 0
        ? 0
        : Math.max(0, 1000 - (now - waveformLastComputeAtRef.current));

      waveformComputeTimeoutRef.current = window.setTimeout(() => {
        waveformComputeTimeoutRef.current = null;
        const pendingBucketCount = waveformPendingBucketRef.current;
        if (!waveformSamplesReadyRef.current || typeof pendingBucketCount !== 'number') return;
        void computeOverviewPeaks(pendingBucketCount);
      }, delay);
    },
    [computeOverviewPeaks, renderOverviewWaveform, shouldUseLiveWaveform],
  );

  useEffect(() => {
    resetWaveformOverview();
    setShouldUseLiveWaveform(false);

    if (!videoBlob) return undefined;

    let cancelled = false;

    const decodeWaveform = async () => {
      const AudioContextClass =
        window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
        return;
      }

      let context: AudioContext | null = null;

      try {
        context = new AudioContextClass();
        waveformModeRef.current = 'loading';

        const audioBuffer = await videoBlob.arrayBuffer();
        const decoded = await context.decodeAudioData(audioBuffer.slice(0));
        if (cancelled) return;

        const firstChannel = decoded.getChannelData(0);
        let samples: Float32Array;

        if (decoded.numberOfChannels >= 2) {
          // 기본은 첫 번째 채널, 2채널인 경우 좌/우 평균을 사용한다.
          const secondChannel = decoded.getChannelData(1);
          samples = new Float32Array(firstChannel.length);
          for (let i = 0; i < samples.length; i += 1) {
            const left = firstChannel[i] ?? 0;
            const right = secondChannel[i] ?? 0;
            samples[i] = (left + right) / 2;
          }
        } else {
          samples = new Float32Array(firstChannel);
        }

        const response = await postWaveformWorkerMessage(
          { type: 'load-samples', samples: samples.buffer as ArrayBuffer },
          [samples.buffer],
        );
        if (cancelled) return;
        if (response.type !== 'samples-loaded') throw new Error('waveform-load-failed');

        waveformSamplesReadyRef.current = true;
        waveformModeRef.current = 'overview';

        const bucketCount = getWaveformBucketCount();
        queueWaveformComputation(bucketCount ?? Math.min(samples.length, 4096));
      } catch (error) {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.debug('[waveform] overview fallback', error);
        }
        waveformSamplesReadyRef.current = false;
        waveformOverviewPeaksRef.current = null;
        resetWaveformOverview();
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
      } finally {
        if (context) void context.close().catch(() => null);
      }
    };

    void decodeWaveform();

    return () => {
      cancelled = true;
    };
  }, [getWaveformBucketCount, postWaveformWorkerMessage, queueWaveformComputation, resetWaveformOverview, videoBlob]);

  useEffect(() => {
    if (shouldUseLiveWaveform) return undefined;

    const canvas = waveformCanvasRef.current;
    if (!canvas) return undefined;

    const handleResize = () => {
      const bucketCount = getWaveformBucketCount();
      if (bucketCount && bucketCount !== waveformBucketCountRef.current) {
        queueWaveformComputation(bucketCount);
      }
      renderOverviewWaveform();
    };

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    if (observer) observer.observe(canvas);
    window.addEventListener('resize', handleResize);

    handleResize();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
      if (waveformComputeTimeoutRef.current !== null) {
        window.clearTimeout(waveformComputeTimeoutRef.current);
        waveformComputeTimeoutRef.current = null;
      }
    };
  }, [getWaveformBucketCount, queueWaveformComputation, renderOverviewWaveform, shouldUseLiveWaveform]);

  useEffect(() => {
    if (shouldUseLiveWaveform) return;
    renderOverviewWaveform();
  }, [renderOverviewWaveform, shouldUseLiveWaveform, currentTimeMs]);

  const drawWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    const analyser = analyserRef.current;
    const dataArray = waveformDataRef.current;
    if (!canvas || !analyser || !dataArray) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const typedDataArray = dataArray as unknown as Uint8Array<ArrayBuffer>;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr || 1;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    analyser.getByteTimeDomainData(typedDataArray);

    context.clearRect(0, 0, width, height);
    context.lineWidth = 2;
    context.strokeStyle = '#2b7bff';

    context.beginPath();
    const sliceWidth = width / typedDataArray.length;
    let x = 0;

    for (let i = 0; i < typedDataArray.length; i += 1) {
      const value = typedDataArray[i] ?? 128;
      const v = value / 128.0;
      const y = (v * height) / 2;

      if (i === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }

      x += sliceWidth;
    }

    context.stroke();
    waveformRafIdRef.current = window.requestAnimationFrame(drawWaveform);
  }, []);

  const stopWaveform = useCallback(() => {
    if (waveformRafIdRef.current !== null) {
      window.cancelAnimationFrame(waveformRafIdRef.current);
      waveformRafIdRef.current = null;
    }
  }, []);

  const startWaveform = useCallback(() => {
    stopWaveform();
    waveformRafIdRef.current = window.requestAnimationFrame(drawWaveform);
  }, [drawWaveform, stopWaveform]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoUrl || !shouldUseLiveWaveform) return undefined;

    const AudioContextClass =
      window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return undefined;

    let context: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;

    try {
      context = new AudioContextClass();
      audioContextRef.current = context;

      source = context.createMediaElementSource(videoElement);
      mediaSourceRef.current = source;

      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      source.connect(analyser);
      analyser.connect(context.destination);

      waveformDataRef.current =
        new Uint8Array(analyser.frequencyBinCount) as unknown as Uint8Array<ArrayBuffer>;
    } catch {
      audioContextRef.current = null;
      analyserRef.current = null;
      mediaSourceRef.current = null;
      waveformDataRef.current = null;
      return undefined;
    }

    const handlePlay = () => {
      if (!context) return;
      void context.resume().catch(() => null);
      startWaveform();
    };

    const handlePause = () => {
      stopWaveform();
    };

    const handleEnded = () => {
      stopWaveform();
    };

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('ended', handleEnded);

    if (!videoElement.paused && !videoElement.ended) {
      if (context) void context.resume().catch(() => null);
      startWaveform();
    }

    return () => {
      stopWaveform();
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('ended', handleEnded);

      try {
        analyser?.disconnect();
        source?.disconnect();
      } catch (err) {
        if (import.meta.env.DEV) {
          console.debug('[waveform] cleanup failed', err);
        }
      }
      if (context) void context.close().catch(() => null);

      audioContextRef.current = null;
      analyserRef.current = null;
      mediaSourceRef.current = null;
      waveformDataRef.current = null;
    };
  }, [shouldUseLiveWaveform, startWaveform, stopWaveform, videoUrl]);

  useEffect(() => {
    if (!shouldUseLiveWaveform) {
      stopWaveform();
    }
  }, [shouldUseLiveWaveform, stopWaveform]);

  useEffect(() => {
    if (!isWebglReady) return undefined;
    const videoElement = videoRef.current;
    if (!videoElement) return undefined;

    const handlePlay = () => scheduleWebglRenderLoop();
    const handlePause = () => {
      renderWebglFrame();
      stopWebglRenderLoop();
    };
    const handleEnded = () => {
      renderWebglFrame();
      stopWebglRenderLoop();
    };
    const handleLoaded = () => renderWebglFrame();
    const handleSeeking = () => renderWebglFrame();
    const handleSeeked = () => renderWebglFrame();

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('ended', handleEnded);
    videoElement.addEventListener('loadeddata', handleLoaded);
    videoElement.addEventListener('loadedmetadata', handleLoaded);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    if (!videoElement.paused && !videoElement.ended) {
      scheduleWebglRenderLoop();
    } else {
      renderWebglFrame();
    }

    return () => {
      stopWebglRenderLoop();
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('ended', handleEnded);
      videoElement.removeEventListener('loadeddata', handleLoaded);
      videoElement.removeEventListener('loadedmetadata', handleLoaded);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
    };
  }, [isWebglReady, renderWebglFrame, scheduleWebglRenderLoop, stopWebglRenderLoop, videoUrl]);

  useEffect(() => {
    if (!isWebglReady) return;
    renderWebglFrame();
  }, [isGrayscale, isWebglReady, renderWebglFrame]);

  useEffect(() => {
    const liveIds = new Set(captionDrafts.map((c) => c.id));
    for (const key of Object.keys(captionRefs.current)) {
      if (!liveIds.has(key)) delete captionRefs.current[key];
    }
  }, [captionDrafts]);

  useEffect(() => {
    if (!activeCaptionId) return;
    const target = captionRefs.current[activeCaptionId];
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeCaptionId]);

  const selection = useMemo(() => {
    if (!trimRange || typeof effectiveDurationMs !== 'number') return null;
    const startMs = Math.max(0, Math.min(trimRange.startMs, effectiveDurationMs));
    const endMs = Math.max(startMs, Math.min(trimRange.endMs, effectiveDurationMs));
    const widthPct = effectiveDurationMs === 0 ? 0 : ((endMs - startMs) / effectiveDurationMs) * 100;
    const leftPct = effectiveDurationMs === 0 ? 0 : (startMs / effectiveDurationMs) * 100;
    return { startMs, endMs, widthPct, leftPct, durationMs: endMs - startMs };
  }, [effectiveDurationMs, trimRange]);

  const clampToDuration = useCallback(
    (ms: number) => {
      const maxDuration = effectiveDurationMs ?? Number.NaN;
      if (!Number.isFinite(maxDuration)) return Math.max(0, ms);
      return Math.min(Math.max(ms, 0), maxDuration);
    },
    [effectiveDurationMs],
  );

  const updateTrimRange = useCallback(
    (next: { startMs: number; endMs: number }) => {
      setTrimRange((prev) => {
        const snappedStart = snapToStep(next.startMs, snapStepMs);
        const snappedEnd = snapToStep(next.endMs, snapStepMs);
        const clampedStart = clampToDuration(Math.min(snappedStart, snappedEnd));
        const clampedEnd = clampToDuration(Math.max(snappedStart, snappedEnd));
        if (prev && clampedStart === prev.startMs && clampedEnd === prev.endMs) return prev;
        return { startMs: clampedStart, endMs: clampedEnd };
      });
    },
    [clampToDuration, snapStepMs],
  );

  const handleNudge = useCallback(
    (target: 'start' | 'end', deltaMs: number) => {
      setTrimRange((prev) => {
        if (!prev) return prev;
        const nextStart = target === 'start' ? clampToDuration(prev.startMs + deltaMs) : prev.startMs;
        const nextEnd = target === 'end' ? clampToDuration(prev.endMs + deltaMs) : prev.endMs;
        return {
          startMs: Math.min(nextStart, nextEnd),
          endMs: Math.max(nextStart, nextEnd),
        };
      });
    },
    [clampToDuration],
  );

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const ms = clampToDuration(ratio * effectiveDurationMs);
      setDragTarget('new');
      updateTrimRange({ startMs: ms, endMs: ms });
      trimRangeRef.current = { startMs: ms, endMs: ms };
      window.getSelection()?.removeAllRanges();
    },
    [clampToDuration, effectiveDurationMs, updateTrimRange],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragTarget || typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const ms = clampToDuration(ratio * effectiveDurationMs);
      setTrimRange((prev) => {
        if (!prev) return prev;
        if (dragTarget === 'start') {
          const next = { startMs: ms, endMs: prev.endMs };
          trimRangeRef.current = next;
          return next;
        }
        if (dragTarget === 'end') {
          const next = { startMs: prev.startMs, endMs: ms };
          trimRangeRef.current = next;
          return next;
        }
        const next = { startMs: prev.startMs, endMs: ms };
        trimRangeRef.current = next;
        return next;
      });
    },
    [clampToDuration, dragTarget, effectiveDurationMs],
  );

  const handlePointerUp = useCallback(() => {
    if (!dragTarget) return;
    const latest = trimRangeRef.current;
    if (!latest) return;

    setDragTarget(null);
    updateTrimRange(latest);
  }, [dragTarget, updateTrimRange]);
  useEffect(() => {
    if (!dragTarget) return undefined;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragTarget, handlePointerMove, handlePointerUp]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    updateCurrentTime();

    const handleTimeUpdate = () => updateCurrentTime();
    const handleSeeked = () => updateCurrentTime();
    const handleSeeking = () => updateCurrentTime();
    const handleLoadedMetadata = () => updateCurrentTime();
    const handlePlay = () => {
      updateCurrentTime();
      scheduleTimeTracking();
    };
    const handlePause = () => {
      updateCurrentTime();
      cancelTimeTracking();
    };
    const handleEnded = () => {
      updateCurrentTime();
      cancelTimeTracking();
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeking', handleSeeking);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('seeking', handleSeeking);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);

    if (!video.paused && !video.ended) {
      scheduleTimeTracking();
    }

    return () => {
      cancelTimeTracking();
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeking', handleSeeking);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('seeking', handleSeeking);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
    };
  }, [videoUrl, cancelTimeTracking, scheduleTimeTracking, updateCurrentTime]);

  return (
    <main className="video-detail-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0 }}>비디오 상세</h1>
        <Link to="/videos" style={{ fontSize: 14, color: '#555' }}>
          목록으로 돌아가기
        </Link>
      </div>

      {isVideoLoading ? (
        <p style={{ margin: '12px 0 0' }}>비디오 정보를 불러오는 중이에요…</p>
      ) : isVideoError || !video ? (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 8,
            border: '1px solid #f2c4c4',
            background: '#fff6f6',
            color: '#b00020',
          }}
        >
          <p style={{ margin: 0 }}>비디오를 찾지 못했어요.</p>
        </div>
      ) : (
        <div className="video-detail-sections">
          <section
            className="video-detail-meta"
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h2 style={{ margin: 0 }}>{video.title}</h2>
              <span style={{ color: '#666', fontSize: 13 }}>
                {formatDate(video.createdAt)}
              </span>
            </div>
              <div style={{ color: '#555', fontSize: 14 }}>
                {formatMeta(video) || '메타데이터 없음'}
                {isMetadataReady && formatMeta(video)
                  ? ' (추출됨)'
                  : null}
              </div>
            </section>

          <section
            className="video-detail-captions"
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h3 style={{ margin: 0 }}>자막</h3>
              <button
                type="button"
                onClick={handleAddCaption}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid #111',
                  cursor: 'pointer',
                  background: '#111',
                  color: '#fff',
                }}
                disabled={isCaptionsLoading || isSavingCaptions}
              >
                새 자막 추가
              </button>
              <div style={{ flex: 1 }} />
              {lastSavedAt ? (
                <span style={{ color: '#666', fontSize: 12 }}>
                  마지막 저장: {new Date(lastSavedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {isCaptionsLoading ? (
              <p style={{ margin: 0 }}>자막을 불러오는 중이에요…</p>
            ) : isCaptionsError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #f2c4c4',
                  background: '#fff6f6',
                  color: '#b00020',
                }}
              >
                <p style={{ margin: '0 0 6px' }}>자막을 불러오지 못했어요.</p>
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: '#2f1317',
                    color: '#ffeaea',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                  }}
                >
                  {captionsError instanceof Error ? captionsError.message : String(captionsError)}
                </pre>
              </div>
            ) : captionDrafts.length === 0 ? (
              <p style={{ margin: 0, color: '#555' }}>
                자막이 없어요. 새 자막을 추가해보세요.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
                {captionDrafts.map((caption) => {
                  const errors = getCaptionErrors(caption);
                  const hasError = Object.keys(errors).length > 0;
                  const isActive = activeCaptionId === caption.id;
                  return (
                    <li
                      key={caption.id}
                      ref={(node) => {
                        captionRefs.current[caption.id] = node;
                      }}
                      style={{
                        border: isActive ? '1px solid #111' : '1px solid #e6e6e6',
                        borderRadius: 10,
                        padding: 12,
                        background: hasError
                          ? '#fffafa'
                          : isActive
                            ? '#f5f8ff'
                            : '#fdfdfd',
                        display: 'grid',
                        boxShadow: isActive ? '0 0 0 2px #dfe8ff' : undefined,
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>시작(ms)</span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="number"
                              min={0}
                              value={Number.isFinite(caption.startMs) ? caption.startMs : ''}
                              onChange={(e) =>
                                handleCaptionFieldChange(caption.id, 'startMs', e.target.value)
                              }
                              onFocus={() => setLastFocusedCaptionId(caption.id)}
                              style={{
                                padding: '8px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleSetCaptionTimeFromVideo(caption.id, 'startMs')}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                                cursor: 'pointer',
                                background: '#f7f7f7',
                                color: '#111',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              현재 재생 위치로 설정
                            </button>
                          </div>
                          {errors.startMs ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.startMs}</span>
                          ) : null}
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>종료(ms)</span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="number"
                              min={0}
                              value={Number.isFinite(caption.endMs) ? caption.endMs : ''}
                              onChange={(e) => handleCaptionFieldChange(caption.id, 'endMs', e.target.value)}
                              onFocus={() => setLastFocusedCaptionId(caption.id)}
                              style={{
                                padding: '8px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleSetCaptionTimeFromVideo(caption.id, 'endMs')}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                                cursor: 'pointer',
                                background: '#f7f7f7',
                                color: '#111',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              현재 재생 위치로 설정
                            </button>
                          </div>
                          {errors.endMs ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.endMs}</span>
                          ) : null}
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>자막 내용</span>
                          <input
                            type="text"
                            value={caption.text}
                            onChange={(e) => handleCaptionFieldChange(caption.id, 'text', e.target.value)}
                            onFocus={() => setLastFocusedCaptionId(caption.id)}
                            placeholder="자막을 입력하세요"
                            style={{
                              padding: '8px 10px',
                              borderRadius: 6,
                              border: '1px solid #ccc',
                            }}
                          />
                          {errors.text ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.text}</span>
                          ) : null}
                        </label>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={() => handleDeleteCaption(caption.id)}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 8,
                              border: '1px solid #b00020',
                              background: '#fff6f6',
                              color: '#b00020',
                              cursor: 'pointer',
                              height: 'fit-content',
                            }}
                            aria-label="자막 삭제"
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {isSaveCaptionsError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #f2c4c4',
                  background: '#fff6f6',
                  color: '#b00020',
                }}
              >
                <p style={{ margin: '0 0 6px' }}>자막 저장에 실패했어요.</p>
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: '#2f1317',
                    color: '#ffeaea',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                  }}
                >
                  {saveCaptionsError instanceof Error ? saveCaptionsError.message : String(saveCaptionsError)}
                </pre>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={handleSaveCaptions}
                disabled={
                  isCaptionsLoading ||
                  isSavingCaptions ||
                  hasCaptionErrors ||
                  captionDrafts.length === 0
                }
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#111',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {isSavingCaptions ? '저장 중…' : '자막 저장'}
              </button>
              {hasCaptionErrors ? (
                <span style={{ color: '#b00020', fontSize: 13 }}>
                  모든 자막의 시작·종료 시간과 내용을 확인하세요.
                </span>
              ) : (
                <span style={{ color: '#555', fontSize: 13 }}>
                  시작 시간 오름차순으로 정렬되어 저장돼요.
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={handleImportJsonFile}
              />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={applyTrimOnExport}
                  disabled={!trimRange}
                  onChange={(event) => setApplyTrimOnExport(event.target.checked)}
                />
                <span style={{ fontSize: 14, color: '#111' }}>
                  선택 구간만 내보내기
                  <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(시작 시간을 0으로 맞춰 저장)</span>
                  {!trimRange ? (
                    <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(트림 구간을 먼저 선택)</span>
                  ) : null}
                </span>
              </label>
              <button
                type="button"
                onClick={handleImportJsonClick}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                JSON 불러오기
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                JSON 내보내기
              </button>
              <button
                type="button"
                onClick={handleExportSrt}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                SRT 내보내기
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                padding: 12,
                border: '1px solid #e6e6e6',
                borderRadius: 10,
                background: '#fafafa',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={handleBurnInExport}
                  disabled={
                    isBurningIn ||
                    isBlobLoading ||
                    Boolean(videoBlobError) ||
                    !videoBlob ||
                    captionDrafts.length === 0
                  }
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid #222',
                    background: '#111',
                    color: '#fff',
                    cursor: isBurningIn ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isBurningIn ? '번인 내보내는 중…' : '자막 번인 mp4 내보내기'}
                </button>
                {isBurningIn ? (
                  <button
                    type="button"
                    onClick={handleCancelBurnIn}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 8,
                      border: '1px solid #b00020',
                      background: '#fff6f6',
                      color: '#b00020',
                      cursor: 'pointer',
                    }}
                  >
                    작업 취소
                  </button>
                ) : null}
              </div>
              <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
                지원: mp4 · 길이 30초 이하 또는 50MB 이하. 진행 중에도 다른 작업은 그대로 사용할 수 있어요.
              </p>
              {burnInProgress !== null || burnInMessage ? (
                <div style={{ color: '#111', fontSize: 14, lineHeight: 1.4 }}>
                  {burnInProgress !== null ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <div
                        style={{
                          flex: '0 0 160px',
                          height: 8,
                          borderRadius: 999,
                          background: '#e5e5e5',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%`,
                            height: '100%',
                            background: '#4a90e2',
                          }}
                        />
                      </div>
                      <span style={{ color: '#333', fontSize: 13 }}>
                        {Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%
                      </span>
                    </div>
                  ) : null}
                  {burnInMessage ? <div style={{ marginTop: 4, color: '#333' }}>{burnInMessage}</div> : null}
                </div>
              ) : null}
              {burnInResultUrl && burnInFileName ? (
                <div style={{ fontSize: 14 }}>
                  <a
                    href={burnInResultUrl}
                    download={burnInFileName}
                    style={{ color: '#0b74de', textDecoration: 'underline' }}
                  >
                    번인된 mp4 다시 저장하기
                  </a>
                </div>
              ) : null}
              {burnInError ? (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #f2c4c4',
                    background: '#fff6f6',
                    color: '#b00020',
                    fontSize: 14,
                  }}
                >
                  <p style={{ margin: '0 0 4px' }}>{burnInError}</p>
                  <p style={{ margin: 0, color: '#b00020', fontSize: 12 }}>
                    DEV 로그는 콘솔을 확인하세요.
                  </p>
                </div>
              ) : null}
            </div>

            {importError ? (
              <p style={{ margin: '8px 0 0', color: '#b00020' }}>{importError}</p>
            ) : null}
          </section>

          <section
            className="video-detail-thumbnail"
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
            }}
          >
            <h3 style={{ margin: '0 0 12px' }}>썸네일</h3>
            {isThumbLoading ? (
              <p style={{ margin: 0 }}>썸네일을 불러오는 중이에요…</p>
            ) : thumbnailBlobError ? (
              <p style={{ margin: 0, color: '#b00020' }}>
                썸네일을 불러오지 못했어요.
              </p>
            ) : thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt="저장된 비디오 썸네일"
                style={{
                  width: '100%',
                  maxWidth: 360,
                  borderRadius: 8,
                  border: '1px solid #ddd',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <p style={{ margin: 0, color: '#555' }}>저장된 썸네일이 없어요.</p>
            )}
          </section>

          <section
            className="video-detail-player"
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
            }}
          >
            <h3 style={{ margin: '0 0 12px' }}>영상 미리보기</h3>
            {isBlobLoading ? (
              <p style={{ margin: 0 }}>비디오 파일을 불러오는 중이에요…</p>
            ) : videoBlobError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  background: '#fff4f4',
                  border: '1px solid #f2c4c4',
                  color: '#b00020',
                }}
              >
                영상 파일을 불러오지 못했어요.
              </div>
            ) : videoUrl ? (
              <>
                <div style={{ position: 'relative' }}>
                  <video
                    key={videoUrl}
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    style={{ width: '100%', borderRadius: 8, background: '#000' }}
                    onLoadedMetadata={handleMetadata}
                  >
                    <track kind="captions" />
                  </video>
                  {activeCaptionText ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: 24,
                        transform: 'translateX(-50%)',
                        background: 'rgba(0, 0, 0, 0.7)',
                        color: '#fff',
                        borderRadius: 8,
                        padding: '8px 12px',
                        maxWidth: 'calc(100% - 24px)',
                        textAlign: 'center',
                        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.25)',
                        fontSize: 16,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                      }}
                    >
                      {activeCaptionText}
                    </div>
                  ) : null}
                </div>
                {isWebglSupported && isWebglReady ? (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 12,
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      display: 'grid',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                      <p style={{ margin: 0, fontWeight: 600, color: '#111' }}>추가 미리보기 (WebGL)</p>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#111' }}>
                        <input
                          type="checkbox"
                          checked={isGrayscale}
                          onChange={(event) => setIsGrayscale(event.target.checked)}
                        />
                        <span>그레이스케일</span>
                      </label>
                    </div>
                    <div ref={webglContainerRef} style={{ width: '100%' }}>
                      <canvas
                        ref={webglCanvasRef}
                        style={{
                          width: '100%',
                          display: 'block',
                          borderRadius: 8,
                          background: '#000',
                          aspectRatio:
                            video?.width && video?.height
                              ? `${video.width} / ${video.height}`
                              : '16 / 9',
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    display: 'grid',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <p style={{ margin: 0, color: '#111', fontWeight: 600 }}>트리밍 구간</p>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
                      <span style={{ color: '#111' }}>
                        시작: <strong>{selection ? formatTimestamp(selection.startMs) : '--:--.---'}</strong>
                      </span>
                      <span style={{ color: '#111' }}>
                        종료: <strong>{selection ? formatTimestamp(selection.endMs) : '--:--.---'}</strong>
                      </span>
                      <span style={{ color: '#555' }}>
                        길이: {selection ? formatTimestamp(selection.durationMs) : '--:--.---'}
                      </span>
                    </div>
                  </div>
                  <div
                    ref={timelineRef}
                    onPointerDown={handleTimelinePointerDown}
                    style={{
                      position: 'relative',
                      height: 32,
                      borderRadius: 16,
                      background: '#e5e7eb',
                      cursor: 'crosshair',
                      touchAction: 'none',
                      overflow: 'hidden',
                    }}
                    aria-label="트리밍 구간 선택"
                  >
                    {selection ? (
                      <div
                        style={{
                          position: 'absolute',
                          left: `${selection.leftPct}%`,
                          width: `${selection.widthPct}%`,
                          top: 0,
                          bottom: 0,
                          background: 'rgba(43, 123, 255, 0.2)',
                          border: '1px solid #2b7bff',
                          borderRadius: 16,
                          minWidth: 8,
                        }}
                      >
                        <div
                          role="separator"
                          aria-label="시작 지점 조절"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setDragTarget('start');
                          }}
                          style={{
                            position: 'absolute',
                            left: -6,
                            top: -6,
                            bottom: -6,
                            width: 12,
                            borderRadius: 4,
                            background: '#2b7bff',
                            cursor: 'ew-resize',
                          }}
                        />
                        <div
                          role="separator"
                          aria-label="종료 지점 조절"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setDragTarget('end');
                          }}
                          style={{
                            position: 'absolute',
                            right: -6,
                            top: -6,
                            bottom: -6,
                            width: 12,
                            borderRadius: 4,
                            background: '#2b7bff',
                            cursor: 'ew-resize',
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, color: '#333' }}>스냅:</span>
                    {[100, 1000].map((step) => (
                      <button
                        key={step}
                        type="button"
                        onClick={() => setSnapStepMs(step as 100 | 1000)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: snapStepMs === step ? '1px solid #2b7bff' : '1px solid #d0d7e2',
                          background: snapStepMs === step ? '#e8f0ff' : '#fff',
                          color: '#111',
                          cursor: 'pointer',
                        }}
                      >
                        {step === 100 ? '100ms' : '1s'}
                      </button>
                    ))}
                    <span style={{ fontSize: 13, color: '#333', marginLeft: 8 }}>미세 조정:</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => handleNudge('start', -snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        시작 -{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('start', snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        시작 +{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('end', -snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        종료 -{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('end', snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        종료 +{snapStepMs}ms
                      </button>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#f7f9fb',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <p style={{ margin: '0 0 8px', color: '#333', fontSize: 14 }}>오디오 파형</p>
                  <canvas
                    ref={waveformCanvasRef}
                    style={{ width: '100%', height: 96, display: 'block' }}
                  />
                </div>
              </>
            ) : (
              <p style={{ margin: 0 }}>재생할 수 있는 영상이 없어요.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}