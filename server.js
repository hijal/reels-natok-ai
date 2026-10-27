#!/usr/bin/env node
/**
 * MiniMax H3 Studio
 * Server entry point for Next.js 16.
 */
process.env.NODE_ENV = 'production'
process.env.NEXT_TELEMETRY_DISABLED = '1'

const http = require('http')
const next = require('next')

const dir = __dirname
// Default to loopback: binding 0.0.0.0 triggers a Windows Firewall prompt on
// fresh machines. Set BIND_HOST=0.0.0.0 to expose the UI on the LAN.
const hostname = process.env.BIND_HOST || '127.0.0.1'
// (fix 716) PORT is validated: 'abc' -> NaN, 99999 -> out of range.
// Reject invalid values before starting the web server.
const parsedPort = parseInt(process.env.PORT || '3000', 10)
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`)
  process.exit(1)
}
const port = parsedPort

// Handle uncaught exceptions gracefully (e.g. "Controller is already closed")
// (fix 716) Log FULL error object: err.message on non-Errors
// is undefined, which previously logged "Uncaught Exception: undefined".
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err)
  // Don't exit — let the server keep running
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason)
})

async function start() {
  const app = next({
    dir,
    hostname,
    port,
    dev: false,
  })

  await app.prepare()

  const server = http.createServer((req, res) => {
    // (fix 716) requestHandler is an ASYNC function, its promise must be
    // handled. Previously it was dropped, so on reject the request HUNG WITHOUT
    // RESPONSE (client waited until its timeout) — including readiness probes.
    Promise.resolve(app.requestHandler(req, res)).catch((err) => {
      console.error('Request failed:', err && err.stack ? err.stack : err)
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
        }
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } catch { /* connection already closed */ }
    })
  })

  // (fix 587) Previously server 'error' (EADDRINUSE etc.) went to
  // uncaughtException handler above and was SWALLOWED: process continued
  // living without serving anything — invisible zombie under start /b, while readiness probe
  // in start.bat could pass based on responses from OLD server.
  server.on('error', (err) => {
    console.error('Server error (fatal):', err.message)
    process.exit(1)
  })

  server.listen(port, hostname, () => {
    console.log(`  Web UI:   http://localhost:${port}`)
    console.log(`  ComfyUI:  http://127.0.0.1:${process.env.COMFY_PORT || 8188}`)
  })

  // Graceful shutdown
  // (fix 587) close() waits for browser keep-alive connections forever —
  // forcibly close connections and set forced exit timer
  // so termination always actually terminates the process.
  const shutdown = (sig) => {
    console.log(`[server] ${sig} received, shutting down.`)
    server.close(() => process.exit(0))
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
