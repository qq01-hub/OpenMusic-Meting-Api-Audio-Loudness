import { serve } from '@hono/node-server'
import { app, attachSocketErrorHandler } from './server.js'

const port = Number(process.env.PORT || 3100)
const server = attachSocketErrorHandler(
    serve({ fetch: app.fetch, port }, (info) => console.log(`audio-loudness listening on http://0.0.0.0:${info.port}`)),
)

export { server }
