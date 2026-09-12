/** Same-process authority lease; held through disconnect grace and released on room disposal. */
const rooms = new Set<string>()
export function acquireAdventureLease(roomId:string) {
  if (process.env.RVB_PROFILE_ADMISSION_PAUSED) throw new Error('资源切换中，暂不能创建冒险')
  rooms.add(roomId)
}
export function releaseAdventureLease(roomId:string) { rooms.delete(roomId) }
export function adventureLeaseRoomIds() { return [...rooms] }
