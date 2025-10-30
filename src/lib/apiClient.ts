import type { ApiError } from './apiError';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequestOptions = {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function resolveBaseUrl(explicit?: string) {
  if (explicit !== undefined) return explicit;
  const fromEnv = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return fromEnv;
}

function mergeHeaders(extra?: Record<string, string>) {
  return {
    Accept: 'application/json',
    ...extra,
  };
}

function buildUrl(baseUrl: string, path: string) {
  if (baseUrl === '') return path;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function classifyAbort(e: unknown): 'abort' | 'timeout' | null {
  const name =
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    typeof (e as { name?: unknown }).name === "string"
      ? (e as { name: string }).name
      : "";
  if (name !== 'AbortError') return null;
  return 'abort';
}

async function safeReadText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

async function safeReadJson(text: string | undefined): Promise<unknown | undefined> {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = buildUrl(baseUrl, path);

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const timeoutId =
    timeoutMs > 0
      ? window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  try {
    const res = await fetch(url, {
      method,
      headers: mergeHeaders(options.headers),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get('content-type') ?? '';
    const text = await safeReadText(res);
    const maybeJson =
      contentType.includes('application/json') ? await safeReadJson(text) : undefined;

    if (!res.ok) {
      const err: ApiError = {
        kind: 'http',
        message: `HTTP ${res.status} ${res.statusText}`,
        url,
        method,
        status: res.status,
        statusText: res.statusText,
        responseText: text,
        responseJson: maybeJson,
      };
      throw err;
    }

    if (contentType.includes('application/json')) {
      if (maybeJson === undefined) {
        const err: ApiError = {
          kind: 'parse',
          message: 'Failed to parse JSON response',
          url,
          method,
          status: res.status,
          statusText: res.statusText,
          responseText: text,
        };
        throw err;
      }
      return maybeJson as T;
    }

    return (text as unknown) as T;
  } catch (e) {
    const abortKind = classifyAbort(e);
    if (abortKind) {
      const err: ApiError = {
        kind: timedOut ? 'timeout' : 'abort',
        message: timedOut ? `Request timed out (${timeoutMs}ms)` : 'Request aborted',
        url,
        method,
        cause: e,
      };
      throw err;
    }

    if (typeof e === 'object' && e !== null && 'kind' in e && 'message' in e) {
      throw e;
    }

    const err: ApiError = {
      kind: 'network',
      message: e instanceof Error ? e.message : 'Network error',
      url,
      method,
      cause: e,
    };
    throw err;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

export function apiGet<T>(path: string, options?: ApiRequestOptions) {
  return apiRequest<T>('GET', path, undefined, options);
}
