import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { attachSocketErrorHandler } from './server.js'

test('ignores expected client disconnect errors on HTTP sockets', () => {
    const server = new EventEmitter()
    const socket = new EventEmitter()
    const errors = []
    attachSocketErrorHandler(server, (error) => errors.push(error))

    server.emit('connection', socket)
    socket.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    socket.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))

    assert.deepEqual(errors, [])
})

test('reports unexpected HTTP socket errors', () => {
    const server = new EventEmitter()
    const socket = new EventEmitter()
    const error = new Error('socket failed')
    const errors = []
    attachSocketErrorHandler(server, (value) => errors.push(value))

    server.emit('connection', socket)
    socket.emit('error', error)

    assert.deepEqual(errors, [error])
})
