import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => ({
  // Relative asset paths: works under /vd_oprezer/ on GitHub Pages and on a custom domain.
  base: "./",
  define: {
    // `vite dev` only: the server's AUTH_KEY from the repo root's .env.local, so one
    // file holds the key. Builds get "": a key in a static site is public.
    __DEV_API_KEY__: JSON.stringify(command === "serve" ? (loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "AUTH_KEY").AUTH_KEY ?? "") : ""),
  },
}));
