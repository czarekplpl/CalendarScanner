/**
 * Kalendarz sesji giełdy US (NYSE/Nasdaq).
 *
 * Potrzebny do liczenia dni sesyjnych — bo kalendarz opcyjny liczy się w dniach
 * sesyjnych, nie kalendarzowych. Święta ruchome (Wielki Piątek, Thanksgiving)
 * wyliczamy algorytmicznie, żeby nie trzeba było aktualizować listy co roku.
 */

/** Zamienia Date na 'YYYY-MM-DD' w UTC (bez przesunięć stref). */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parsuje 'YYYY-MM-DD' na Date w południu UTC — odporne na DST i strefy. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Nieprawidłowa data: ${iso}`);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Dzisiejsza data sesyjna wg czasu Nowego Jorku. */
export function todayInNewYork(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now); // en-CA daje YYYY-MM-DD
}

/** Bieżąca godzina w Nowym Jorku w formacie HH:MM (24h). */
export function timeInNewYork(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(now);
}

export function addDays(iso: string, days: number): string {
  const d = fromIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Różnica w dniach kalendarzowych: b - a. */
export function daysBetween(a: string, b: string): number {
  const ms = fromIsoDate(b).getTime() - fromIsoDate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function dayOfWeek(iso: string): number {
  return fromIsoDate(iso).getUTCDay(); // 0 = niedziela
}

/** Algorytm Walnego Zgromadzenia (Meeus/Jones/Butcher) — data Wielkanocy. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Przesuwa święto przypadające w weekend na najbliższy poniedziałek (zasada NYSE). */
function observed(iso: string): string {
  const dow = dayOfWeek(iso);
  if (dow === 6) return addDays(iso, -1); // sobota -> piątek
  if (dow === 0) return addDays(iso, 1); // niedziela -> poniedziałek
  return iso;
}

/** n-ty (1-based) dzień tygodnia w miesiącu, np. 3. poniedziałek stycznia. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const firstDow = first.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Ostatni poniedziałek miesiąca (Memorial Day). */
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0, 12)); // dzień 0 = ostatni dzień poprzedniego miesiąca
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  const day = last.getUTCDate() - offset;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Dni zamknięcia giełdy US w danym roku. */
export function marketHolidays(year: number): Set<string> {
  const days = [
    observed(`${year}-01-01`), // Nowy Rok
    nthWeekday(year, 1, 1, 3), // MLK Day — 3. poniedziałek stycznia
    nthWeekday(year, 2, 1, 3), // Presidents' Day — 3. poniedziałek lutego
    addDays(easterSunday(year), -2), // Wielki Piątek
    lastWeekday(year, 5, 1), // Memorial Day — ostatni poniedziałek maja
    observed(`${year}-06-19`), // Juneteenth (NYSE od 2022)
    observed(`${year}-07-04`), // Dzień Niepodległości
    nthWeekday(year, 9, 1, 1), // Labor Day — 1. poniedziałek września
    nthWeekday(year, 11, 4, 4), // Thanksgiving — 4. czwartek listopada
    observed(`${year}-12-25`), // Boże Narodzenie
  ];
  if (year < 2022) days.splice(days.indexOf(observed(`${year}-06-19`)), 1);
  return new Set(days);
}

/** Cache kalendarza per rok — unikamy przeliczania w pętli po 200 spółkach. */
const holidayCache = new Map<number, Set<string>>();
function holidaysFor(year: number): Set<string> {
  let h = holidayCache.get(year);
  if (!h) {
    h = marketHolidays(year);
    holidayCache.set(year, h);
  }
  return h;
}

/** Czy to dzień sesyjny (pon-pt, bez świąt). */
export function isTradingDay(iso: string): boolean {
  const dow = dayOfWeek(iso);
  if (dow === 0 || dow === 6) return false;
  return !holidaysFor(fromIsoDate(iso).getUTCFullYear()).has(iso);
}

/** Liczba dni sesyjnych w przedziale (a, b] — czyli ile sesji minie do daty b. */
export function tradingDaysBetween(a: string, b: string): number {
  if (a === b) return 0;
  const sign = daysBetween(a, b) < 0 ? -1 : 1;
  const [start, end] = sign > 0 ? [a, b] : [b, a];
  let count = 0;
  let cursor = start;
  // Twardy limit bezpieczeństwa — chroni przed pętlą przy błędnych danych
  for (let guard = 0; guard < 1200 && cursor < end; guard++) {
    cursor = addDays(cursor, 1);
    if (isTradingDay(cursor)) count++;
  }
  return count * sign;
}

/** Najbliższy dzień sesyjny (włącznie z podanym, jeśli jest sesyjny). */
export function nextTradingDay(iso: string): string {
  let cursor = iso;
  for (let guard = 0; guard < 15 && !isTradingDay(cursor); guard++) cursor = addDays(cursor, 1);
  return cursor;
}

/** Przesuwa datę o n dni sesyjnych (n może być ujemne). */
export function addTradingDays(iso: string, n: number): string {
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cursor = iso;
  for (let guard = 0; guard < 1200 && remaining > 0; guard++) {
    cursor = addDays(cursor, step);
    if (isTradingDay(cursor)) remaining--;
  }
  return cursor;
}

/**
 * Trzecie piątek miesiąca — standardowe wygaśnięcie miesięczne (OPEX).
 * To zwykle najpłynniejsze wygaśnięcie w łańcuchu, więc kalendarze buduje się na nim.
 */
export function thirdFriday(year: number, month: number): string {
  return nthWeekday(year, month, 5, 3);
}

/** Lista wygaśnięć standardowych (trzecie piątki) w zakresie od-do. */
export function monthlyExpirations(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = fromIsoDate(fromIso);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  for (let guard = 0; guard < 36; guard++) {
    const exp = thirdFriday(year, month);
    if (exp > toIso) break;
    if (exp >= fromIso) out.push(exp);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return out;
}
