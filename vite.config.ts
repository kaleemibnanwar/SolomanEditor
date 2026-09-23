import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { mcpBridge } from "./vite/mcp-bridge";

export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  // `mcpBridge` serves the same MCP endpoint the desktop app hosts, so a plain
  // browser tab can hand an AI tool a URL too. Dev and preview only.
  plugins: [react(), mcpBridge()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // These ship their own WASM/worker loading (onnxruntime-web underneath), which
  // Vite's dependency pre-bundler tends to mangle — excluding them lets each
  // library resolve its own assets at runtime instead.
  optimizeDeps: {
    exclude: ["@huggingface/transformers", "kokoro-js", "onnxruntime-web"],
  },
}));
