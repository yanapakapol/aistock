import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';

/**
 * Enumerate every cron fire time strictly between `since` and `until`,
 * interpreted in the routine's IANA timezone.
 *
 * Used on scheduler boot to discover missed fires since
 * `routines.last_run_at`. Returns Date instances in UTC (JS Date is always
 * UTC-internal); pair with Luxon when bucketing by local day.
 *
 * If `since >= until` (clock skew, fresh routine) we return [].
 * If the cron expression is invalid we throw — caller logs and skips.
 */
export function enumerateMissedFires(
  cronExpr: string,
  tz: string,
  since: Date,
  until: Date,
): Date[] {
  if (since >= until) return [];

  // currentDate is exclusive on the lower bound; endDate is exclusive on the
  // upper bound. We treat `since` as "the moment we last ran" so we want the
  // NEXT fire strictly after it, hence currentDate=since is correct.
  const iter = CronExpressionParser.parse(cronExpr, {
    currentDate: since,
    endDate: until,
    tz,
  });

  const fires: Date[] = [];
  // Guard against pathological expressions firing millions of times: hard
  // cap at 10k enumeration steps. The catch-up bucketer trims to <=3 anyway,
  // but enumeration itself shouldn't OOM.
  const HARD_CAP = 10_000;
  // cron-parser v5 throws when the iterator is exhausted; v4 returns null
  // for hasNext. We use the try/break form which works for both.
  for (let i = 0; i < HARD_CAP; i++) {
    try {
      const next = iter.next();
      fires.push(next.toDate());
    } catch {
      break;
    }
  }
  return fires;
}

/**
 * Bucket a list of missed fire times into "run today" vs "skip", per the
 * plan's catch-up rule:
 *
 *   - Same-day misses (in the routine's tz) → run the last 3 in chronological
 *     order.
 *   - Cross-day misses (any day other than the local "today") → skip.
 *
 * Note that the day comparison is done in the ROUTINE's tz, not the host's
 * tz — a routine pinned to Asia/Bangkok stays on Bangkok day boundaries even
 * if the server is in UTC.
 */
export function computeCatchupBatch(
  missed: Date[],
  tz: string,
  now: Date,
): { runToday: Date[]; skip: Date[] } {
  const nowLocal = DateTime.fromJSDate(now, { zone: tz });

  const sameDay: Date[] = [];
  const skip: Date[] = [];

  for (const d of missed) {
    const local = DateTime.fromJSDate(d, { zone: tz });
    if (local.hasSame(nowLocal, 'day')) {
      sameDay.push(d);
    } else {
      skip.push(d);
    }
  }

  // Keep at most the 3 most recent same-day fires, preserving chronological
  // order so the catch-up loop runs them oldest-first.
  sameDay.sort((a, b) => a.getTime() - b.getTime());
  const runToday = sameDay.length > 3 ? sameDay.slice(sameDay.length - 3) : sameDay;
  if (sameDay.length > 3) {
    // The older same-day fires that didn't make the top-3 cut are skipped
    // too — they belong to "today" but exceed the cap.
    skip.push(...sameDay.slice(0, sameDay.length - 3));
  }

  return { runToday, skip };
}
