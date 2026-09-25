/**
 * Stan trwały w KV: historia IV (do liczenia IV rank) i rejestr wysłanych alertów.
 *
 * Dlaczego własna historia IV, a nie pole od dostawcy:
 *  - IV rank/percentile to jedyna miara "czy zmienność jest teraz droga względem
 *    własnej historii tej spółki". Dostawcy darmowi tego nie dają, a płatni liczą
 *    to swoim oknem (np. 1 rok) i własną metodą.
 *  - Skaner i tak codziennie widzi IV ATM wybranych spółek, więc wystarczy je
 *    zapisywać. Po ~60 dniach IV rank zaczyna być sensowny, po roku jest pełny.
 *
 * Format zapisu (jeden klucz na spółkę, mały JSON, żeby nie mnożyć odczytów KV):
 *   ivhist:AAPL -> { v: 1, o: [[dniEpoch, iv], ...] }   // max 260 obserwacji
 */

import type { Env, AlertRecord } from '../types.ts';

const IV_KEY_PREFIX = 'ivhist:';
const ALERTS_KEY = 'alerts:sent';
const MAX_OBSERVATIONS = 260;
const MAX_ALERT_RECORDS = 500;

/**
 * Licznik alertów wysłanych danego dnia.
 *
 * PO CO: limit „na przebieg" nie wystarcza. Gdy cron chodzi, a Ty uruchomisz
 * dodatkowo ręczny skan z alertami, limit na przebieg przepuściłby kolejną
 * porcję — i dostałbyś 8, 12 czy 16 wiadomości dziennie zamiast 4.
 * Licznik dzienny pilnuje budżetu NIEZALEŻNIE od liczby uruchomień.
 *
 * Klucz zawiera datę, więc resetuje się sam o północy (UTC) — nie trzeba
 * żadnego zadania czyszczącego. TTL to zapas na wypadek, gdyby data w kluczu
 * się nie zmieniła (np. brak przebiegów).
 */
const DAILY_COUNT_PREFIX = 'alerts:daily:';
const IV_TTL_SECONDS = 400 * 24 * 3600; // ~13 miesięcy

export interface IvObservation {
  /** Dni od epoch (liczba całkowita) — kompaktowo */
  day: number;
  iv: number;
}

export interface IvHistory {
  v: 1;
  o: IvObservation[];
}

function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

function isoFromEpochDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Wczytuje historię IV dla spółki. */
export async function loadIvHistory(env: Env, symbol: string): Promise<IvHistory> {
  if (!env.STATE) return { v: 1, o: [] };
  try {
    const raw = await env.STATE.get(`${IV_KEY_PREFIX}${symbol}`, 'json');
    if (!raw || typeof raw !== 'object') return { v: 1, o: [] };
    const parsed = raw as IvHistory;
    if (!Array.isArray(parsed.o)) return { v: 1, o: [] };
    return { v: 1, o: parsed.o.filter((x) => typeof x?.day === 'number' && typeof x?.iv === 'number') };
  } catch {
    return { v: 1, o: [] };
  }
}

/**
 * Dopisuje dzisiejszą obserwację IV ATM frontu (jedna na spółkę na dzień)
 * i zwraca historię razem z policzonym IV rank.
 */
