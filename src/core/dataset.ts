/**
 * WARSTWA DANYCH — zamiana migawek skanu na wiersze do backtestu
 * ============================================================
 *
 * Tu mieszka kontrakt ze schematem opisanym w docs/DATA_SCHEMA.md. Cała logika
 * jest czysta (bez sieci i KV), żeby dało się ją przetestować bez kluczy API —
 * a to jest kod, którego błędu nie da się naprawić po fakcie: jeśli w dniu skanu
 * zapiszemy złe kolumny, dane przepadną bezpowrotnie.
 *
 * Uwaga na CSV: escapujemy pola zgodnie z RFC 4180 (cudzysłów podwajany, pole
 * w cudzysłowach gdy zawiera przecinek/cudzysłów/nową linię). Pola tekstowe jak
 * `flags` i `name` mogą zawierać przecinki, więc to nie jest kosmetyka.
 *
 * Uwaga na liczbę kolumn: tabela D1 i CSV mają osobne listy kolumn, więc dodanie
 * kolumny wymaga zmiany w OBU miejscach (tu i w src/core/d1.ts). Test
 * `wiersz ma dokładnie te kolumny, co schemat` pilnuje tylko CSV — dlatego przy
 * zmianie schematu trzeba też zaktualizować CANDIDATE_INSERT_COLUMNS i schema.sql.
 */

import type { CalendarCandidate, ScanResult } from '../types.ts';

/** Wersja schematu — podbij przy każdej zmianie kolumn. Patrz docs/DATA_SCHEMA.md §7. */
export const SCHEMA_VERSION = 1;

/** Nagłówki tabeli kandydatów — kolejność musi odpowiadać buildCandidateRow(). */
export const CANDIDATE_COLUMNS = [
  'schema_version',
  'as_of',
  'symbol',
  'name',
  'sector',
  'earnings_date',
  'days_to_earnings',
  'trading_days_to_earnings',
  'earnings_confirmed',
  'earnings_timing',
  // sygnał
  'score',
  'grade',
  'flags',
  'suggested_entry_date',
  'spot',
  // nogi kalendarza
  'front_expiration',
  'front_dte',
  'front_iv',
  'front_iv_source',
  'front_implied_move',
  'front_oi',
  'front_spread_pct',
  'front_pricing_source',
  'back_expiration',
  'back_dte',
  'back_iv',
  'back_iv_source',
  'back_pricing_source',
  'term_structure_slope',
  'days_front_to_earnings',
  // kontekst zmienności
  'iv_rank',
  'iv_rank_source',
  'implied_vs_historical',
  'avg_historical_move',
  // składowe oceny
  'points_timing',
  'points_term_structure',
  'points_cheapness',
  'points_liquidity',
  'points_iv_rank',
  'warnings_count',
  // proweniencja
  'options_provider',
  'options_env',
  'scanner_version',
] as const;

export type CandidateColumn = (typeof CANDIDATE_COLUMNS)[number];
export type CandidateRow = Record<CandidateColumn, string>;

/** Klucz tożsamości wiersza: ta sama spółka + ten sam cykl wyników + dzień skanu. */
export function rowKey(row: Pick<CandidateRow, 'as_of' | 'symbol' | 'earnings_date'>): string {
  return `${row.as_of}|${row.symbol}|${row.earnings_date}`;
}

function num(value: number | undefined, digits = 6): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '';
  // Stała liczba miejsc po przecinku: CSV bez tego sortuje się jak tekst.
  return value.toFixed(digits);
}

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

/** Skąd wzięła się wartość IV rank — kluczowe przy filtrowaniu danych do analizy. */
function ivRankSource(scan: ScanResult, candidate: CalendarCandidate): string {
  if (candidate.ivRank === undefined) return '';
  // Metryki dostawcy są dostępne tylko u części dostawców i są wtedy pierwsze.
  // Rozróżniamy je po tym, czy skan ma proweniencję tastytrade.
  return scan.config.optionsProvider === 'tastytrade' ? 'provider' : 'history';
}

/**
 * Zamienia jednego kandydata na wiersz CSV zgodny ze schematem.
 * Wszystkie wartości liczbowe idą jako tekst sformatowany, żeby zapis był stabilny.
 */
