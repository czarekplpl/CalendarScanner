/**
 * Testy scoringu kalendarza i wyboru nóg.
 *
 * Struktura, której bronią te testy (wybór użytkownika):
 *   long calendar, wejście przed wynikami, ZAMKNIĘCIE PRZED publikacją.
 *   Strefa docelowa: front wygasa 1-10 dni PRZED wynikami.
 *
 * Jeśli zmieniasz wagi w SCORE_WEIGHTS albo progi w scoreTiming, te testy
 * powiedzą Ci, które przypadki przestały być oceniane zgodnie z zamysłem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CRITICAL_SCORE,
  MAX_SCORE,
  scoreCandidate,
  scoreTiming,
  scoreTermStructure,
} from '../src/core/scoring.ts';
import { selectCalendarLegs } from '../src/adapters/tradier.ts';
import type { EarningsEvent, IvPoint } from '../src/types.ts';

function ivPoint(overrides: Partial<IvPoint> = {}): IvPoint {
  return {
    expiration: '2026-10-16',
    dte: 22,
    daysToEarnings: 4, // front 4 dni PRZED wynikami = strefa docelowa
    atmIv: 0.38,
    ivSource: 'computed',
    straddleMid: 3.4,
    impliedMovePct: 0.046,
    atmOpenInterest: 1500,
    atmSpreadPct: 0.02,
    strikeCount: 50,
    ...overrides,
  };
}

function earnings(overrides: Partial<EarningsEvent> = {}): EarningsEvent {
  return { symbol: 'TEST', date: '2026-10-20', timing: 'amc', confirmed: true, ...overrides };
}

test('scoreTiming: front wygasa 1-10 dni przed wynikami = maksimum', () => {
  for (const d of [1, 4, 7, 10]) {
    const c = scoreTiming(d);
    assert.equal(c.points, c.maxPoints, `d=${d} powinno dać maksimum`);
  }
  assert.match(scoreTiming(4).note, /strefa docelowa/i);
});

test('scoreTiming: front 11-25 dni przed wynikami = dobry, ale niższy', () => {
  const good = scoreTiming(18);
  assert.ok(good.points < scoreTiming(5).points);
  assert.ok(good.points > 0.6 * good.maxPoints, 'wciąż sensowna ocena');
  assert.match(good.note, /przedwczesne|napływa/i);
});

test('scoreTiming: front wygasa w dniach wyników (±3 dni) = akceptowalne z zastrzeżeniem', () => {
  const atEarnings = scoreTiming(0);
  const justAfter = scoreTiming(-2);
  assert.ok(atEarnings.points < scoreTiming(5).points, 'musi być niżej niż strefa docelowa');
  assert.ok(atEarnings.points > scoreTiming(-10).points, 'ale wyżej niż front głęboko po wynikach');
  assert.match(justAfter.note, /pin risk|po wynikach/i);
});

test('scoreTiming: front wygasa daleko po wynikach = kara (krótka noga w zdarzeniu)', () => {
  const deepAfter = scoreTiming(-14);
  assert.ok(deepAfter.points < 0.4 * deepAfter.maxPoints);
  assert.match(deepAfter.note, /PO wynikach/);
});

test('scoreTiming: front za wcześnie przed wynikami = kara (płaska krzywa)', () => {
  const tooEarly = scoreTiming(35);
  assert.ok(tooEarly.points < 0.4 * tooEarly.maxPoints);
  assert.match(tooEarly.note, /za wcześnie/i);
});

test('scoreTermStructure: dodatnie nachylenie premiowane (teza strategii), odwrócona krzywa karana', () => {
  const steep = scoreTermStructure(0.32, 0.4); // +8 pp
  const flat = scoreTermStructure(0.35, 0.35);
  const inverted = scoreTermStructure(0.45, 0.38); // -7 pp
  assert.equal(steep.points, steep.maxPoints);
  assert.ok(flat.points < steep.points);
  assert.ok(inverted.points < flat.points);
  assert.ok(inverted.points < inverted.maxPoints * 0.2, 'silnie odwrócona krzywa prawie bez punktów');
  assert.match(inverted.note, /odwrócona|zrealizowana/i);
});

test('scoreCandidate: układ docelowy dostaje wysoką ocenę i flagi', () => {
  const candidate = scoreCandidate({
    symbol: 'IDEA',
    spot: 100,
    earnings: earnings({ date: '2026-10-20' }),
    front: ivPoint({ expiration: '2026-10-16', daysToEarnings: 4, atmIv: 0.35, impliedMovePct: 0.04 }),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.42 }),
    daysToEarnings: 26,
    today: '2026-09-24',
    ivRank: 15,
    avgHistoricalMovePct: 0.06, // implied 4% < historyczne 6% => tania opcjonalność
    minOpenInterest: 100,
  });

  assert.ok(candidate.score >= 80, `oczekiwano oceny >= 80, jest ${candidate.score}`);
  assert.equal(candidate.grade, 'A');
  assert.ok(candidate.flags.includes('STREFA-DOCELOWA'));
  assert.ok(candidate.flags.includes('KONTANGO'));
  assert.ok(candidate.flags.includes('TANIA-OPCJONALNOSC'));
  assert.ok(candidate.flags.includes('IV-NISKO'));
  assert.ok(candidate.flags.includes('GOTOWY-DO-ANALIZY'));
  assert.equal(candidate.earningsInsideBackOnly, true);
  assert.equal(candidate.warnings.length, 0, 'układ docelowy nie powinien mieć ostrzeżeń');
});

test('scoreCandidate: wyniki we froncie generują flagę i ostrzeżenie o gapie', () => {
  const candidate = scoreCandidate({
    symbol: 'GAP',
    spot: 100,
    earnings: earnings({ date: '2026-10-14' }),
    front: ivPoint({ expiration: '2026-10-16', daysToEarnings: -2, atmIv: 0.5 }),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -37, atmIv: 0.45 }),
    daysToEarnings: 20,
    today: '2026-09-24',
    minOpenInterest: 100,
  });
  assert.ok(candidate.flags.includes('FRONT-NA-WYNIKACH'), 'wyniki 2 dni po froncie = flaga o zdarzeniu na nodze');
  assert.ok(candidate.warnings.some((w) => /pin risk|przesunąć/i.test(w)));
  assert.equal(candidate.earningsInsideBackOnly, false);
});

test('scoreCandidate: krytyczne problemy ścinają ocenę do MAX_CRITICAL_SCORE', () => {
  // Niepotwierdzona data + front głęboko po wynikach. Reszta parametrów jest dobra,
  // żeby sprawdzić, że to WŁAŚNIE ograniczenie krytyczne decyduje o wyniku.
  const candidate = scoreCandidate({
    symbol: 'CRIT',
    spot: 100,
    earnings: earnings({ confirmed: false, timing: 'unknown', date: '2026-10-02' }),
    front: ivPoint({
      expiration: '2026-10-16',
      daysToEarnings: -14,
      atmIv: 0.4,
      impliedMovePct: 0.04,
      atmOpenInterest: 5000,
    }),
    back: ivPoint({
      expiration: '2026-11-20',
      dte: 57,
      daysToEarnings: -49,
      atmIv: 0.45,
      atmOpenInterest: 4000,
    }),
    daysToEarnings: 8,
    today: '2026-09-24',
    ivRank: 10,
    avgHistoricalMovePct: 0.08,
    minOpenInterest: 100,
  });
  assert.ok(
    candidate.score <= MAX_CRITICAL_SCORE,
    `ocena musi być ścięta do ${MAX_CRITICAL_SCORE}, jest ${candidate.score}`,
  );
  assert.ok(['C', 'D'].includes(candidate.grade));
});

test('scoreCandidate: niska płynność ścina ocenę niezależnie od reszty', () => {
  const candidate = scoreCandidate({
    symbol: 'THIN',
    spot: 100,
    earnings: earnings(),
    front: ivPoint({ daysToEarnings: 5, atmOpenInterest: 25, atmSpreadPct: 0.03 }),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.44, atmOpenInterest: 30 }),
    daysToEarnings: 26,
    today: '2026-09-24',
    ivRank: 10,
    avgHistoricalMovePct: 0.07,
    minOpenInterest: 100,
  });
  assert.ok(candidate.score <= MAX_CRITICAL_SCORE, 'brak płynności to problem krytyczny');
  assert.ok(candidate.warnings.some((w) => /Niski open interest/i.test(w)));
});

test('scoreCandidate: zły układ zbiera ostrzeżenia i wypada nisko', () => {
  const candidate = scoreCandidate({
    symbol: 'BAD',
    spot: 50,
    earnings: earnings({ date: '2026-10-14' }),
    front: ivPoint({
      expiration: '2026-10-16',
      daysToEarnings: -2,
      atmIv: 0.85,
      impliedMovePct: 0.12,
      atmOpenInterest: 20,
      atmSpreadPct: 0.15,
    }),
    back: ivPoint({
      expiration: '2026-11-20',
      dte: 57,
      daysToEarnings: -37,
      atmIv: 0.6,
      atmOpenInterest: 30,
      atmSpreadPct: 0.14,
    }),
    daysToEarnings: 20,
    today: '2026-09-24',
    ivRank: 92,
    avgHistoricalMovePct: 0.04, // implied 12% >> historyczne 4% => drogo
    minOpenInterest: 100,
  });

  assert.ok(candidate.score <= MAX_CRITICAL_SCORE + 5, `ocena powinna być niska, jest ${candidate.score}`);
  assert.ok(candidate.warnings.length >= 2, 'zły układ musi mieć ostrzeżenia');
  assert.ok(
    candidate.warnings.some((w) => /Niski open interest|Szeroki spread/i.test(w)),
    'ostrzeżenia o płynności muszą się pojawić',
  );
});

test('scoreCandidate: punkty składowe sumują się do oceny proporcjonalnie do maksimum', () => {
  const candidate = scoreCandidate({
    symbol: 'SUM',
    spot: 100,
    earnings: earnings(),
    front: ivPoint(),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.4 }),
    daysToEarnings: 26,
    today: '2026-09-24',
    minOpenInterest: 100,
  });

  const sum = candidate.components.reduce((s, c) => s + c.points, 0);
  const expected = Math.round((sum / MAX_SCORE) * 100);
  assert.equal(candidate.score, expected, 'ocena = suma składowych przeskalowana do 100 (bez cięcia)');
  for (const comp of candidate.components) {
    assert.ok(comp.points <= comp.maxPoints, `${comp.key}: punkty nie mogą przekraczać maksimum`);
    assert.ok(comp.points >= 0, `${comp.key}: punkty nie mogą być ujemne`);
  }
});

test('scoreCandidate: brak historii IV daje neutralną ocenę składowej, nie zero', () => {
  const base = {
    symbol: 'A' as const, spot: 100, earnings: earnings(), front: ivPoint(),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.4 }),
    daysToEarnings: 26, today: '2026-09-24', minOpenInterest: 100,
  };
  const withHistory = scoreCandidate({ ...base, ivRank: 20 });
  const withoutHistory = scoreCandidate({ ...base, ivRank: undefined });
  const compWith = withHistory.components.find((c) => c.key === 'ivRank')!;
  const compWithout = withoutHistory.components.find((c) => c.key === 'ivRank')!;
  assert.equal(compWithout.points, compWithout.maxPoints * 0.5, 'brak historii = połowa punktów (neutralnie)');
  assert.match(compWithout.note, /Za mało danych/);
  assert.ok(compWith.points > compWithout.points, 'niski IV rank powinien dać więcej punktów');
});

test('scoreCandidate: niepotwierdzona data wyników generuje ostrzeżenie i blokuje flagę gotowości', () => {
  const candidate = scoreCandidate({
    symbol: 'UNCONF', spot: 100,
    earnings: earnings({ confirmed: false, timing: 'unknown' }),
    front: ivPoint(),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.4 }),
    daysToEarnings: 26, today: '2026-09-24', minOpenInterest: 100,
  });
  assert.ok(candidate.warnings.some((w) => /niepotwierdzona/i.test(w)));
  assert.ok(!candidate.flags.includes('GOTOWY-DO-ANALIZY'));
});

test('scoreCandidate: ETF dostaje ostrzeżenie o braku własnych wyników', () => {
  const candidate = scoreCandidate({
    symbol: 'XLE', spot: 90,
    earnings: earnings({ symbol: 'XLE' }),
    front: ivPoint(),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.4 }),
    daysToEarnings: 26, today: '2026-09-24', minOpenInterest: 100, isEtf: true,
  });
  assert.ok(candidate.warnings.some((w) => /ETF/i.test(w)));
});

test('scoreCandidate: sugerowana data wejścia wypada przed wygaśnięciem frontu', () => {
  const candidate = scoreCandidate({
    symbol: 'ENTRY', spot: 100, earnings: earnings(), front: ivPoint({ dte: 22 }),
    back: ivPoint({ expiration: '2026-11-20', dte: 57, daysToEarnings: -31, atmIv: 0.4 }),
    daysToEarnings: 26, today: '2026-09-24', minOpenInterest: 100,
  });
  assert.equal(candidate.suggestedEntryDate, '2026-10-01', 'dte 22 - 15 dni = 7 dni od dziś');
});

// ─────────────────────────────────────────────────────────────────────────────
// Wybór nóg kalendarza
// ─────────────────────────────────────────────────────────────────────────────

test('selectCalendarLegs: front przed wynikami, back z zapasem po wynikach', () => {
  const legs = selectCalendarLegs({
    expirations: ['2026-10-02', '2026-10-09', '2026-10-16', '2026-11-20', '2026-12-18'],
    earningsDate: '2026-10-20',
    today: '2026-09-24',
  });
  assert.ok(legs.length > 0, 'musi znaleźć układ nóg');
  const best = legs[0]!;
  assert.equal(best.front, '2026-10-16', 'front najbliżej wyników, ale przed nimi (4 dni)');
  assert.equal(best.back, '2026-11-20', 'back z zapasem 31 dni po wynikach');
  assert.ok(best.front < '2026-10-20', 'front przed wynikami');
  assert.ok(best.back > '2026-10-20', 'back po wynikach');
});

test('selectCalendarLegs: back musi mieć co najmniej 21 dni zapasu po wynikach', () => {
  // Jedyne wygaśnięcia po wynikach dają 3 dni zapasu — za mało na ekspansję.
  const legs = selectCalendarLegs({
    expirations: ['2026-10-09', '2026-10-16', '2026-10-23'],
    earningsDate: '2026-10-20',
    today: '2026-09-24',
  });
  assert.equal(legs.length, 0, 'bez backu z zapasem czasu nie ma sensownego kalendarza');
});

test('selectCalendarLegs: wybiera back z wystarczającym zapasem, pomijając zbyt bliski', () => {
  const legs = selectCalendarLegs({
    expirations: ['2026-10-09', '2026-10-16', '2026-10-23', '2026-11-20'],
    earningsDate: '2026-10-20',
    today: '2026-09-24',
  });
  assert.ok(legs.length > 0);
  for (const leg of legs) {
    assert.notEqual(leg.back, '2026-10-23', 'back z 3-dniowym zapasem musi być pominięty');
    assert.equal(leg.back, '2026-11-20');
  }
});

test('selectCalendarLegs: odrzuca fronty zbyt blisko wygaśnięcia (pin risk, brak płynności)', () => {
  const legs = selectCalendarLegs({
    expirations: ['2026-09-25', '2026-10-16', '2026-11-20'],
    earningsDate: '2026-10-20',
    today: '2026-09-24', // 25.09 to jutro => dte=1, poniżej minFrontDte=7
  });
  for (const leg of legs) {
    assert.notEqual(leg.front, '2026-09-25', 'front z dte=1 musi być odrzucony');
  }
});

test('selectCalendarLegs: odrzuca fronty wygasające za wcześnie przed wynikami', () => {
  const legs = selectCalendarLegs({
    expirations: ['2026-09-25', '2026-10-02', '2026-12-18'],
    earningsDate: '2026-11-05', // front 02.10 wypada 34 dni przed wynikami
    today: '2026-09-24',
  });
  for (const leg of legs) {
    assert.notEqual(leg.front, '2026-10-02', 'front 34 dni przed wynikami jest za wczesny');
  }
});

test('selectCalendarLegs: wymaga dwóch wygaśnięć wokół wyników', () => {
  const legs = selectCalendarLegs({
    expirations: ['2026-10-16'], // tylko jedno wygaśnięcie
    earningsDate: '2026-10-20',
    today: '2026-09-24',
  });
  assert.equal(legs.length, 0, 'bez pary front/back nie ma kalendarza');
});

test('selectCalendarLegs: preferuje wyniki tuż przed wygaśnięciem, gdy jest wybór', () => {
  // Front 16.10 (4 dni przed wynikami) vs 09.10 (11 dni przed) — oba dopuszczalne,
  // ale 16.10 jest bliżej ideału (5 dni), więc musi być pierwszy.
  const legs = selectCalendarLegs({
    expirations: ['2026-10-09', '2026-10-16', '2026-11-20', '2026-12-18'],
    earningsDate: '2026-10-20',
    today: '2026-09-24',
  });
  assert.ok(legs.length >= 2);
  assert.equal(legs[0]!.front, '2026-10-16', 'bliższy ideałowi front musi być pierwszy');
});
