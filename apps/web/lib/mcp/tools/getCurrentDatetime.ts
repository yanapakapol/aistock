import { z } from 'zod';
import type { ToolHandler } from '../types';

const input = z.object({}).strict();
const output = z.object({
  iso: z.string(),
  date: z.string(),
  year: z.number(),
  month: z.number(),
  day: z.number(),
  weekday: z.string(),
  tz_local: z.string(),
  tz_offset_min: z.number(),
  six_months_ago: z.string(),
  twelve_months_ago: z.string(),
});

export const getCurrentDatetime: ToolHandler<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: 'get_current_datetime',
  description:
    'Returns the real wall-clock date/time on the server. ALWAYS call this when you need to know "today", "recent", or to validate that news article dates are current — never assume a date from your training data.',
  input,
  output,
  async execute() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    });
    const sixMo = new Date(now.getTime() - 183 * 86400_000);
    const twelveMo = new Date(now.getTime() - 365 * 86400_000);
    return {
      iso: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      weekday: fmt.format(now),
      tz_local: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tz_offset_min: -now.getTimezoneOffset(),
      six_months_ago: sixMo.toISOString().slice(0, 10),
      twelve_months_ago: twelveMo.toISOString().slice(0, 10),
    };
  },
};
