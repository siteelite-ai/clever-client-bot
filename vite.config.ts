import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { productionPublicKey, validateSelfhostTestConfig } from "./scripts/selfhost-test-config.mjs";

if (process.env.VITE_DEPLOY_TARGET === 'selfhost-test') {
  if (process.env.SELFHOST_TEST_ARTIFACT_BUILDER !== '1') {
    throw new Error('Use build:selfhost-test; the widget must be isolated and re-versioned after Vite');
  }
  validateSelfhostTestConfig({
    url: process.env.VITE_SELFHOST_TEST_SUPABASE_URL,
    publicKey: process.env.VITE_SELFHOST_TEST_SUPABASE_PUBLIC_KEY,
    backendKind: process.env.VITE_SELFHOST_TEST_BACKEND_KIND,
    originalPublicKey: productionPublicKey(),
  });
} else if (process.env.VITE_DEPLOY_TARGET) {
  throw new Error('Unknown VITE_DEPLOY_TARGET; refusing an implicit production build');
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
}));