export async function recordIvObservation(
  env: Env,
  symbol: string,
  asOf: string,
  frontIv: number,
): Promise<{ history: IvHistory; ivRank?: number }> {
  const history = await loadIvHistory(env, symbol);
  if (!Number.isFinite(frontIv) || frontIv <= 0) {
    return { history, ivRank: computeIvRank(history, frontIv) };
  }

  const today = epochDay(asOf);
  const existingIdx = history.o.findIndex((x) => x.day === today);
  const poprzednia = existingIdx >= 0 ? history.o[existingIdx]!.iv : undefined;

  // ── OSZCZĘDNOŚĆ ZAPISÓW KV ────────────────────────────────────────────────
  // Darmowy plan Cloudflare KV ma limit 1000 zapisów na dobę. Zapisywaliśmy
  // obserwację IV dla KAŻDEJ analizowanej spółki przy KAŻDYM przebiegu, czyli
  // 21 zapisów na skan — nawet gdy wartość była identyczna jak poprzednio
  // (a przy skanie raz dziennie i tej samej sesji często była).
  //
  // Teraz zapisujemy tylko wtedy, gdy wartość faktycznie się zmieniła. Przy
  // pierwszym przebiegu danego dnia zapis następuje (bo nie ma jeszcze wpisu),
  // a przy powtórnym — tylko gdy IV się różni. Typowo oszczędza to większość
  // z tych 21 zapisów.
  //
  // Uwaga: tolerancja 1e-6, bo IV 0.3200001 i 0.32 to ta sama wartość w praktyce.
  const bezZmian = poprzednia !== undefined && Math.abs(poprzednia - frontIv) < 1e-6;

  if (existingIdx >= 0) {
    history.o[existingIdx] = { day: today, iv: frontIv };
  } else {
    history.o.push({ day: today, iv: frontIv });
  }
  history.o.sort((a, b) => a.day - b.day);

  // Przytnij do ostatnich 400 dni i limitu obserwacji
  const cutoff = today - 400;
  history.o = history.o.filter((x) => x.day >= cutoff).slice(-MAX_OBSERVATIONS);

  if (env.STATE && !bezZmian) {
    try {
      await env.STATE.put(`${IV_KEY_PREFIX}${symbol}`, JSON.stringify(history), {
        expirationTtl: IV_TTL_SECONDS,
      });
    } catch {
      /* zapis historii jest best-effort */
    }
  }

  return { history, ivRank: computeIvRank(history, frontIv) };
}

/**
 * IV rank = percentyl bieżącej IV w historii własnej spółki (0-100).
 * Zwraca undefined, gdy próbek jest za mało (< 20 różnych dni) — wtedy skaner
 * jawnie mówi "brak historii" zamiast pokazywać mylącą liczbę.
 */
export function computeIvRank(history: IvHistory, currentIv: number): number | undefined {
  return computeIvRankFromObservations(history.o, currentIv);
}

/**
 * IV rank z listy obserwacji. Minimum 20 próbek — poniżej tego percentyl jest
 * zbyt wrażliwy na pojedyncze dni, żeby na nim opierać decyzję.
 */
export function computeIvRankFromObservations(
  observations: IvObservation[],
  currentIv: number,
): number | undefined {
  const values = observations.map((x) => x.iv).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < 20) return undefined;
  const below = values.filter((v) => v <= currentIv).length;
  return Math.round((below / values.length) * 100);
}

/** Data najstarszej obserwacji — do raportowania, jak długa jest historia. */
export function historySpanDays(history: IvHistory): number {
  if (history.o.length < 2) return 0;
  const first = history.o[0]!.day;
  const last = history.o[history.o.length - 1]!.day;
  return last - first;
}

export { isoFromEpochDay };

// ─────────────────────────────────────────────────────────────────────────────
// Rejestr alertów — deduplikacja między przebiegami cron
// ─────────────────────────────────────────────────────────────────────────────

export type AlertRegistry = Record<string, AlertRecord>;

export async function loadAlertRegistry(env: Env): Promise<AlertRegistry> {
  if (!env.STATE) return {};
  try {
    const raw = await env.STATE.get(ALERTS_KEY, 'json');
    if (!raw || typeof raw !== 'object') return {};
    return raw as AlertRegistry;
  } catch {
    return {};
  }
}

/**
 * Zapisuje rejestr alertów.
 *
 * UWAGA WYDAJNOŚCIOWA: rejestr to JEDEN klucz JSON, więc każdy zapis nadpisuje
 * całość. Dlatego NIE wolno go zapisywać per alert — przy 25 alertach byłoby to
 * 25 zapisów pełnego JSON-a, co zjada dzienny limit zapisów KV i niepotrzebnie
 * mnoży ruch. Wołający zbiera rekordy w pamięci i zapisuje RAZ na końcu przebiegu
 * (patrz markAlertedBatch).
 */
