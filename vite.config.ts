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
  /**
   * F6 关于页要显示真实的「构建日期」。
   * 写成常量会立刻过期，写成运行时 `new Date()` 会变成「打开页面的日期」——
   * 都不可信。这里在构建时烧进去，一次构建一个日期，口径才成立。
   */
  define: {
    __TRANSORA_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
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
