interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DATASOURCE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
