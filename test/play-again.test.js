const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Room, restartRound, clearTurnTimeout } = require('../server.js');

function makeRoom(count, phase = 'over') {
  const room = new Room('TEST1');
  room.phase = phase;
  for (let i = 0; i < count; i++) {
    room.players.push({
      id: 'p' + i,
      ws: { fake: i },
      name: 'P' + i,
      best: 0,
      wins: 0,
      connected: true
    });
  }
  room.hostId = room.players[0] ? room.players[0].id : null;
  return room;
}

describe('Play again', () => {
  test('only the host can restart', () => {
    const room = makeRoom(2, 'over');
    const result = restartRound(room, 'p1');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(room.phase, 'over');
  });

  test('only an over round can be restarted', () => {
    const room = makeRoom(2, 'play');
    const result = restartRound(room, 'p0');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(room.phase, 'play');
  });

  test('restart resets the round state and keeps wins', () => {
    const room = makeRoom(3, 'over');
    room.n = 6;
    room.revealed = [1, 2, 3];
    room.next = 4;
    room.currentPlayerIndex = 2;
    room.flash = 5;
    room.locked = true;
    room.players[0].wins = 4;
    room.players[1].wins = 2;
    room.players[0].best = 6;
    room.players[1].best = 3;
    const oldTurnId = room.turnId;

    const result = restartRound(room, 'p0');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(room.phase, 'play');
    assert.deepStrictEqual(room.revealed, []);
    assert.strictEqual(room.next, 1);
    assert.strictEqual(room.currentPlayerIndex, 0);
    assert.strictEqual(room.flash, null);
    assert.strictEqual(room.locked, false);
    assert.strictEqual(room.n, 6);
    assert.strictEqual(room.circles.length, 6);
    assert.deepStrictEqual(room.players.map(p => p.wins), [4, 2, 0]);
    assert.deepStrictEqual(room.players.map(p => p.best), [6, 3, 0]);
    assert.strictEqual(room.turnId, oldTurnId + 1);
    assert.strictEqual(room.timerRunning, true);
    clearTurnTimeout(room);
  });
});
