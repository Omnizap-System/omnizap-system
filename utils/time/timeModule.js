import { DateTime, Duration } from 'luxon';

function resolveTimeZone(timeZone = 'UTC') {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    return 'UTC';
  }

  return timeZone;
}

function normalizeDateTime(dateInput = new Date(), { locale = 'pt-BR', timeZone = 'UTC' } = {}) {
  const zone = resolveTimeZone(timeZone);
  let dateTime = null;

  if (DateTime.isDateTime(dateInput)) {
    dateTime = dateInput.setZone(zone);
  } else if (dateInput instanceof Date) {
    dateTime = DateTime.fromJSDate(dateInput, { zone });
  } else if (typeof dateInput === 'number') {
    dateTime = DateTime.fromMillis(dateInput, { zone });
  } else if (typeof dateInput === 'string') {
    dateTime = DateTime.fromISO(dateInput, { zone });

    if (!dateTime.isValid) {
      const parsedDate = new Date(dateInput);
      if (!Number.isNaN(parsedDate.getTime())) {
        dateTime = DateTime.fromJSDate(parsedDate, { zone });
      }
    }
  } else {
    dateTime = DateTime.fromJSDate(new Date(dateInput), { zone });
  }

  if (!dateTime || !dateTime.isValid) {
    dateTime = DateTime.now().setZone(zone);
  }

  return dateTime.setLocale(locale);
}

export function now() {
  return new Date();
}

export function nowIso() {
  return DateTime.utc().toISO();
}

export function toUnixMs(dateInput = new Date()) {
  return normalizeDateTime(dateInput, { locale: 'en-US', timeZone: 'UTC' }).toMillis();
}

export function toUnixSeconds(dateInput = new Date()) {
  return Math.floor(toUnixMs(dateInput) / 1000);
}

export function elapsedMs(startDateInput, endDateInput = new Date()) {
  return toUnixMs(endDateInput) - toUnixMs(startDateInput);
}

export function formatInTimeZone(dateInput = new Date(), { locale = 'pt-BR', timeZone = 'UTC', options = {} } = {}) {
  return normalizeDateTime(dateInput, { locale, timeZone }).toLocaleString(options);
}

export function formatTimeAmPm(dateInput = new Date(), { locale = 'en-US', timeZone = 'UTC', includeSeconds = false } = {}) {
  return normalizeDateTime(dateInput, { locale, timeZone }).toFormat(includeSeconds ? 'hh:mm:ss a' : 'hh:mm a');
}

export function formatDateTimeExtenso(dateInput = new Date(), { locale = 'pt-BR', timeZone = 'UTC', includeWeekday = true } = {}) {
  return normalizeDateTime(dateInput, { locale, timeZone }).toLocaleString({
    ...(includeWeekday ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimeExtenso(dateInput = new Date(), { locale = 'pt-BR', timeZone = 'UTC', includeSeconds = false } = {}) {
  const dateTime = normalizeDateTime(dateInput, { locale, timeZone });
  const duration = Duration.fromObject(
    {
      hours: dateTime.hour,
      minutes: dateTime.minute,
      ...(includeSeconds ? { seconds: dateTime.second } : {}),
    },
    { locale },
  );

  return duration.toHuman({
    unitDisplay: 'long',
    listStyle: 'long',
  });
}

export function buildTimeFormats(dateInput = new Date(), { locale = 'pt-BR', timeZone = 'UTC' } = {}) {
  const iso = normalizeDateTime(dateInput, { locale: 'en-US', timeZone: 'UTC' }).toUTC().toISO();

  return {
    iso,
    unixMs: toUnixMs(dateInput),
    unixSeconds: toUnixSeconds(dateInput),
    amPm: formatTimeAmPm(dateInput, {
      locale: 'en-US',
      timeZone,
      includeSeconds: false,
    }),
    extenso: formatDateTimeExtenso(dateInput, {
      locale,
      timeZone,
      includeWeekday: true,
    }),
    horaExtenso: formatTimeExtenso(dateInput, {
      locale,
      timeZone,
      includeSeconds: false,
    }),
  };
}

const timeModule = {
  now,
  nowIso,
  toUnixMs,
  toUnixSeconds,
  elapsedMs,
  formatInTimeZone,
  formatTimeAmPm,
  formatDateTimeExtenso,
  formatTimeExtenso,
  buildTimeFormats,
};

export default timeModule;
