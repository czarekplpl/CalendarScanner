/**
 * WARSTWA D1 — zapis danych do backtestu w bazie SQLite
 * ====================================================
 *
 * To jest docelowe miejsce na dane badawcze (obok archiwum KV, które jest buforem
 * i źródłem prawdy w razie awarii D1).
 *
 * KLUCZOWE DECYZJE IMPLEMENTACYJNE:
 *
 * 1. Zapis IDEMPOTENTNY (`INSERT OR REPLACE`). Cron chodzi 2x dziennie i ten sam
 *    dzień zapisuje dwa razy — klucz główny (as_of, symbol, earnings_date) sprawia,
 *    że drugi przebieg nadpisuje pierwszy zamiast mnożyć wiersze. Bez tego każdy
 *    dzień miałby podwójne rekordy i backtest liczyłby wszystko dwa razy.
 *
 * 2. PARTIE PO 5 WIERSZY. D1 ma limit parametrów w jednym zapytaniu (100 na
 *    darmowym planie). Wiersz kandydata ma ~40 kolumn, więc 5×40 = 200 — bezpiecznie.
 *    Zbyt duża partia kończy się błędem, a nie cichym obcięciem.
 *
 * 3. CAŁOŚĆ W JEDNYM `batch()`. D1 wykonuje batch jako transakcję: albo zapisze się
 *    wszystko, albo nic. Dzięki temu nie zostaje połowiczny stan (np. kandydaci bez
 *    wpisu o przebiegu), który trudno potem wykryć.
 *
 * 4. D1 JEST OPCJONALNE. Brak bindingu nie może wywalić skanu — archiwum KV
 *    i eksport CSV działają niezależnie.
 */

import { CANDIDATE_COLUMNS, SCHEMA_VERSION } from './dataset.ts';
import type { Env, ScanResult } from '../types.ts';

/** Kolumny tabeli scan_candidates w kolejności zgodnej z zapytaniem INSERT. */
/**
 * Kolumny tabeli scan_candidates w kolejności zgodnej z zapytaniem INSERT.
 *
 * CELOWO pochodzą z jednej stałej `CANDIDATE_COLUMNS` używanej też przez eksport CSV.
 * Wcześniej obie listy były prowadzone osobno i ROZJECHAŁY SIĘ — brakowało kolumny
 * `back_pricing_source`, przez co CSV i D1 zapisywały różne zbiory pól. Przy jednym
 * źródle prawdy taka rozbieżność jest niemożliwa, a test to dodatkowo pilnuje.
 *
 * Kolejność MUSI odpowiadać kolejności wartości w `candidateValues()`.
 */
const CANDIDATE_INSERT_COLUMNS = CANDIDATE_COLUMNS;

export interface D1WriteResult {
  attempted: boolean;
  candidatesWritten: number;
  watchlistWritten: number;
  batches: number;
  skippedReason?: string;
}

/**
 * Limit parametrów jednego zapytania D1 na darmowym planie to 100.
 * Wiersz kandydata ma 44 kolumny (po dodaniu kolumn pricing source), więc
 * 2 wiersze = 88 parametrów — mieści się z zapasem 12. Trzy wiersze dałyby 132,
 * czyli przekroczenie limitu i błąd zapisu.
 *
 * UWAGA: ta liczba jest SPRZĘŻONA z liczbą kolumn. Po dodaniu kolumn trzeba ją
 * zmniejszyć — pilnuje tego test `partie nie przekraczają limitu parametrów`.
 */
const D1_MAX_PARAMS_PER_QUERY = 100;
const ROWS_PER_INSERT = Math.max(
  1,
  Math.floor((D1_MAX_PARAMS_PER_QUERY - 10) / CANDIDATE_INSERT_COLUMNS.length),
);

/** Zamienia undefined/NaN na NULL — D1 nie przyjmuje undefined jako parametru. */
function n(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function s(value: string | undefined | null): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function boolToInt(value: boolean | undefined): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null;
}

