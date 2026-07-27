import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendTarget = env.VITE_BACKEND_URL || "http://localhost:5001";

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      allowedHosts: [".loca.lt", "localhost", "127.0.0.1"],
      proxy: {
        "/socket.io": {
          target: backendTarget,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
