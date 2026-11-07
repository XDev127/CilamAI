import { createLogger } from 'vite'

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

const label = (name, color) => `${color}[${name}]${c.reset}`
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`)

export function devLifecycle() {
  let connected = false
  let warned = false
  let errored = false
  let failed = false
  const t0 = Date.now()
  let buildT = 0

  const stamp = () => {
    const d = new Date()
    const p = (n, l = 2) => String(n).padStart(l, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  const info = (msg) => process.stdout.write(`${c.gray}${stamp()}${c.reset} ${msg}\n`)

  return {
    name: 'dev-lifecycle',
    apply: 'serve',

    config(config) {
      const base = config.customLogger ?? createLogger()
      return {
        customLogger: {
          ...base,
          warnOnce: (msg, opts) => {
            warned = true
            console.warn(`${label('warning', c.yellow)} ${msg}`)
          },
          error: (err, opts) => {
            const text = err && err.message ? err.message : String(err)
            if (/build failed/i.test(text)) {
              failed = true
              console.error(`${label('failed', c.red)} ${text}`)
            } else {
              errored = true
              console.error(`${label('error', c.red)} ${text}`)
            }
          },
        },
      }
    },

    configureServer(server) {
      info(`${label('connecting', c.cyan)} starting dev server...`)

      server.httpServer?.once('listening', () => {
        connected = true
        const addr = server.httpServer?.address()
        const port = addr && typeof addr === 'object' ? addr.port : ''
        info(`${label('connected', c.green)} ready in ${fmtMs(Date.now() - t0)}${port ? ` (renderer :${port})` : ''}`)
      })

      server.hot?.on?.('full-reload', () => {
        info(`${label('updated-files', c.cyan)} full reload`)
      })
      server.watcher?.on('change', (file) => {
        info(`${label('updated-files', c.cyan)} ${file.replace(/\\/g, '/')}`)
      })
    },

    buildStart() {
      buildT = Date.now()
    },

    buildEnd() {
      const dur = fmtMs(Date.now() - buildT)
      if (failed) {
        info(`${label('failed', c.red)} dev server startup failed (${dur})`)
      } else if (errored) {
        info(`${label('error', c.red)} build completed with errors (${dur})`)
      } else if (warned) {
        info(`${label('warning', c.yellow)} build completed with warnings (${dur})`)
      } else if (connected) {
        info(`${label('connected', c.green)} build ok in ${dur}`)
      }
    },

    watchChange(id) {
      info(`${label('updated-files', c.cyan)} ${id.replace(/\\/g, '/')}`)
    },

    transformError(err) {
      errored = true
      console.error(`${label('error', c.red)} ${err.message}`)
    },
  }
}

export default devLifecycle
