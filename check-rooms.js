const { roomStore } = require('./lib/game/room-store');

console.log('Current rooms in store:');
const rooms = Array.from(roomStore.getRooms().values());
console.log('Total rooms:', rooms.length);
rooms.forEach(room => {
  console.log('Room:', {
    id: room.id,
    name: room.name,
    status: room.status,
    players: room.players.length,
    hostId: room.hostId
  });
});

// 尝试删除所有房间
console.log('\nAttempting to delete all rooms:');
rooms.forEach(room => {
  console.log(`Deleting room ${room.id}...`);
  const result = roomStore.deleteRoom(room.id);
  console.log(`Delete result: ${result}`);
});

// 检查删除后的状态
console.log('\nRooms after deletion:');
const remainingRooms = Array.from(roomStore.getRooms().values());
console.log('Total rooms:', remainingRooms.length);
remainingRooms.forEach(room => {
  console.log('Remaining room:', {
    id: room.id,
    name: room.name,
    status: room.status,
    players: room.players.length,
    hostId: room.hostId
  });
});
