/* Area Caller — the pipeline's date logic and calendar handoff.
 *
 * ONE implementation, loaded by the browser as a plain script and required by
 * the Worker's test suite in node, so what ships is what is tested.
 *
 * ---------------------------------------------------------------------------
 * TIMEZONE, PINNED
 *
 * Every date this file touches is a LOCAL WALL-CLOCK string with no zone on it:
 *
 *   follow_up_date  'YYYY-MM-DD'
 *   meeting_at      'YYYY-MM-DDTHH:MM'
 *
 * "Today" is the BROWSER'S today. The server never decides it — `GET /api/agenda`
 * returns these strings verbatim and the comparison happens here. For a
 * single-user tool in one timezone that is both simpler and more correct than
 * storing UTC: he books "Tuesday 2pm", it stays 2pm, and it is still 2pm if he
 * opens the tool from another state.
 *
 * The trap this file exists to avoid: `new Date('2026-08-30')` parses as
 * MIDNIGHT UTC, which is the previous day for anyone west of Greenwich — so a
 * follow-up due today would read as overdue, or a meeting today would vanish
 * from the panel. Nothing here ever passes a date string to `new Date`. Local
 * dates are built with the `new Date(y, m - 1, d)` constructor, which is local
 * by definition.
 * ------------------------------------------------------------------------- */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AreaAgenda = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

  const isLocalDate = (s) => typeof s === 'string' && DATE_RE.test(s);
  const isLocalDateTime = (s) => typeof s === 'string' && DATETIME_RE.test(s);

  const pad = (n) => String(n).padStart(2, '0');

  /** The local calendar date of `now`, as 'YYYY-MM-DD'. */
  function todayISO(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** 'YYYY-MM-DD' → a LOCAL midnight Date. Never `new Date(str)`. */
  function localDate(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  /** The date part of either a date or a datetime string. */
  const datePart = (s) => String(s || '').slice(0, 10);

  /** `days` after the local date of `now`, as 'YYYY-MM-DD'. */
  function addDays(days, now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + days);
    return todayISO(d);
  }

  /** Whole days from today to `iso`. Negative = overdue. */
  function daysUntil(iso, now = new Date()) {
    const from = localDate(todayISO(now));
    const to = localDate(datePart(iso));
    return Math.round((to - from) / 86400000);
  }

  /** The quick follow-up chips. One tap, no modal. */
  const FOLLOW_UP_CHIPS = [
    { key: 'tomorrow', label: 'Tomorrow', days: 1 },
    { key: 'three_days', label: 'In 3 days', days: 3 },
    { key: 'next_week', label: 'Next week', days: 7 },
  ];

  function followUpDateFor(chipKey, now = new Date()) {
    const chip = FOLLOW_UP_CHIPS.find((c) => c.key === chipKey);
    return chip ? addDays(chip.days, now) : null;
  }

  /* ---- the pipeline ----
     No gray zone. `out` and `lost` are terminal, and terminal here means the
     row leaves the working list — not that it is unreachable. Every status is
     reversible, because a wrong tap must be undoable. */
  const STATUSES = [
    { key: 'not_called', label: 'Not called', stage: 'open' },
    { key: 'no_answer', label: 'No answer', stage: 'retry' },
    { key: 'voicemail', label: 'Voicemail', stage: 'retry' },
    { key: 'out', label: 'Out', stage: 'closed' },
    { key: 'meeting_set', label: 'Meeting set', stage: 'meeting' },
    { key: 'won', label: 'Won', stage: 'meeting' },
    { key: 'lost', label: 'Lost', stage: 'meeting' },
  ];
  const STATUS_KEYS = STATUSES.map((s) => s.key);
  const RETRYABLE = ['no_answer', 'voicemail'];
  /** Everything that got as far as a booked brainstorm — the funnel's third stage. */
  const MEETING_STATUSES = ['meeting_set', 'won', 'lost'];

  const statusLabel = (key) => STATUSES.find((s) => s.key === key)?.label || key;

  /**
   * A row's meeting is only live while it is still `meeting_set`. A meeting_at
   * on a won, lost or re-opened row is kept in the database and simply not
   * surfaced — inert, never deleted.
   */
  const hasLiveMeeting = (row) =>
    row.status === 'meeting_set' && isLocalDateTime(row.meeting_at);

  /** Likewise a follow-up only counts while the row is still retryable. */
  const hasLiveFollowUp = (row) =>
    RETRYABLE.includes(row.status) && isLocalDate(row.follow_up_date);

  /**
   * Split agenda rows into what the Today panel shows.
   *
   * - `meetingsToday`  — meeting_at falls on the local today, earliest first.
   * - `meetingsUpcoming` — the next 7 days after today, collapsed in the UI.
   * - `followUpsDue`   — due today or overdue, OLDEST FIRST, because the one
   *                      that has been waiting longest is the one to call.
   *
   * A meeting whose time has already passed today still shows: the tool must
   * not quietly drop a 9am meeting at 9:05, when what he actually needs is to
   * mark it won or lost.
   */
  function classifyAgenda(rows, now = new Date(), upcomingDays = 7) {
    const meetingsToday = [];
    const meetingsUpcoming = [];
    const followUpsDue = [];

    for (const row of rows || []) {
      if (hasLiveMeeting(row)) {
        const delta = daysUntil(row.meeting_at, now);
        if (delta === 0) meetingsToday.push(row);
        else if (delta > 0 && delta <= upcomingDays) meetingsUpcoming.push(row);
      }
      if (hasLiveFollowUp(row) && daysUntil(row.follow_up_date, now) <= 0) {
        followUpsDue.push(row);
      }
    }

    const byMeeting = (a, b) => String(a.meeting_at).localeCompare(String(b.meeting_at));
    meetingsToday.sort(byMeeting);
    meetingsUpcoming.sort(byMeeting);
    followUpsDue.sort(
      (a, b) =>
        String(a.follow_up_date).localeCompare(String(b.follow_up_date)) ||
        String(a.name || '').localeCompare(String(b.name || ''))
    );
    return { meetingsToday, meetingsUpcoming, followUpsDue };
  }

  /** "2:00 PM" from a local datetime string, without going through Date parsing. */
  function formatTime(meetingAt) {
    if (!isLocalDateTime(meetingAt)) return '';
    const [h, m] = meetingAt.slice(11).split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${pad(m)} ${suffix}`;
  }

  /** "Tue 2 Sep" — short, unambiguous, no year unless it differs. */
  function formatDate(iso, now = new Date()) {
    if (!iso) return '';
    const d = localDate(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const base = `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
    return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
  }

  /** "3 days overdue" / "due today" — for the follow-up rows. */
  function dueLabel(iso, now = new Date()) {
    const delta = daysUntil(iso, now);
    if (delta === 0) return 'due today';
    if (delta === -1) return '1 day overdue';
    if (delta < 0) return `${-delta} days overdue`;
    if (delta === 1) return 'due tomorrow';
    return `due in ${delta} days`;
  }

  const DEFAULT_MEETING_MINUTES = 45;

  /** 'YYYY-MM-DDTHH:MM' → Google's compact local form 'YYYYMMDDTHHMMSS'. */
  function calendarStamp(meetingAt, addMinutes = 0) {
    const [datePartStr, timePart] = meetingAt.split('T');
    const [y, m, d] = datePartStr.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    const dt = new Date(y, m - 1, d, hh, mm + addMinutes);
    return (
      `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}` +
      `T${pad(dt.getHours())}${pad(dt.getMinutes())}00`
    );
  }

  /**
   * A prefilled Google Calendar link. No OAuth, no integration, nothing to
   * authenticate — it opens a pre-populated event form in whatever account he
   * is already signed into.
   *
   * The `dates` values carry NO trailing Z, which is what tells Google to read
   * them in the calendar's own timezone. That is the same wall-clock promise the
   * stored string makes, so a 2pm meeting lands at 2pm.
   */
  function calendarLink(row, minutes = DEFAULT_MEETING_MINUTES) {
    if (!row || !isLocalDateTime(row.meeting_at)) return null;
    const details = [
      row.phone ? `Phone: ${row.phone}` : null,
      row.address || null,
      String(row.notes || '').trim() ? `Notes:\n${String(row.notes).trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `Brainstorm: ${row.name || 'Business'}`,
      dates: `${calendarStamp(row.meeting_at)}/${calendarStamp(row.meeting_at, minutes)}`,
    });
    if (details) params.set('details', details);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  return {
    DATE_RE,
    DATETIME_RE,
    isLocalDate,
    isLocalDateTime,
    todayISO,
    localDate,
    addDays,
    daysUntil,
    datePart,
    FOLLOW_UP_CHIPS,
    followUpDateFor,
    STATUSES,
    STATUS_KEYS,
    RETRYABLE,
    MEETING_STATUSES,
    statusLabel,
    hasLiveMeeting,
    hasLiveFollowUp,
    classifyAgenda,
    formatTime,
    formatDate,
    dueLabel,
    calendarLink,
    calendarStamp,
    DEFAULT_MEETING_MINUTES,
  };
});
