/**
 * Testy warstwy danych: budowa wierszy, CSV i zapis do D1.
 *
 * DLACZEGO TO NAJWAŻNIEJSZE TESTY W PROJEKCIE:
 * Błąd w scoringu zobaczysz od razu w wynikach. Błąd tutaj jest CICHY i NIEODWRACALNY
 * — jeśli w dniu skanu zapiszemy złą kolumnę albo zgubimy wiersz, te dane przepadną
 * na zawsze, bo term structure i IV rank są wartościami chwilowymi, których nie
 * kupi się wstecz. Dlatego sprawdzamy każdą własność, która mogłaby zniszczyć zbiór:
 * kolejność kolumn, escapowanie CSV, deduplikację i idempotencję zapisu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRows,
  buildCandidateRow,
  CANDIDATE_COLUMNS,
  csvEscape,
  parseCsv,
  rowsFromScans,
  rowKey,
  SCHEMA_VERSION,
  toCsv,
} from '../src/core/dataset.ts';
import { checkD1Schema, writeScanToD1 } from '../src/core/d1.ts';
import type { CalendarCandidate, Env, ScanResult } from '../src/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

function candidate(overrides: Partial<CalendarCandidate> = {}): CalendarCandidate {
  return {
    symbol: 'MU',
    name: 'Micron Technology, Inc.',
    sector: 'Information Technology',
    spot: 168.4,
    earnings: { symbol: 'MU', date: '2026-10-20', timing: 'amc', confirmed: true },
    daysToEarnings: 26,
    tradingDaysToEarnings: 18,
    earningsInsideBackOnly: true,
    front: {
      expiration: '2026-10-16',
      dte: 22,
      daysToEarnings: 4,
      atmIv: 0.32,
      ivSource: 'provider',
      straddleMid: 11.2,
      impliedMovePct: 0.0665,
      atmOpenInterest: 1200,
      atmSpreadPct: 0.02,
      strikeCount: 40,
      pricingSource: 'mid',
    },
    back: {
      expiration: '2026-11-20',
      dte: 57,
      daysToEarnings: -31,
      atmIv: 0.4,
      ivSource: 'provider',
      straddleMid: 16.4,
      impliedMovePct: 0.0974,
      atmOpenInterest: 800,
      atmSpreadPct: 0.03,
      strikeCount: 38,
      pricingSource: 'mid',
    },
    termStructureSlope: 0.08,
    termStructureRatio: 0.8,
    ivRank: 34,
    avgHistoricalMovePct: 0.05,
    score: 82,
    grade: 'A',
    components: [
      { key: 'timing', label: 'Umiejscowienie wyników', points: 34, maxPoints: 34, note: 'Strefa docelowa.' },
      { key: 'termStructure', label: 'Nachylenie', points: 22, maxPoints: 22, note: 'Kontango.' },
      { key: 'cheapness', label: 'Taniość', points: 9.4, maxPoints: 16, note: 'Drogo.' },
      { key: 'liquidity', label: 'Płynność', points: 14, maxPoints: 18, note: 'OK.' },
      { key: 'ivRank', label: 'IV rank', points: 5.5, maxPoints: 10, note: 'Neutralnie.' },
    ],
    flags: ['STREFA-DOCELOWA', 'KONTANGO'],
    suggestedEntryDate: '2026-10-01',
    warnings: [],
    ...overrides,
  };
}

function scanWith(candidates: CalendarCandidate[], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    generatedAt: '2026-09-24T21:10:04.512Z',
    asOf: '2026-09-24',
    scannerVersion: '1.0.0',
    config: {
      alertMinDays: 25,
      alertMaxDays: 45,
      optionsProvider: 'tastytrade',
      earningsProvider: 'finnhub',
      tradierEnv: 'sandbox',
    },
    counts: {
      universe: 200,
      withUpcomingEarnings: 10,
      inAlertWindow: candidates.length,
      analyzed: candidates.length,
      candidates: candidates.length,
      alertsSent: 1,
    },
    candidates,
    watchlistOnly: [],
    errors: [],
    durationMs: 1234,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Budowa wiersza
// ─────────────────────────────────────────────────────────────────────────────

test('buildCandidateRow: wiersz ma dokładnie te kolumny, co schemat', () => {
  const row = buildCandidateRow(scanWith([]), candidate());
  assert.deepEqual(Object.keys(row).sort(), [...CANDIDATE_COLUMNS].sort());
  // Kolejność w CSV bierze się z CANDIDATE_COLUMNS, ale brakująca kolumna w obiekcie
  // oznaczałaby ciche puste pole — dlatego sprawdzamy obie strony.
  for (const col of CANDIDATE_COLUMNS) {
    assert.ok(col in row, `brak kolumny ${col} w wierszu`);
  }
});

test('buildCandidateRow: mapuje wartości sygnału i nóg', () => {
  const row = buildCandidateRow(scanWith([]), candidate());
  assert.equal(row.schema_version, String(SCHEMA_VERSION));
  assert.equal(row.as_of, '2026-09-24');
  assert.equal(row.symbol, 'MU');
  assert.equal(row.earnings_date, '2026-10-20');
  assert.equal(row.earnings_confirmed, 'true');
  assert.equal(row.days_to_earnings, '26');
  assert.equal(row.score, '82');
  assert.equal(row.grade, 'A');
  assert.equal(row.flags, 'STREFA-DOCELOWA;KONTANGO');
  assert.equal(row.front_expiration, '2026-10-16');
  assert.equal(row.front_iv, '0.320000');
  assert.equal(row.front_iv_source, 'provider');
  assert.equal(row.front_pricing_source, 'mid');
  assert.equal(row.back_expiration, '2026-11-20');
  assert.equal(row.term_structure_slope, '0.080000');
  assert.equal(row.days_front_to_earnings, '4', 'dodatnie = front przed wynikami');
  assert.equal(row.iv_rank, '34');
  assert.equal(row.options_provider, 'tastytrade');
  assert.equal(row.scanner_version, '1.0.0');
});

test('buildCandidateRow: liczy relację implied/historyczny (tania opcjonalność)', () => {
  // implied 6.65% vs historyczny 5% => 1.33 (drogo)
  const row = buildCandidateRow(scanWith([]), candidate());
  assert.equal(row.implied_vs_historical, '1.330000');
  assert.equal(row.avg_historical_move, '0.050000');

  // Gdy implied < historyczny, wskaźnik spada poniżej 1
  const cheap = buildCandidateRow(
    scanWith([]),
    candidate({ front: { ...candidate().front!, impliedMovePct: 0.02 } }),
  );
  assert.equal(cheap.implied_vs_historical, '0.400000');
});

test('buildCandidateRow: rozróżnia źródło IV rank (dostawca vs własna historia)', () => {
  const viaProvider = buildCandidateRow(scanWith([]), candidate());
  assert.equal(viaProvider.iv_rank_source, 'provider', 'tastytrade daje IV rank z API');

  const viaHistory = buildCandidateRow(
    scanWith([], { config: { ...scanWith([]).config, optionsProvider: 'tradier' } }),
    candidate(),
  );
  assert.equal(viaHistory.iv_rank_source, 'history', 'tradier wymaga własnej historii');

  const brak = buildCandidateRow(scanWith([]), candidate({ ivRank: undefined }));
  assert.equal(brak.iv_rank, '');
  assert.equal(brak.iv_rank_source, '');
});

test('buildCandidateRow: brakujące wartości są puste, nie zerowe', () => {
  // Różnica jest istotna: 0 to zmierzona wartość, puste pole to brak danych.
  // Wpisałbyś zero do średniej i zafałszował backtest.
  const row = buildCandidateRow(
    scanWith([]),
    candidate({ front: undefined, back: undefined, ivRank: undefined, avgHistoricalMovePct: undefined }),
  );
  assert.equal(row.front_iv, '');
  assert.equal(row.front_expiration, '');
  assert.equal(row.back_iv, '');
  assert.equal(row.iv_rank, '');
  assert.equal(row.avg_historical_move, '');
  assert.equal(row.implied_vs_historical, '');
});

test('buildCandidateRow: punkty składowych są rozbite do osobnych kolumn', () => {
  const row = buildCandidateRow(scanWith([]), candidate());
  assert.equal(row.points_timing, '34.00');
  assert.equal(row.points_term_structure, '22.00');
  assert.equal(row.points_cheapness, '9.40');
  assert.equal(row.points_liquidity, '14.00');
  assert.equal(row.points_iv_rank, '5.50');
  assert.equal(row.warnings_count, '0');
});

test('rowKey: identyfikuje wiersz po dniu, spółce i cyklu wyników', () => {
  const a = buildCandidateRow(scanWith([]), candidate());
  const b = buildCandidateRow(scanWith([]), candidate());
  assert.equal(rowKey(a), rowKey(b), 'ten sam sygnał => ten sam klucz');

  const innyDzien = buildCandidateRow(scanWith([], { asOf: '2026-09-25' }), candidate());
  assert.notEqual(rowKey(a), rowKey(innyDzien), 'inny dzień skanu => inny wiersz');

  const innyCykl = buildCandidateRow(
    scanWith([]),
    candidate({ earnings: { symbol: 'MU', date: '2027-01-20', timing: 'amc', confirmed: true } }),
  );
  assert.notEqual(rowKey(a), rowKey(innyCykl), 'inny cykl wyników => inny wiersz');
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

test('csvEscape: escapuje przecinki, cudzysłowy i nowe linie (RFC 4180)', () => {
  assert.equal(csvEscape('proste'), 'proste');
  assert.equal(csvEscape(''), '');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('Micron "MU" Inc'), '"Micron ""MU"" Inc"');
  assert.equal(csvEscape('linia1\nlinia2'), '"linia1\nlinia2"');
});

test('CSV: round-trip zachowuje wartości z przecinkami i cudzysłowami', () => {
  const rows = [
    buildCandidateRow(scanWith([]), candidate({ name: 'Firma, z przecinkiem "i cudzysłowem"' })),
  ];
  const csv = toCsv(CANDIDATE_COLUMNS, rows);
  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, 'Firma, z przecinkiem "i cudzysłowem"');
  assert.equal(parsed[0]!.symbol, 'MU');
  assert.equal(parsed[0]!.score, '82');
});

test('CSV: kończy się newline (inaczej doklejanie skleja wiersze)', () => {
  const csv = toCsv(['a', 'b'], [{ a: '1', b: '2' }]);
  assert.ok(csv.endsWith('\n'));
  assert.equal(csv, 'a,b\n1,2\n');
});

test('appendRows: dopisuje nowe wiersze i pomija duplikaty', () => {
  const first = toCsv(CANDIDATE_COLUMNS, [buildCandidateRow(scanWith([]), candidate())]);
  const again = appendRows(first, [buildCandidateRow(scanWith([]), candidate())]);
  assert.equal(again.added, 0, 'ten sam dzień i spółka => duplikat pominięty');
  assert.equal(again.skipped, 1);
  assert.equal(again.csv, first, 'treść bez zmian');

  const other = appendRows(
    first,
    [buildCandidateRow(scanWith([]), candidate({ symbol: 'AMD' }))],
  );
  assert.equal(other.added, 1);
  assert.equal(parseCsv(other.csv).length, 2);
});

test('appendRows: tworzy plik z nagłówkiem, gdy plik jest pusty', () => {
  const result = appendRows('', [buildCandidateRow(scanWith([]), candidate())]);
  assert.equal(result.added, 1);
  const parsed = parseCsv(result.csv);
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]!), [...CANDIDATE_COLUMNS]);
});

test('appendRows: wykrywa niezgodność nagłówka (ochrona przed zniszczeniem zbioru)', () => {
  const obcy = 'as_of,symbol,inna_kolumna\n2026-09-24,MU,x\n';
  const result = appendRows(obcy, [buildCandidateRow(scanWith([]), candidate())]);
  assert.equal(result.headerMismatch, true, 'inny układ kolumn musi zostać zgłoszony');
  assert.deepEqual(result.existingHeader, ['as_of', 'symbol', 'inna_kolumna']);
});

test('appendRows: wielokrotne uruchomienie nie mnoży wierszy (idempotencja)', () => {
  let csv = '';
  const rows = [buildCandidateRow(scanWith([]), candidate())];
  for (let i = 0; i < 5; i++) {
    csv = appendRows(csv, rows).csv;
  }
  assert.equal(parseCsv(csv).length, 1, 'pięć przebiegów tego samego dnia => jeden wiersz');
});

test('rowsFromScans: zbiera wiersze z wielu dni, sortując po dacie', () => {
  const scans = [
    scanWith([candidate({ symbol: 'AMD' })], { asOf: '2026-09-26' }),
    scanWith([candidate({ symbol: 'MU' })], { asOf: '2026-09-24' }),
  ];
  const rows = rowsFromScans(scans);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.as_of, '2026-09-24', 'najstarszy dzień pierwszy');
  assert.equal(rows[0]!.symbol, 'MU');
  assert.equal(rows[1]!.as_of, '2026-09-26');
});

// ─────────────────────────────────────────────────────────────────────────────
// D1
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

/** Atrapa D1Database: przechwytuje SQL i parametry, liczy batche. */
function makeD1(options: { failBatch?: boolean; tables?: string[] } = {}) {
  const captured: CapturedStatement[] = [];
  let batches = 0;

  const makeStatement = (sql: string): D1PreparedStatement => {
    const params: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        params.push(...values);
        return stmt;
      },
      async all() {
        return {
          results: (options.tables ?? ['scan_candidates', 'outcomes', 'scan_runs']).map((name) => ({ name })),
          success: true,
        };
      },
      async first() {
        return null;
      },
      async run() {
        // Rejestrujemy TYLKO tutaj — wcześniej robiłem to też w prepare(), przez co
        // każde zapytanie liczyło się podwójnie i test partii fałszywie nie przechodził.
        captured.push({ sql, params: [...params] });
        return { success: true };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => makeStatement(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (options.failBatch) throw new Error('D1 batch error (symulacja)');
      batches++;
      // Wykonaj wszystkie, żeby parametry się zarejestrowały
      for (const st of statements) await (st as unknown as { run: () => Promise<unknown> }).run();
      return [];
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;

  return { db, captured, get batches() { return batches; } };
}

test('D1: zapisuje kandydatów, watchlist i przebieg w jednej transakcji', async () => {
  const fake = makeD1();
  const env = { DB: fake.db } as unknown as Env;
  const scan = scanWith([candidate(), candidate({ symbol: 'AMD' })]);
  scan.watchlistOnly = [
    { symbol: 'XYZ', earningsDate: '2026-10-22', daysToEarnings: 28, reason: 'brak łańcucha' },
  ];

  const result = await writeScanToD1(env, scan);

  assert.equal(result.attempted, true);
  assert.equal(result.candidatesWritten, 2);
  assert.equal(result.watchlistWritten, 1);
  assert.equal(fake.batches, 1, 'wszystko w JEDNYM batchu = jedna transakcja');

  const inserts = fake.captured.filter((c) => c.sql.includes('INSERT OR REPLACE'));
  const candidateInsert = inserts.find((c) => c.sql.includes('scan_candidates'))!;
  assert.ok(candidateInsert, 'musi być zapytanie do scan_candidates');
  assert.ok(candidateInsert.sql.includes('INSERT OR REPLACE'), 'zapis musi być idempotentny');
  // Liczba parametrów musi wynikać z liczby kolumn schematu (dziś 44), nie z
  // wartości wpisanej na sztywno — inaczej test przestanie chronić po dodaniu kolumny.
  assert.equal(candidateInsert.params.length, 2 * CANDIDATE_COLUMNS.length);

  assert.ok(inserts.some((c) => c.sql.includes('scan_watchlist')), 'watchlist też się zapisuje');
  assert.ok(inserts.some((c) => c.sql.includes('scan_runs')), 'przebieg też się zapisuje');
});

test('D1: liczba wartości zgadza się z liczbą kolumn (inaczej rozjedzie się zapis)', async () => {
  // Ten test istnieje, bo dokładnie ten błąd już wystąpił: lista kolumn CSV i lista
  // kolumn INSERT w D1 były prowadzone osobno i rozjechały się o jedną kolumnę.
  // Skutek byłby cichy — jedno z pól trafiałoby do złej kolumny.
  const fake = makeD1();
  const env = { DB: fake.db } as unknown as Env;
  const jeden = scanWith([candidate()]);
  await writeScanToD1(env, jeden);

  const ins = fake.captured.find((c) => c.sql.includes('INSERT OR REPLACE INTO scan_candidates'))!;
  assert.equal(
    ins.params.length,
    CANDIDATE_COLUMNS.length,
    'jeden wiersz musi mieć dokładnie tyle parametrów, ile jest kolumn',
  );
  // Nazwy kolumn w SQL też muszą się zgadzać co do sztuki
  const kolumnyWSql = ins.sql.slice(ins.sql.indexOf('(') + 1, ins.sql.indexOf(')')).split(',').map((c) => c.trim());
  assert.deepEqual(kolumnyWSql, [...CANDIDATE_COLUMNS], 'SQL musi wymieniać wszystkie kolumny schematu');
});

test('D1: brak bindingu nie wywala skanu, tylko raportuje pominięcie', async () => {
  const result = await writeScanToD1({} as Env, scanWith([candidate()]));
  assert.equal(result.attempted, false);
  assert.match(result.skippedReason!, /Brak bindingu DB/);
  assert.equal(result.candidatesWritten, 0);
});

test('D1: błąd zapisu nie rzuca wyjątku (dane w KV zostają źródłem prawdy)', async () => {
  const fake = makeD1({ failBatch: true });
  const env = { DB: fake.db } as unknown as Env;
  const result = await writeScanToD1(env, scanWith([candidate()]));
  assert.equal(result.attempted, true);
  assert.equal(result.candidatesWritten, 0, 'nie raportujemy sukcesu po błędzie');
  assert.match(result.skippedReason!, /Błąd zapisu/);
});

test('D1: partie nie przekraczają limitu parametrów zapytania', async () => {
  const fake = makeD1();
  const env = { DB: fake.db } as unknown as Env;
  // 23 kandydatów => 5 zapytań po 5 i jedno na 3
  const many = Array.from({ length: 23 }, (_, i) => candidate({ symbol: `S${i}` }));
  const result = await writeScanToD1(env, scanWith(many));

  assert.equal(result.candidatesWritten, 23);
  const inserts = fake.captured.filter((c) => c.sql.includes('INSERT OR REPLACE INTO scan_candidates'));

  // Twardy limit D1 na darmowym planie to 100 parametrów na zapytanie.
  const perRow = CANDIDATE_COLUMNS.length;
  for (const ins of inserts) {
    assert.ok(
      ins.params.length <= 100,
      `przekroczony limit parametrów D1: ${ins.params.length} (limit 100)`,
    );
    assert.equal(
      ins.params.length % perRow,
      0,
      'każda partia musi mieć pełne wiersze — inaczej rozjechałaby się kolejność wartości',
    );
  }
  const rowsPerBatch = Math.floor(100 / perRow);
  const expectedBatches = Math.ceil(23 / rowsPerBatch);
  assert.equal(
    inserts.length,
    expectedBatches,
    `23 kandydatów po ${rowsPerBatch} na partię => ${expectedBatches} partie`,
  );
});

test('D1: NULL zamiast undefined dla brakujących wartości', async () => {
  const fake = makeD1();
  const env = { DB: fake.db } as unknown as Env;
  await writeScanToD1(
    env,
    scanWith([candidate({ front: undefined, ivRank: undefined, name: undefined })]),
  );
  const ins = fake.captured.find((c) => c.sql.includes('scan_candidates'))!;
  assert.ok(!ins.params.includes(undefined), 'D1 nie przyjmuje undefined — musi być null');
  assert.ok(ins.params.includes(null), 'braki muszą być zapisane jako NULL');
});

test('checkD1Schema: rozpoznaje brakujące tabele i podaje gotową komendę', async () => {
  const ok = await checkD1Schema({ DB: makeD1().db } as unknown as Env);
  assert.equal(ok.ok, true);

  const brak = await checkD1Schema({ DB: makeD1({ tables: ['scan_candidates'] }).db } as unknown as Env);
  assert.equal(brak.ok, false);
  assert.match(brak.detail, /outcomes/);
  assert.match(brak.detail, /schema\.sql/, 'komunikat musi mówić, jak naprawić');

  const bezBazy = await checkD1Schema({} as Env);
  assert.equal(bezBazy.ok, false);
  assert.match(bezBazy.detail, /Brak bindingu DB/);
});

