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
