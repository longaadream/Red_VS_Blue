/** Process-local fence between room creation and an Electron-owned update.
 * Registration happens before onCreate's first await, including restored rooms.
 * Only the parent IPC channel can acquire/release the fence. */
export class UpdateAdmission {
  private rooms = new Set<symbol>()
  constructor(private token: string | null = null) {}
  enterRoom(): () => void {
    if (this.token) throw new Error('主机正在更新资源，请稍后重连')
    const id = Symbol('room'); this.rooms.add(id)
    return () => { this.rooms.delete(id) }
  }
  status() { return { idle: this.rooms.size === 0, paused: this.token !== null } }
  acquire(token: string) {
    if (!token || this.rooms.size || this.token && this.token !== token) return false
    this.token = token; return true
  }
  release(token: string) { if (this.token === token) this.token = null }
}
