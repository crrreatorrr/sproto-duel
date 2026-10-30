/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAKAMA_URL?: string;
  /** Absolute hub page in production (`https://<domain>/hub`). Dev default is `/hub/`. */
  readonly VITE_HUB_URL?: string;
  /**
   * Vite `base` for this build. Unset keeps `./` (see vite.config.ts), so the same build is served
   * from `/play/sproto-duel/` and from `https://play.<domain>/sproto-duel/`.
   */
  readonly VITE_BASE?: string;
}

declare module 'virtual:asset-index' {
  const files: string[];
  export default files;
}
