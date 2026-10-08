// How dates are shown. Each user picks a format on My profile (users.date_format);
// times are always 24-hour UK time (Europe/London). Email subjects keep their own
// "EOD 7 October" wording (src/lib/report-email.js).
const DATE_FORMATS = {
  d_mon_yyyy: '7 Oct 2026',
  dd_mm_yyyy: '07/10/2026',
};
const DEFAULT_FORMAT = 'd_mon_yyyy';

const isDateFormat = (value) => Object.hasOwn(DATE_FORMATS, value);

const OPTIONS = {
  d_mon_yyyy: { day: 'numeric', month: 'short', year: 'numeric' },
  dd_mm_yyyy: { day: '2-digit', month: '2-digit', year: 'numeric' },
};
const TIME = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const cache = new Map();
const formatter = (key, options) => {
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('en-GB', options));
  return cache.get(key);
};

// { fmtDate(datetime) -> "7 Oct 2026, 15:00", fmtDay(date) -> "7 Oct 2026", fmtTime(datetime) -> "15:00",
//   fmtShort(datetime) -> "7 Oct, 15:00" (07/10, 15:00; the year is added when it is not this year) }
// fmtDay takes a DATE column ("YYYY-MM-DD", shown as that calendar day) or a timestamp
// (shown as its UK day). Empty values give ''.
function formattersFor(format) {
  const key = isDateFormat(format) ? format : DEFAULT_FORMAT;
  const day = formatter(`${key}:day`, { ...OPTIONS[key], timeZone: 'Europe/London' });
  const calendarDay = formatter(`${key}:cal`, { ...OPTIONS[key], timeZone: 'UTC' });
  const time = formatter('time', { ...TIME, timeZone: 'Europe/London' });
  const SHORT = { d_mon_yyyy: { day: 'numeric', month: 'short' }, dd_mm_yyyy: { day: '2-digit', month: '2-digit' } };
  const shortDay = formatter(`${key}:short`, { ...SHORT[key], timeZone: 'Europe/London' });
  const year = formatter('year', { year: 'numeric', timeZone: 'Europe/London' });
  const valid = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const fmtDate = (value) => {
    const d = valid(value);
    return d ? `${day.format(d)}, ${time.format(d)}` : '';
  };
  const fmtDay = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDay.format(new Date(`${value}T12:00:00Z`));
    const d = valid(value);
    return d ? day.format(d) : '';
  };
  const fmtTime = (value) => {
    const d = valid(value);
    return d ? time.format(d) : '';
  };
  const fmtShort = (value) => {
    const d = valid(value);
    if (!d) return '';
    if (year.format(d) !== year.format(new Date())) return fmtDate(d);
    return `${shortDay.format(d)}, ${time.format(d)}`;
  };
  return { fmtDate, fmtDay, fmtTime, fmtShort };
}

module.exports = { DATE_FORMATS, DEFAULT_FORMAT, isDateFormat, formattersFor };
