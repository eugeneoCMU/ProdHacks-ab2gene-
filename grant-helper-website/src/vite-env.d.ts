/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GRANT_API: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
