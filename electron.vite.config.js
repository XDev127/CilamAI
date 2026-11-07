import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { devLifecycle } from './plugins/dev-lifecycle.js'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    server: {
      hmr: {
        overlay: false
      }
    },
    plugins: [devLifecycle()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          feedback: resolve(__dirname, 'src/renderer/feedback.html'),
          signin: resolve(__dirname, 'src/renderer/signin.html')
        }
      }
    }
  }
})
