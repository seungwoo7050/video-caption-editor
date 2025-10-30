export type DataSourceKind = 'mock' | 'api';

const DEFAULT_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_DATASOURCE: DataSourceKind = 'mock';

function normalizeNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type AppEnv = {
  apiBaseUrl: string;
  datasource: DataSourceKind;
  raw: {
    VITE_API_BASE_URL?: string;
    VITE_DATASOURCE?: string;
  };
};

export function getAppEnv(): AppEnv {
  const rawApiBaseUrl = normalizeNonEmpty(import.meta.env.VITE_API_BASE_URL);
  const rawDatasource = normalizeNonEmpty(import.meta.env.VITE_DATASOURCE);

  const apiBaseUrl = rawApiBaseUrl ?? DEFAULT_API_BASE_URL;

  const datasource: DataSourceKind =
    rawDatasource === 'api' || rawDatasource === 'mock' ? rawDatasource : DEFAULT_DATASOURCE;

  return {
    apiBaseUrl,
    datasource,
    raw: {
      VITE_API_BASE_URL: rawApiBaseUrl,
      VITE_DATASOURCE: rawDatasource,
    },
  };
}

let didLog = false;

export function logAppEnvOnce(): void {
  if (!import.meta.env.DEV) return;
  if (didLog) return;
  didLog = true;

  const env = getAppEnv();

  console.info('[env] raw:', env.raw);

  console.info('[env] resolved:', {
    apiBaseUrl: env.apiBaseUrl,
    datasource: env.datasource,
  });
}