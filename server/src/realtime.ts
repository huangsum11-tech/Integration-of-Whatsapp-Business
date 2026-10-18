import type { Server } from 'socket.io'

let io: Server | undefined

export function setIo(server: Server) {
  io = server
}

/** Broadcast to every signed-in teammate. The inbox is shared, so everyone sees everything. */
export function broadcast(event: string, payload: unknown) {
  io?.to('team').emit(event, payload)
}