export async function saveAlertRegistry(env: Env, registry: AlertRegistry): Promise<void> {
  if (!env.STATE) return;
  // Przytnij do najnowszych rekordów, żeby JSON nie rósł w nieskończoność.
  const entries = Object.entries(registry)
    .sort((a, b) => (b[1].sentAt ?? '').localeCompare(a[1].sentAt ?? ''))
    .slice(0, MAX_ALERT_RECORDS);
  try {
    await env.STATE.put(ALERTS_KEY, JSON.stringify(Object.fromEntries(entries)), {
      expirationTtl: 200 * 24 * 3600,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Klucz deduplikacji. Cel: JEDEN alert na spółkę i cykl wyników na dany próg,
 * ale możliwość ponownego alertu, gdy układ istotnie się zmieni.
 *  - próg "T30"     — pierwsze wejście w okno alertu (~30 dni przed)
 *  - próg "T14"     — przypomnienie, gdy okno wejścia się zbliża
 *  - próg "SCORE80" — eskalacja, gdy ocena przebije 80 (wyjątkowo dobry układ)
 */
export function alertKey(symbol: string, earningsDate: string, tier: string): string {
  return `${symbol}|${earningsDate}|${tier}`;
}

/** Próg alertu na podstawie dni do wyników i oceny. */
export function alertTier(daysToEarnings: number, score: number): string {
  if (score >= 80) return 'SCORE80';
  if (daysToEarnings <= 18) return 'T14';
  return 'T30';
}

/** Czy dla tego klucza już wysłaliśmy alert? */
export function alreadyAlerted(registry: AlertRegistry, key: string): boolean {
  return Boolean(registry[key]);
}

/** Rejestruje wysłany alert w rejestrze (w pamięci). Zapis do KV: markAlertedBatch. */
export function markAlerted(registry: AlertRegistry, record: AlertRecord): void {
  registry[record.key] = record;
}

/**
 * Dopisuje wiele rekordów i zapisuje rejestr DO KV RAZ.
 * To jest właściwy sposób zapisu — jedno wywołanie na cały przebieg skanu.
 */
export async function markAlertedBatch(
  env: Env,
  registry: AlertRegistry,
  records: AlertRecord[],
): Promise<void> {
  if (records.length === 0) return;
  for (const record of records) markAlerted(registry, record);
  await saveAlertRegistry(env, registry);
}

/** Ile alertów wysłano już danego dnia (data w formacie YYYY-MM-DD). */
export async function loadDailyAlertCount(env: Env, asOf: string): Promise<number> {
  if (!env.STATE) return 0;
  try {
    const raw = await env.STATE.get(`${DAILY_COUNT_PREFIX}${asOf}`, 'text');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Zapisuje nowy stan licznika dziennego. Best-effort — brak KV nie blokuje alertów. */
export async function saveDailyAlertCount(env: Env, asOf: string, count: number): Promise<void> {
  if (!env.STATE) return;
  try {
    await env.STATE.put(`${DAILY_COUNT_PREFIX}${asOf}`, String(count), {
      // 3 dni: klucz zawiera datę, więc stary wpis i tak jest ignorowany —
      // TTL to tylko sprzątanie po sobie.
      expirationTtl: 3 * 24 * 3600,
    });
  } catch {
    /* best-effort */
  }
}

/** Porządkuje rejestr: usuwa wpisy dla cykli wyników starszych niż `days`. */
export function pruneRegistry(registry: AlertRegistry, today: string, days = 60): AlertRegistry {
  const cutoff = epochDay(today) - days;
  const out: AlertRegistry = {};
  for (const [key, rec] of Object.entries(registry)) {
    if (!rec?.earningsDate) continue;
    if (epochDay(rec.earningsDate) >= cutoff) out[key] = rec;
  }
  return out;
}