/** Buduje wartości jednego wiersza kandydata (kolejność jak CANDIDATE_INSERT_COLUMNS). */
function candidateValues(scan: ScanResult, c: ScanResult['candidates'][number]): (string | number | null)[] {
  const points = new Map(c.components.map((comp) => [comp.key, comp.points]));
  const impliedVsHistorical =
    c.avgHistoricalMovePct && c.avgHistoricalMovePct > 0 && c.front
      ? c.front.impliedMovePct / c.avgHistoricalMovePct
      : undefined;
  // IV rank: u dostawcy tastytrade pochodzi z API, u tradiera z naszej historii.
  const ivRankSource = c.ivRank === undefined ? undefined : scan.config.optionsProvider === 'tastytrade' ? 'provider' : 'history';

  // KOLEJNOŚĆ MUSI odpowiadać 1:1 kolejności CANDIDATE_INSERT_COLUMNS.
  // Ten blok był już raz źródłem poważnego błędu: SCHEMA_VERSION trafił na
  // czwartą pozycję zamiast pierwszej, przez co WSZYSTKIE wartości przesunęły
  // się o jeden, a do bazy trafiły śmieci (symbol = data, as_of = nazwa sektora).
  // Test `kolejność wartości odpowiada kolumnom` sprawdza to markerami.
  return [
    SCHEMA_VERSION,
    scan.asOf,
    c.symbol,
    s(c.name),
    s(c.sector),
    c.earnings.date,
    n(c.daysToEarnings),
    n(c.tradingDaysToEarnings),
    boolToInt(c.earnings.confirmed),
    s(c.earnings.timing),
    n(c.score),
    s(c.grade),
    c.flags.length > 0 ? c.flags.join(';') : null,
    s(c.suggestedEntryDate),
    n(c.spot),
    s(c.front?.expiration),
    n(c.front?.dte),
    n(c.front?.atmIv),
    s(c.front?.ivSource),
    n(c.front?.impliedMovePct),
    n(c.front?.atmOpenInterest),
    n(c.front?.atmSpreadPct),
    s(c.front?.pricingSource),
    s(c.back?.expiration),
    n(c.back?.dte),
    n(c.back?.atmIv),
    s(c.back?.ivSource),
    s(c.back?.pricingSource),
    n(c.termStructureSlope),
    n(c.front?.daysToEarnings),
    n(c.ivRank),
    s(ivRankSource),
    n(impliedVsHistorical),
    n(c.avgHistoricalMovePct),
    n(points.get('timing')),
    n(points.get('termStructure')),
    n(points.get('cheapness')),
    n(points.get('liquidity')),
    n(points.get('ivRank')),
    n(c.warnings.length),
    s(scan.config.optionsProvider),
    s(scan.config.tradierEnv),
    s(scan.scannerVersion),
  ];
}

/**
 * Zapisuje wynik skanu do D1: kandydatów, listę obserwacyjną i wpis o przebiegu.
 * Zwraca statystyki zamiast rzucać wyjątkiem — D1 jest warstwą dodatkową,
 * więc jego awaria nie może przerwać skanu ani wysyłki alertów.
 */
