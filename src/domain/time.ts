export function localDateParts(isoDate: string, timeZone: string): { date: string; month: string; time: string } {
  const date = new Date(isoDate);
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  const year = part(dateParts, 'year');
  const month = part(dateParts, 'month');
  const day = part(dateParts, 'day');
  return {
    date: `${year}-${month}-${day}`,
    month: `${year}-${month}`,
    time: `${part(timeParts, 'hour')}:${part(timeParts, 'minute')}`,
  };
}

export function nextDate(localDate: string): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function daysInMonth(localMonth: string): number {
  const [year, month] = localMonth.split('-').map(Number);
  if (!year || !month) return 30;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
