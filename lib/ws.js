/**
 * A dependency-free RFC 6455 server endpoint.
 *
 * The bridge needs exactly one thing from WebSocket: a loopback socket that can
 * carry JSON both ways with a Chrome extension. Pulling a package for that would
 * add an install step and a supply-chain surface to a plugin that otherwise
 * depends on nothing, so this module implements the server half directly:
 * handshake, unmasking, fragmentation, ping/pong, and close.
 *
 * Only what the bridge uses is implemented. No compression, no subprotocols, no
 * client role.
 */
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Encode one unmasked server frame. */
function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/**
 * Complete the HTTP upgrade and return a peer, or reject the socket.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head - Bytes already read by the HTTP parser.
 * @param {(peer: WsPeer) => void} onPeer
 * @param {(reason: string) => void} [onReject]
 */
export function upgradeToWebSocket(request, socket, head, onPeer, onReject) {
  const key = request.headers['sec-websocket-key']
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
  const version = String(request.headers['sec-websocket-version'] ?? '')
  if (request.method !== 'GET' || upgrade !== 'websocket' || !key || version !== '13') {
    reject(socket, '400 Bad Request', 'not a WebSocket handshake')
    onReject?.('not a WebSocket handshake')
    return
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    ''
  ].join('\r\n')
  socket.write(headers)
  socket.setNoDelay(true)
  const peer = new WsPeer(socket)
  if (head && head.length > 0) peer.push(head)
  onPeer(peer)
}

function reject(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
  } catch {
    // The socket may already be gone; nothing useful to do.
  }
  socket.destroy()
}

/** One accepted WebSocket connection. */
export class WsPeer {
  /** @param {import('node:stream').Duplex} socket */
  constructor(socket) {
    this.socket = socket
    this.closed = false
    this.onMessage = null
    this.onClose = null
    this.onError = null
    this.#buffer = Buffer.alloc(0)
    this.#fragments = []
    this.#fragmentOpcode = 0
    this.#fragmentBytes = 0

    socket.on('data', (chunk) => this.push(chunk))
    socket.on('close', () => this.#finish())
    socket.on('end', () => this.#finish())
    socket.on('error', (error) => {
      this.onError?.(error)
      this.#finish()
    })
  }

  #buffer
  #fragments
  #fragmentOpcode
  #fragmentBytes
  #finished = false

  /** Feed raw socket bytes into the frame parser. */
  push(chunk) {
    if (this.closed) return
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])
    this.#drain()
  }

  #drain() {
    for (;;) {
      if (this.#buffer.length < 2) return
      const b0 = this.#buffer[0]
      const b1 = this.#buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2

      if (length === 126) {
        if (this.#buffer.length < 4) return
        length = this.#buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.#buffer.length < 10) return
        const big = this.#buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.close(1009, 'message too large')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.close(1009, 'message too large')
        return
      }

      let maskKey = null
      if (masked) {
        if (this.#buffer.length < offset + 4) return
        maskKey = this.#buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.#buffer.length < offset + length) return

      let payload = this.#buffer.subarray(offset, offset + length)
      if (maskKey) {
        const unmasked = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3]
        payload = unmasked
      }
      this.#buffer = this.#buffer.subarray(offset + length)

      this.#handleFrame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  #handleFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this.#write(OP_PONG, payload)
      return
    }
    if (opcode === OP_PONG) return
    if (opcode === OP_CLOSE) {
      this.close(1000, '')
      return
    }
    if (opcode === OP_BINARY) {
      this.close(1003, 'binary frames are not supported')
      return
    }
    if (opcode === OP_CONTINUATION && this.#fragmentOpcode !== OP_TEXT) {
      // A continuation without a started text message is a protocol error.
      this.close(1002, 'unexpected continuation')
      return
    }
    if (opcode === OP_TEXT || opcode === OP_CONTINUATION) {
      if (opcode === OP_TEXT) {
        this.#fragmentOpcode = OP_TEXT
        this.#fragments = []
        this.#fragmentBytes = 0
      }
      this.#fragments.push(payload)
      this.#fragmentBytes += payload.length
      if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
        this.close(1009, 'message too large')
        return
      }
      if (!fin) return
      const text = Buffer.concat(this.#fragments).toString('utf8')
      this.#fragments = []
      this.#fragmentBytes = 0
      this.onMessage?.(text)
    }
  }

  #write(opcode, payload) {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(opcode, payload))
    } catch (error) {
      this.onError?.(error)
      this.#finish()
    }
  }

  /** Send one JSON value as a text frame. */
  sendText(text) {
    this.#write(OP_TEXT, Buffer.from(text, 'utf8'))
  }

  /** Send one JSON value. */
  send(value) {
    this.sendText(JSON.stringify(value))
  }

  /** Close the socket once. */
  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 120)
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      // Ignore: the socket is going away anyway.
    }
    this.closed = true
    setTimeout(() => {
      try {
        this.socket.end()
      } catch {
        // Already closed.
      }
      this.#finish()
    }, 50).unref?.()
  }

  #finish() {
    if (this.#finished) return
    this.#finished = true
    this.closed = true
    this.onClose?.()
  }
}
