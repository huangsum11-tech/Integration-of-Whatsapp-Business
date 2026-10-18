import { io, type Socket } from 'socket.io-client'

let socket: Socket | undefined

export function getSocket(): Socket {
  socket ??= io({ withCredentials: true })
  return socket
}

export function closeSocket() {
  socket?.disconnect()
  socket = undefined
}
