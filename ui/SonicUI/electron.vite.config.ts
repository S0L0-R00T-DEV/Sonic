import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // Koffi ships a native addon. Keep it external so its loader resolves the real .node binary
    // from node_modules instead of bundling/chunking native binaries into invalid JS chunks.
    build: {
      rollupOptions: {
        external: ['koffi', 'bittorrent-peerid']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        cn: resolve('src/renderer/src/cn.ts'),
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 777,
      strictPort: true
    }
  }
})
