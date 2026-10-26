interface ImportMetaEnv {
  /** Default backend URL. Local default: http://localhost:3000. */
  readonly VITE_BACKEND_URL?: string;
  /** The backend's upload limit in MB, for the check before uploading. */
  readonly VITE_MAX_UPLOAD_MB?: string;
}

/** The local server's AUTH_KEY under `vite dev`; "" in builds (vite.config.ts). */
declare const __DEV_API_KEY__: string;