export function buildCandidateRow(scan: ScanResult, c: CalendarCandidate): CandidateRow {
  const points = new Map(c.components.map((comp) => [comp.key, comp.points]));
  const impliedVsHistorical =
    c.avgHistoricalMovePct && c.avgHistoricalMovePct > 0 && c.front
      ? c.front.impliedMovePct / c.avgHistoricalMovePct
      : undefined;

  return {
    schema_version: String(SCHEMA_VERSION),
    as_of: scan.asOf,
    symbol: c.symbol,
    name: c.name ?? '',
    sector: c.sector ?? '',
    earnings_date: c.earnings.date,
    days_to_earnings: String(c.daysToEarnings),
    trading_days_to_earnings: String(c.tradingDaysToEarnings),
    earnings_confirmed: bool(c.earnings.confirmed),
    earnings_timing: c.earnings.timing,

    score: String(c.score),
    grade: c.grade,
    flags: c.flags.join(';'),
    suggested_entry_date: c.suggestedEntryDate ?? '',
    spot: num(c.spot, 4),

    front_expiration: c.front?.expiration ?? '',
    front_dte: c.front ? String(c.front.dte) : '',
    front_iv: num(c.front?.atmIv),
    front_iv_source: c.front?.ivSource ?? '',
    front_implied_move: num(c.front?.impliedMovePct),
    front_oi: c.front ? String(c.front.atmOpenInterest) : '',
    front_spread_pct: num(c.front?.atmSpreadPct),
    front_pricing_source: c.front?.pricingSource ?? '',
    back_expiration: c.back?.expiration ?? '',
    back_dte: c.back ? String(c.back.dte) : '',
    back_iv: num(c.back?.atmIv),
    back_iv_source: c.back?.ivSource ?? '',
    back_pricing_source: c.back?.pricingSource ?? '',
    term_structure_slope: num(c.termStructureSlope),
    days_front_to_earnings: c.front ? String(c.front.daysToEarnings) : '',

    iv_rank: c.ivRank === undefined ? '' : String(c.ivRank),
    iv_rank_source: ivRankSource(scan, c),
    implied_vs_historical: num(impliedVsHistorical),
    avg_historical_move: num(c.avgHistoricalMovePct),

    points_timing: num(points.get('timing'), 2),
    points_term_structure: num(points.get('termStructure'), 2),
    points_cheapness: num(points.get('cheapness'), 2),
    points_liquidity: num(points.get('liquidity'), 2),
    points_iv_rank: num(points.get('ivRank'), 2),
    warnings_count: String(c.warnings.length),

    options_provider: scan.config.optionsProvider,
    options_env: scan.config.tradierEnv,
    scanner_version: (scan as { scannerVersion?: string }).scannerVersion ?? '',
  };
}

/** Buduje wiersze dla wszystkich kandydatów ze skanu. */
export function buildCandidateRows(scan: ScanResult): CandidateRow[] {
  return scan.candidates.map((c) => buildCandidateRow(scan, c));
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV: serializacja i parsowanie (RFC 4180)
// ─────────────────────────────────────────────────────────────────────────────

/** Serializuje pole: cudzysłów gdy zawiera przecinek, cudzysłów lub nową linię. */
export function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(columns: readonly string[], rows: Record<string, string>[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => csvEscape(row[col] ?? '')).join(','));
  }
  // Końcowy newline: bez niego doklejanie kolejnych wierszy skleja ostatnią linię.
  return `${lines.join('\n')}\n`;
}

/**
 * Parsuje CSV na wiersze. Obsługuje cudzysłowy i przecinki w polach.
 * Nie obsługuje zagnieżdżonych newline'ów w polach w sposób doskonały, ale nasze
 * pola (`name`, `flags`) ich nie zawierają — a gdyby zawierały, trafią w cudzysłów.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const header = rows[0]!;
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]!;
    // Pomijamy puste linie (typowe przy ręcznej edycji pliku)
    if (cells.length === 1 && cells[0] === '') continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      record[header[j]!] = cells[j] ?? '';
    }
    out.push(record);
  }
  return out;
}

/**
 * Dokleja nowe wiersze do istniejącej treści CSV, pomijając duplikaty.
 *
 * Deduplikacja po `as_of|symbol|earnings_date`: dzięki temu skrypt można uruchamiać
 * wielokrotnie (ręcznie, po awarii, po ponownym przebiegu) bez mnożenia wierszy.
 * Gdy nagłówki w pliku różnią się od bieżącego schematu, zwracamy `headerMismatch`,
 * żeby wołający mógł zareagować — ciche dopisanie wierszy o innym układzie
 * zniszczyłoby zbiór.
 */
export function appendRows(
  existingCsv: string,
  newRows: CandidateRow[],
): { csv: string; added: number; skipped: number; headerMismatch: boolean; existingHeader: string[] } {
  const existingRows = parseCsv(existingCsv);
  const existingHeader = existingCsv.trim() === '' ? [] : (existingCsv.split('\n')[0] ?? '').split(',');

  const expectedHeader = [...CANDIDATE_COLUMNS];
  const headerMismatch =
    existingHeader.length > 0 && existingHeader.join(',') !== expectedHeader.join(',');

  const seen = new Set(existingRows.map((r) => rowKey(r as unknown as CandidateRow)));
  const toAdd: CandidateRow[] = [];
  let skipped = 0;

  for (const row of newRows) {
    const key = rowKey(row);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    toAdd.push(row);
  }

  if (existingCsv.trim() === '') {
    return { csv: toCsv(expectedHeader, toAdd), added: toAdd.length, skipped, headerMismatch: false, existingHeader };
  }

  const body = toAdd.map((row) => expectedHeader.map((col) => csvEscape(row[col] ?? '')).join(',')).join('\n');
  const base = existingCsv.endsWith('\n') ? existingCsv : `${existingCsv}\n`;
  return {
    csv: toAdd.length > 0 ? `${base}${body}\n` : base,
    added: toAdd.length,
    skipped,
    headerMismatch,
    existingHeader,
  };
}

/** Zbiera wiersze ze wszystkich migawek, sortując po dacie i ocenie. */
export function rowsFromScans(scans: ScanResult[]): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (const scan of [...scans].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
    rows.push(...buildCandidateRows(scan));
  }
  return rows;
}
