/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAKAMA_URL?: string;
  readonly VITE_NAKAMA_HTTP_KEY?: string;
  /** Absolute hub page in production (`https://<domain>/hub`). Dev default is `/hub/`. */
  readonly VITE_HUB_URL?: string;
}

declare module 'virtual:asset-index' {
  const files: string[];
  export default files;
}
