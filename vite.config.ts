import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

/**
 * Transora 构建配置
 *
 * - 目标内核 Chromium 111（docs/00 §G-1 结论：不支持 111 以下内核）
 * - 产物输出到 dist/，直接用于「加载已解压的扩展程序」
 * - MV3：manifest 由 src/manifest.config.ts 声明，@crxjs 负责改写为构建后路径
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [crx({ manifest })],
  build: {
    target: 'chrome111',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
})
