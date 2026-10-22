const { test, describe } = require('node:test');
const assert = require('node:assert');
const { turnTimeLimitSeconds } = require('../server.js');

describe('Turn time limit', () => {
  test('scales with the number of circles', () => {
    assert.strictEqual(turnTimeLimitSeconds(3), 12);
    assert.strictEqual(turnTimeLimitSeconds(8), 22);
    assert.strictEqual(turnTimeLimitSeconds(20), 46);
  });

  test('clamps to the minimum and maximum', () => {
    assert.strictEqual(turnTimeLimitSeconds(0), 12);
    assert.strictEqual(turnTimeLimitSeconds(1), 12);
    assert.strictEqual(turnTimeLimitSeconds(50), 50);
  });
});