export async function writeScanToD1(env: Env, scan: ScanResult): Promise<D1WriteResult> {
  const result: D1WriteResult = {
    attempted: false,
    candidatesWritten: 0,
    watchlistWritten: 0,
    batches: 0,
  };

  const db = env.DB;
  if (!db) {
    result.skippedReason = 'Brak bindingu DB (D1) — dane trafiły tylko do KV. Patrz README, sekcja o D1.';
    return result;
  }

  result.attempted = true;
  const statements: D1PreparedStatement[] = [];

  // ── Kandydaci ─────────────────────────────────────────────────────────────
  const placeholders = `(${CANDIDATE_INSERT_COLUMNS.map(() => '?').join(', ')})`;
  for (let i = 0; i < scan.candidates.length; i += ROWS_PER_INSERT) {
    const chunk = scan.candidates.slice(i, i + ROWS_PER_INSERT);
    const values: (string | number | null)[] = [];
    for (const c of chunk) values.push(...candidateValues(scan, c));

    const sql =
      `INSERT OR REPLACE INTO scan_candidates (${CANDIDATE_INSERT_COLUMNS.join(', ')}) VALUES ` +
      chunk.map(() => placeholders).join(', ');
    statements.push(db.prepare(sql).bind(...values));
    result.candidatesWritten += chunk.length;
  }

  // ── Lista obserwacyjna ────────────────────────────────────────────────────
  for (const w of scan.watchlistOnly) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO scan_watchlist (as_of, symbol, earnings_date, days_to_earnings, reason)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(scan.asOf, w.symbol, w.earningsDate, n(w.daysToEarnings), s(w.reason)),
    );
    result.watchlistWritten++;
  }

  // ── Przebieg ──────────────────────────────────────────────────────────────
  statements.push(
    db
      .prepare(
        `INSERT OR REPLACE INTO scan_runs
           (as_of, run_at, candidates, analyzed, in_alert_window, alerts_sent, duration_ms, errors_count, scanner_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        scan.asOf,
        scan.generatedAt,
        n(scan.counts.candidates),
        n(scan.counts.analyzed),
        n(scan.counts.inAlertWindow),
        n(scan.counts.alertsSent),
        n(scan.durationMs),
        n(scan.errors.length),
        s(scan.scannerVersion),
      ),
  );

  try {
    // Batch = jedna transakcja: albo wszystko, albo nic. Nie zostawiamy
    // połowicznego stanu, który potem trudno wykryć w danych.
    await db.batch(statements);
    result.batches = statements.length;
  } catch (err) {
    // Diagnostyka: logujemy PEŁNY błąd (z nazwą i stosem), bo komunikaty D1
    // bywają lakoniczne, a bez szczegółów nie da się odróżnić braku uprawnień
    // od błędu SQL czy przekroczenia limitu parametrów.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(
      `[scanner] zapis do D1 nie powiódł się: ${detail}. ` +
        `Statements: ${statements.length}, kandydaci: ${scan.candidates.length}. ` +
        'Dane w KV i eksport CSV pozostają aktualne.',
    );
    console.warn(`[scanner] D1 stos: ${err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 3).join(' | ') : 'brak'}`);
    return {
      ...result,
      candidatesWritten: 0,
      watchlistWritten: 0,
      skippedReason: `Błąd zapisu do D1: ${detail}`,
    };
  }

  return result;
}

/**
 * Sprawdza, czy schemat D1 istnieje. Bez tego pierwszy zapis kończy się błędem
 * "no such table", a komunikat w logach nie mówi, co zrobić.
 */
export async function checkD1Schema(env: Env): Promise<{ ok: boolean; detail: string }> {
  if (!env.DB) return { ok: false, detail: 'Brak bindingu DB — D1 nie jest podpięte.' };
  try {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scan_candidates','outcomes','scan_runs')`,
    ).all();
    const found = (row.results ?? []).map((r) => String((r as { name?: unknown }).name));
    if (found.length < 3) {
      return {
        ok: false,
        detail:
          `Brakujące tabele: ${['scan_candidates', 'outcomes', 'scan_runs'].filter((t) => !found.includes(t)).join(', ')}. ` +
          'Zastosuj schemat: npx wrangler d1 execute earnings-iv-scanner --remote --file=./schema.sql',
      };
    }
    return { ok: true, detail: `Tabele obecne: ${found.join(', ')}` };
  } catch (err) {
    return { ok: false, detail: `Nie udało się odczytać schematu: ${err instanceof Error ? err.message : String(err)}` };
  }
}
