/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAKAMA_URL?: string;
  readonly VITE_NAKAMA_HTTP_KEY?: string;
  readonly VITE_HUB_ORIGIN?: string;
}

declare module 'virtual:asset-index' {
  const files: string[];
  export default files;
}
