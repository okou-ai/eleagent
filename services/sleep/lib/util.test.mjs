import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, localTime, previousDay, scheduledStart, zonedDateTime } from './util.mjs';

test('Los Angeles calendar dates and source anchors preserve daylight-saving changes', () => {
  assert.equal(localDate(new Date('2026-03-08T07:30:00Z')), '2026-03-07');
  assert.equal(previousDay('2026-03-09'), '2026-03-08');
  const start = zonedDateTime('2026-03-08');
  const end = zonedDateTime('2026-03-09');
  assert.equal(end - start, 23 * 3_600_000);
  assert.equal(zonedDateTime('2026-03-08', 5, 30).toISOString(), '2026-03-08T12:30:00.000Z');
  assert.equal(localTime('2026-11-01T13:30:00Z'), '05:30');
  assert.equal(zonedDateTime('2026-11-02') - zonedDateTime('2026-11-01'), 25 * 3_600_000);
  assert.throws(() => zonedDateTime('2026-03-08', 2, 30), /does not exist/);
});

test('a nonexistent 02:30 schedule advances to 03:00 without changing evidence timestamps', () => {
  assert.equal(scheduledStart('2026-03-08', 150).toISOString(), '2026-03-08T10:00:00.000Z');
  assert.equal(scheduledStart('2026-03-09', 150).toISOString(), '2026-03-09T09:30:00.000Z');
  assert.throws(() => zonedDateTime('2026-03-08', 2, 30), /does not exist/);
});

test('schedule advancement never crosses the exclusive acquisition deadline', () => {
  assert.equal(scheduledStart('2026-03-08', 150, 180), null);
  assert.throws(() => scheduledStart('2026-03-08', 300), /Invalid scheduling window/);
});
