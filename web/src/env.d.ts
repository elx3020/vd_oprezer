interface ImportMetaEnv {
  /** Default backend URL. Local default: http://localhost:3000. */
  readonly VITE_BACKEND_URL?: string;
  /** The backend's upload limit in MB, for the check before uploading. */
  readonly VITE_MAX_UPLOAD_MB?: string;
}
