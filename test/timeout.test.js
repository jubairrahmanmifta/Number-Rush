// Use a tiny timer and delay so the timeout path is fast to test.
process.env.TURN_TIME_BASE_SECONDS = '0.3';
process.env.TURN_TIME_PER_CIRCLE_SECONDS = '0';
process.env.TURN_TIME_MIN_SECONDS = '0.3';
process.env.WRONG_PICK_DELAY_MS = '400';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Room, startRound, clearTurnTimeout } = require('../server.js');

function makeRoom(count) {
  const room = new Room('TEST1');
  room.n = 3;
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Turn timeout', () => {
  test('shows the timeout event, then resets the sequence and passes the turn', async () => {
    const room = makeRoom(2);
    startRound(room);
    const firstTurnId = room.turnId;
    room.revealed = [1];
    room.next = 2;

    assert.strictEqual(room.timerRunning, true);

    // After the (fast) timer has fired but during the broken-sequence delay.
    await wait(500);
    assert.strictEqual(room.phase, 'play');
    assert.strictEqual(room.locked, true);
    assert.strictEqual(room.timerRunning, false);
    assert.deepStrictEqual(room.lastEvent, { type: 'timeout', playerName: 'P0' });
    assert.deepStrictEqual(room.revealed, [1]);
    assert.strictEqual(room.next, 2);
    assert.strictEqual(room.currentPlayerIndex, 0);

    // After the delay the board is face down and the next player has a fresh timer.
    await wait(300);
    assert.strictEqual(room.locked, false);
    assert.deepStrictEqual(room.revealed, []);
    assert.strictEqual(room.next, 1);
    assert.strictEqual(room.currentPlayerIndex, 1);
    assert.strictEqual(room.lastEvent, null);
    assert.strictEqual(room.timerRunning, true);
    assert.strictEqual(room.turnId, firstTurnId + 1);
    assert(room.timeLimitMs > 0);
    clearTurnTimeout(room);
  });

  test('a single player gets the turn back with a fresh timer', async () => {
    const room = makeRoom(1);
    startRound(room);
    const firstTurnId = room.turnId;

    await wait(800);
    assert.strictEqual(room.phase, 'play');
    assert.strictEqual(room.currentPlayerIndex, 0);
    assert.strictEqual(room.players[room.currentPlayerIndex].id, 'p0');
    assert.strictEqual(room.locked, false);
    assert.strictEqual(room.timerRunning, true);
    assert.strictEqual(room.turnId, firstTurnId + 1);
    clearTurnTimeout(room);
  });
});
