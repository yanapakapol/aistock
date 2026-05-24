import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DateTime } from 'luxon';
import { computeCatchupBatch, enumerateMissedFires } from '../catchup';

describe('enumerateMissedFires', () => {
  it('returns one fire per local day for a daily cron over 3 days', () => {
    // "0 8 * * *" Asia/Bangkok = every day at 08:00 GMT+7 = 01:00 UTC.
    // Pick `now` deterministically and walk 3 days back.
    const tz = 'Asia/Bangkok';
    const now = DateTime.fromISO('2026-05-24T05:00:00', { zone: tz }).toJSDate();
    const since = DateTime.fromISO('2026-05-21T05:00:00', { zone: tz }).toJSDate();

    const fires = enumerateMissedFires('0 8 * * *', tz, since, now);

    // 08:00 on May 21, 22, 23 are all in (since, now). May 24 08:00 hasn't
    // happened yet because `now` is 05:00 local on the 24th.
    assert.equal(fires.length, 3);

    // Each fire should be at 08:00 local Bangkok time.
    for (const f of fires) {
      const local = DateTime.fromJSDate(f, { zone: tz });
      assert.equal(local.hour, 8);
      assert.equal(local.minute, 0);
    }
  });

  it('returns [] when since >= until', () => {
    const t = new Date('2026-05-24T00:00:00Z');
    assert.deepEqual(enumerateMissedFires('0 8 * * *', 'UTC', t, t), []);
    assert.deepEqual(
      enumerateMissedFires('0 8 * * *', 'UTC', new Date(t.getTime() + 1000), t),
      [],
    );
  });
});

describe('computeCatchupBatch', () => {
  const tz = 'Asia/Bangkok';
  const now = DateTime.fromISO('2026-05-24T15:00:00', { zone: tz }).toJSDate();

  it('returns up to 3 when all misses are same-day', () => {
    const misses = [
      DateTime.fromISO('2026-05-24T08:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T09:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T10:00:00', { zone: tz }).toJSDate(),
    ];
    const { runToday, skip } = computeCatchupBatch(misses, tz, now);
    assert.equal(runToday.length, 3);
    assert.equal(skip.length, 0);
    // Chronological order preserved.
    for (let i = 1; i < runToday.length; i++) {
      assert.ok(runToday[i].getTime() > runToday[i - 1].getTime());
    }
  });

  it('caps same-day to the 3 most recent and pushes overflow into skip', () => {
    const misses = [
      DateTime.fromISO('2026-05-24T06:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T07:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T08:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T09:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T10:00:00', { zone: tz }).toJSDate(),
    ];
    const { runToday, skip } = computeCatchupBatch(misses, tz, now);
    assert.equal(runToday.length, 3);
    assert.equal(skip.length, 2);
    // runToday should be the 3 most recent.
    const runHours = runToday.map((d) => DateTime.fromJSDate(d, { zone: tz }).hour);
    assert.deepEqual(runHours, [8, 9, 10]);
  });

  it('puts cross-day misses in skip and keeps same-day misses in runToday', () => {
    const misses = [
      // 2 days ago — cross day, skip
      DateTime.fromISO('2026-05-22T08:00:00', { zone: tz }).toJSDate(),
      // yesterday — cross day, skip
      DateTime.fromISO('2026-05-23T08:00:00', { zone: tz }).toJSDate(),
      // today, two same-day fires
      DateTime.fromISO('2026-05-24T08:00:00', { zone: tz }).toJSDate(),
      DateTime.fromISO('2026-05-24T12:00:00', { zone: tz }).toJSDate(),
    ];
    const { runToday, skip } = computeCatchupBatch(misses, tz, now);
    assert.equal(runToday.length, 2);
    assert.equal(skip.length, 2);
    for (const r of runToday) {
      assert.equal(DateTime.fromJSDate(r, { zone: tz }).day, 24);
    }
    for (const s of skip) {
      assert.notEqual(DateTime.fromJSDate(s, { zone: tz }).day, 24);
    }
  });

  it('respects the routine tz when bucketing days, not the host tz', () => {
    // 2026-05-24T18:00 UTC = 2026-05-25T01:00 Bangkok (NEXT day local).
    // If we set `now` to that UTC instant, then a fire at 2026-05-24T20:00
    // local Bangkok (which is 2026-05-24T13:00 UTC) is yesterday in
    // Bangkok and must go to skip even though it's "today" in UTC.
    const nowBkk = DateTime.fromISO('2026-05-25T01:00:00', { zone: tz }).toJSDate();
    const fireBkkYesterday = DateTime.fromISO('2026-05-24T20:00:00', { zone: tz }).toJSDate();
    const fireBkkToday = DateTime.fromISO('2026-05-25T00:30:00', { zone: tz }).toJSDate();

    const { runToday, skip } = computeCatchupBatch(
      [fireBkkYesterday, fireBkkToday],
      tz,
      nowBkk,
    );
    assert.equal(runToday.length, 1);
    assert.equal(skip.length, 1);
    assert.equal(DateTime.fromJSDate(runToday[0], { zone: tz }).day, 25);
    assert.equal(DateTime.fromJSDate(skip[0], { zone: tz }).day, 24);
  });
});
