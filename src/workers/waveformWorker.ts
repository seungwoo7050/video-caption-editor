/// <reference lib="webworker" />

export type WaveformWorkerRequest =
  | {
      type: 'load-samples';
      requestId: number;
      samples: ArrayBuffer;
    }
  | {
      type: 'compute-peaks';
      requestId: number;
      bucketCount: number;
    };

export type WaveformWorkerResponse =
  | {
      type: 'samples-loaded';
      requestId: number;
      sampleCount: number;
    }
  | {
      type: 'peaks-ready';
      requestId: number;
      peaks: ArrayBuffer;
      bucketCount: number;
      impl: 'wasm' | 'js';
      durationMs: number;
    }
  | {
      type: 'error';
      requestId: number;
      message: string;
    };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let samplesRef: Float32Array | null = null;
let wasmModulePromise: Promise<WebAssembly.Instance | null> | null = null;
let wasmHeapBase = 0;

const WASM_URL = new URL('./peaks.wasm', import.meta.url);

const clampInt16 = (value: number) => Math.min(32767, Math.max(-32768, Math.round(value)));

const computePeaksJs = (samples: Float32Array, bucketCount: number): Int16Array => {
  const output = new Int16Array(bucketCount * 2);
  const bucketSize = samples.length / bucketCount;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((bucket + 1) * bucketSize)));

    let min = 1;
    let max = -1;

    for (let i = start; i < end; i += 1) {
      const value = samples[i] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }

    output[bucket * 2] = clampInt16(min * 32768);
    output[bucket * 2 + 1] = clampInt16(max * 32767);
  }

  return output;
};

const loadWasmModule = async (): Promise<WebAssembly.Instance | null> => {
  if (wasmModulePromise) return wasmModulePromise;

  wasmModulePromise = (async () => {
    try {
      const response = await fetch(WASM_URL);
      if (!response.ok) {
        throw new Error(`wasm-fetch-failed:${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const wasm = await WebAssembly.instantiate(buffer, {});
      const memory = (wasm.instance.exports.memory ?? null) as WebAssembly.Memory | null;
      const heapBaseExport = wasm.instance.exports.__heap_base as WebAssembly.Global | undefined;
      wasmHeapBase = typeof heapBaseExport?.value === 'number' ? Number(heapBaseExport.value) : 0;
      if (!memory) return null;
      return wasm.instance;
    } catch (error) {
      console.warn('[waveform-worker] wasm load failed, falling back to JS', error);
      return null;
    }
  })();

  return wasmModulePromise;
};

const ensureWasmMemory = (memory: WebAssembly.Memory, requiredBytes: number) => {
  const currentBytes = memory.buffer.byteLength;
  if (requiredBytes <= currentBytes) return memory.buffer;
  const pageSize = 65536;
  const additionalPages = Math.ceil((requiredBytes - currentBytes) / pageSize);
  memory.grow(additionalPages);
  return memory.buffer;
};

const computePeaksWasm = async (
  instance: WebAssembly.Instance,
  samples: Float32Array,
  bucketCount: number,
): Promise<Int16Array | null> => {
  const exports = instance.exports as {
    memory?: WebAssembly.Memory;
    compute_peaks?: (samplesPtr: number, len: number, buckets: number, outPtr: number) => void;
    _compute_peaks?: (samplesPtr: number, len: number, buckets: number, outPtr: number) => void;
  };
  
  const { memory } = exports;
  const computePeaks = exports.compute_peaks ?? exports._compute_peaks;

  if (!memory || typeof computePeaks !== 'function') return null;

  const samplesBytes = samples.byteLength;
  const outputBytes = bucketCount * 2 * Int16Array.BYTES_PER_ELEMENT;
  const alignedSamplesEnd = wasmHeapBase + ((samplesBytes + 7) & ~7);
  const totalRequired = alignedSamplesEnd + outputBytes;
  const buffer = ensureWasmMemory(memory, totalRequired);

  const samplesPtr = wasmHeapBase;
  const outPtr = alignedSamplesEnd;

  new Float32Array(buffer, samplesPtr, samples.length).set(samples);

  computePeaks(samplesPtr, samples.length, bucketCount, outPtr);

  const result = buffer.slice(outPtr, outPtr + outputBytes);
  return new Int16Array(result);
};

const handleCompute = async (request: Extract<WaveformWorkerRequest, { type: 'compute-peaks' }>) => {
  const sampleBuffer = samplesRef;
  if (!sampleBuffer) {
    ctx.postMessage({ type: 'error', requestId: request.requestId, message: 'no-samples' });
    return;
  }

  const bucketCount = Math.max(1, Math.floor(request.bucketCount));

  const start = performance.now();
  const wasm = await loadWasmModule();
  let peaks: Int16Array | null = null;
  let impl: 'wasm' | 'js' = 'js';

  if (wasm) {
    peaks = await computePeaksWasm(wasm, sampleBuffer, bucketCount);
    impl = 'wasm';
  }

  if (!peaks) {
    peaks = computePeaksJs(sampleBuffer, bucketCount);
    impl = 'js';
  }

  const durationMs = performance.now() - start;
  ctx.postMessage(
    {
      type: 'peaks-ready',
      requestId: request.requestId,
      peaks: peaks.buffer,
      bucketCount,
      impl,
      durationMs,
    },
    [peaks.buffer],
  );
};

ctx.addEventListener('message', (event: MessageEvent<WaveformWorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'load-samples') {
    samplesRef = new Float32Array(message.samples);
    ctx.postMessage({ type: 'samples-loaded', requestId: message.requestId, sampleCount: samplesRef.length });
    return;
  }

  if (message.type === 'compute-peaks') {
    void handleCompute(message);
    return;
  }
});
