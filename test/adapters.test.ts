/**
 * Testy adapterów: parsowanie odpowiedzi dostawców.
 *
 * DLACZEGO TO JEST WAŻNE: kształtu odpowiedzi Finnhuba i Tradiera nie da się
 * potwierdzić bez kluczy API (endpointy zwracają 401, nie 404 — więc ścieżki są
 * poprawne, ale zawartości nie zobaczymy). Jedyne, co możemy zrobić, to:
 *   1. zakodować udokumentowany/zrealistyczny kształt odpowiedzi,
 *   2. przetestować parsowanie i zachowanie na przypadkach brzegowych,
 *   3. upewnić się, że nieoczekiwany kształt NIE wywala skanu.
 *
 * Ten plik jest kontraktem ze światem zewnętrznym. Jeśli dostawca zmieni format,
 * te testy nadal przejdą (bo mockują fetch), ale `scan-local.ts` pokaże problem
 * na prawdziwych danych — dlatego po zmianie dostawcy uruchom skan lokalnie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FinnhubAdapter, approxMoveFromSurprises } from '../src/adapters/finnhub.ts';
import { TradierAdapter } from '../src/adapters/tradier.ts';
import { daysBetween } from '../src/core/market.ts';
import type { EarningsHistoryPoint } from '../src/types.ts';

/** Podstawia globalny fetch na czas testu i zwraca listę wywołanych URL-i. */
function withFetch<T>(
  handler: (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const { status, body } = await handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return run()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Finnhub
// ─────────────────────────────────────────────────────────────────────────────

test('finnhub: parsuje kalendarz wyników wg dokumentowanego formatu', async () => {
  const payload = {
    earningsCalendar: [
      { symbol: 'NKE', date: '2026-10-20', hour: 'amc', epsEstimate: 0.52, revenueEstimate: 12_400_000_000, quarter: 1, year: 2027 },
      { symbol: 'MU', date: '2026-10-08', hour: 'bmo', epsEstimate: 2.1, revenueEstimate: null, quarter: 4, year: 2026 },
      { symbol: 'PEP', date: '2026-10-30', hour: '', epsEstimate: 2.3 },
    ],
  };

  const { result, calls } = await withFetch(
    () => ({ status: 200, body: payload }),
    () => new FinnhubAdapter('test-key').listEarnings('2026-10-01', '2026-10-31'),
  );

  assert.equal(result.length, 3);
  assert.match(calls[0]!, /\/calendar\/earnings\?from=2026-10-01&to=2026-10-31&token=test-key/);

  const nke = result.find((e) => e.symbol === 'NKE')!;
  assert.equal(nke.date, '2026-10-20');
  assert.equal(nke.timing, 'amc');
  assert.equal(nke.confirmed, true, 'AMC/BMO = data potwierdzona');
  assert.equal(nke.epsEstimate, 0.52);

  const pep = result.find((e) => e.symbol === 'PEP')!;
  assert.equal(pep.timing, 'unknown');
  assert.equal(pep.confirmed, false, 'brak godziny = data szacowana (bezpieczna domyślna postawa)');
});

test('finnhub: odsiewa wpisy bez symbolu lub daty, nie wywala się', async () => {
  const payload = {
    earningsCalendar: [
      { symbol: 'AAPL', date: '2026-10-29', hour: 'amc' },
      { symbol: null, date: '2026-10-30', hour: 'bmo' },
      { symbol: 'MSFT', date: null },
      { symbol: 'googl', date: '2026-10-27', hour: 'amc' }, // mała litera — normalizujemy
    ],
  };
  const { result } = await withFetch(
    () => ({ status: 200, body: payload }),
    () => new FinnhubAdapter('k').listEarnings('2026-10-01', '2026-10-31'),
  );
  assert.deepEqual(
    result.map((e) => e.symbol),
    ['AAPL', 'GOOGL'],
  );
});

test('finnhub: nieoczekiwany kształt odpowiedzi zwraca pustą listę, nie błąd', async () => {
  for (const body of [{}, { earningsCalendar: null }, { unexpected: 'shape' }, []]) {
    const { result } = await withFetch(
      () => ({ status: 200, body }),
      () => new FinnhubAdapter('k').listEarnings('2026-10-01', '2026-10-31'),
    );
    assert.deepEqual(result, [], `kształt ${JSON.stringify(body)} powinien dać pustą listę`);
  }
});

test('finnhub: 401 rzuca czytelny błąd z kodem statusu', async () => {
  await assert.rejects(
    () =>
      withFetch(
        () => ({ status: 401, body: { error: 'Please use an API key.' } }),
        () => new FinnhubAdapter('zly-klucz').listEarnings('2026-10-01', '2026-10-31'),
      ),
    (err: Error) => {
      assert.match(err.message, /401/);
      return true;
    },
  );
});

test('finnhub: historia wyników parsuje się i degradacja jest miękka', async () => {
  const payload = [
    { symbol: 'AAPL', period: '2026-06-30', actual: 1.4, estimate: 1.35, surprise: 0.05, surprisePercent: 3.7 },
    { symbol: 'AAPL', period: '2026-03-31', actual: 1.65, estimate: 1.62, surprise: 0.03, surprisePercent: 1.85 },
    { symbol: 'AAPL', period: '2025-12-31', actual: 2.4, estimate: 2.35, surprise: 0.05, surprisePercent: 2.1 },
    { symbol: 'AAPL', period: '2025-09-30', actual: 1.64, estimate: 1.6, surprise: 0.04, surprisePercent: 2.5 },
  ];
  const { result } = await withFetch(
    () => ({ status: 200, body: payload }),
    () => new FinnhubAdapter('k').earningsHistory('AAPL', 8),
  );
  assert.equal(result.length, 4);
  assert.equal(result[0]!.date, '2026-06-30');
  assert.equal(result[0]!.surprisePercent, 3.7);

  // Błąd 403 (endpoint niedostępny w planie) => pusta lista, nie wyjątek
  const { result: empty } = await withFetch(
    () => ({ status: 403, body: { error: 'You do not have access' } }),
    () => new FinnhubAdapter('k').earningsHistory('AAPL', 8),
  );
  assert.deepEqual(empty, []);
});

test('approxMoveFromSurprises: wymaga minimum 4 próbek i filtrów sensowności', () => {
  const mk = (pct: number | undefined): EarningsHistoryPoint => ({ date: '2026-06-30', surprisePercent: pct });

  assert.equal(approxMoveFromSurprises([]).avgAbsMovePct, undefined, 'brak danych => brak wyniku');
  assert.equal(approxMoveFromSurprises([mk(3), mk(4), mk(5)]).avgAbsMovePct, undefined, '3 próbki to za mało');
  assert.equal(approxMoveFromSurprises([mk(3), mk(4), mk(5)]).samples, 3);

  const ok = approxMoveFromSurprises([mk(3), mk(-5), mk(4), mk(2)]);
  assert.equal(ok.samples, 4);
  assert.equal(ok.avgAbsMovePct, 0.035, 'średnia z wartości bezwzględnych: (3+5+4+2)/4 = 3.5%');

  // Wartości absurdalne (np. błąd danych) są odsiewane: |500| >= 100 wypada.
  // Cztery sensowne próbki (3, 4, 2, 6) zostają => średnia 3.75%.
  const filtered = approxMoveFromSurprises([mk(3), mk(500), mk(4), mk(2), mk(6), mk(undefined)]);
  assert.equal(filtered.samples, 4, 'zostają 4 sensowne próbki (500 odsiane, undefined pominięte)');
  assert.equal(filtered.avgAbsMovePct, 0.0375, 'średnia z 3, 4, 2, 6 = 3.75%');

  // Gdy po odsianiu zostanie mniej niż 4 próbki, funkcja nie zgaduje
  const tooFew = approxMoveFromSurprises([mk(3), mk(500), mk(4), mk(2)]);
  assert.equal(tooFew.avgAbsMovePct, undefined, '3 sensowne próbki to za mało — zwracamy undefined');
});

// ─────────────────────────────────────────────────────────────────────────────
// Tradier
// ─────────────────────────────────────────────────────────────────────────────

const TRADIER_EXPIRATIONS = {
  expirations: { date: ['2026-10-09', '2026-10-16', '2026-10-23', '2026-11-20', '2026-12-18'] },
};

/** Buduje realistyczny łańcuch: calls i puts wokół spot 100. */
function chainPayload(spot: number): unknown {
  const strikes = [90, 95, 100, 105, 110];
  const options: unknown[] = [];
  for (const strike of strikes) {
    for (const type of ['call', 'put'] as const) {
      const itm = type === 'call' ? spot > strike : spot < strike;
      const intrinsic = type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
      const mid = intrinsic + (itm ? 1.2 : 2.6) - Math.abs(strike - spot) * 0.01;
      options.push({
        symbol: `TEST261016${type === 'call' ? 'C' : 'P'}00${strike * 1000}`,
        strike,
        option_type: type,
        bid: Number((mid - 0.05).toFixed(2)),
        ask: Number((mid + 0.05).toFixed(2)),
        last: Number(mid.toFixed(2)),
        volume: 120,
        open_interest: strike === 100 ? 2400 : 300,
        expiration_date: '2026-10-16',
        greeks: null, // sandbox nie zwraca greków — to jest przypadek, który obsługujemy
      });
    }
  }
  return { options: { option: options } };
}

test('tradier: parsuje listę wygaśnięć (pojedyncza data i tablica)', async () => {
  const { result } = await withFetch(
    () => ({ status: 200, body: TRADIER_EXPIRATIONS }),
    () => new TradierAdapter('k').expirations('TEST'),
  );
  assert.deepEqual(result, ['2026-10-09', '2026-10-16', '2026-10-23', '2026-11-20', '2026-12-18']);

  // Gdy dostawca zwróci jedną datę jako string, a nie tablicę
  const { result: single } = await withFetch(
    () => ({ status: 200, body: { expirations: { date: '2026-10-16' } } }),
    () => new TradierAdapter('k').expirations('TEST'),
  );
  assert.deepEqual(single, ['2026-10-16'], 'pojedyncza data musi być obsłużona jak tablica');
});

test('tradier: quote wybiera cenę, radząc sobie z null w sandboxie', async () => {
  const { result } = await withFetch(
    () => ({ status: 200, body: { quotes: { quote: { symbol: 'TEST', last: null, close: 99.5, prevclose: 98 } } } }),
    () => new TradierAdapter('k').quote('TEST'),
  );
  assert.equal(result, 99.5, 'gdy last jest null, bierzemy close');

  const { result: single } = await withFetch(
    () => ({ status: 200, body: { quotes: { quote: { symbol: 'TEST', last: 101.25 } } } }),
    () => new TradierAdapter('k').quote('TEST'),
  );
  assert.equal(single, 101.25, 'pojedynczy obiekt quote musi być obsłużony');
});

test('tradier: buildIvPoint liczy IV ATM z cen, gdy brak greków (sandbox)', async () => {
  const adapter = new TradierAdapter('k', { environment: 'sandbox', riskFreeRate: 0.04 });
  const { result } = await withFetch(
    () => ({ status: 200, body: chainPayload(100) }),
    () =>
      adapter.buildIvPoint({
        symbol: 'TEST',
        spot: 100,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  );

  assert.ok(result, 'punkt IV musi powstać');
  assert.equal(result.expiration, '2026-10-16');
  assert.equal(result.dte, daysBetween('2026-09-24', '2026-10-16'), 'DTE liczone od dziś do wygaśnięcia');
  assert.equal(result.daysToEarnings, daysBetween('2026-10-16', '2026-10-20'), '4 dni od frontu do wyników');
  assert.equal(result.ivSource, 'computed', 'bez greków dostawcy liczymy sami');
  assert.ok(Number.isFinite(result.atmIv) && result.atmIv > 0, `IV musi być sensowna, jest ${result.atmIv}`);
  assert.ok(result.atmIv > 0.2 && result.atmIv < 0.8, `IV powinna być w rozsądnym zakresie, jest ${result.atmIv}`);
  // OI to SUMA obu nóg na strike ATM: call 2400 + put 2400 = 4800.
  // Dla kalendarza liczy się łączna głębokość rynku na tym strike, nie jedna noga.
  assert.equal(result.atmOpenInterest, 4800, 'OI ATM = call + put na tym samym strike');
  assert.ok(result.straddleMid > 0, 'cena straddle musi być dodatnia');
  assert.ok(result.impliedMovePct > 0, 'implied move musi być dodatni');
});

test('tradier: buildIvPoint używa greków dostawcy, gdy są dostępne (konto brokerskie)', async () => {
  const adapter = new TradierAdapter('k', { environment: 'production', riskFreeRate: 0.04 });
  const payload = {
    options: {
      option: [
        { strike: 100, option_type: 'call', bid: 3.0, ask: 3.2, open_interest: 2000, greeks: { mid_iv: 0.412 } },
        { strike: 100, option_type: 'put', bid: 2.9, ask: 3.1, open_interest: 1800, greeks: { mid_iv: 0.428 } },
      ],
    },
  };
  const { result } = await withFetch(
    () => ({ status: 200, body: payload }),
    () =>
      adapter.buildIvPoint({
        symbol: 'TEST',
        spot: 100,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  );
  assert.ok(result);
  assert.equal(result.ivSource, 'provider');
  assert.ok(Math.abs(result.atmIv - 0.42) < 1e-9, `IV powinna być średnią 0.412 i 0.428, jest ${result.atmIv}`);
});

test('tradier: buildIvPoint zwraca undefined przy braku rynku (same zera)', async () => {
  const adapter = new TradierAdapter('k');
  const { result } = await withFetch(
    () => ({
      status: 200,
      body: {
        options: {
          option: [
            { strike: 100, option_type: 'call', bid: 0, ask: 0, last: 0, open_interest: 0, greeks: null },
            { strike: 100, option_type: 'put', bid: 0, ask: 0, last: 0, open_interest: 0, greeks: null },
          ],
        },
      },
    }),
    () =>
      adapter.buildIvPoint({
        symbol: 'TEST',
        spot: 100,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  );
  assert.equal(result, undefined, 'brak wyceny => brak punktu IV, nie zero udające IV');
});

test('tradier: buildIvPoint zwraca undefined dla wygaśnięcia w przeszłości', async () => {
  const adapter = new TradierAdapter('k');
  const { result } = await withFetch(
    () => ({ status: 200, body: chainPayload(100) }),
    () =>
      adapter.buildIvPoint({
        symbol: 'TEST',
        spot: 100,
        expiration: '2026-09-01', // przed "dziś"
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  );
  assert.equal(result, undefined, 'wygaśnięcie w przeszłości nie ma sensu');
});

test('tradier: pusty łańcuch i błąd 400 nie przerywają skanu', async () => {
  const adapter = new TradierAdapter('k');
  const { result: empty } = await withFetch(
    () => ({ status: 200, body: { options: null } }),
    () => adapter.chain('TEST', '2026-10-16'),
  );
  assert.deepEqual(empty, [], 'brak opcji => pusta tablica');

  const { result: on400 } = await withFetch(
    () => ({ status: 400, body: { fault: { faultstring: 'No data for expiration' } } }),
    () => adapter.chain('TEST', '2026-10-17'),
  );
  assert.deepEqual(on400, [], 'HTTP 400 dla konkretnego wygaśnięcia => pusta tablica, nie wyjątek');
});
