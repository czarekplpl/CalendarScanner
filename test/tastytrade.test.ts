/**
 * Testy adaptera tastytrade — pisane pod FAKTYCZNY kształt API.
 *
 * Kształt odpowiedzi został potwierdzony empirycznie na koncie produkcyjnym
 * (dokumentacja milczy o wielu szczegółach). Testy kodują te ustalenia, żeby
 * zmiana adaptera nie wprowadziła cichego błędu.
 *
 * NAJWAŻNIEJSZE RZECZY, KTÓRYCH PILNUJĄ:
 *  1. SKALE ZMIENNOŚCI. API miesza ułamki i procenty między polami:
 *       implied-volatility-index-rank  = 0.252  (ułamek!)
 *       implied-volatility-30-day      = 67.78  (procent!)
 *       option-expiration-implied-volatilities[].implied-volatility = 0.32 (ułamek)
 *     Pomylenie skali daje IV rank 0.25% zamiast 25% — liczbę wyglądającą
 *     wiarygodnie, która cicho psuje cały scoring.
 *  2. BATCH. Jedno zapytanie obsługuje do 200 symboli. Gdyby adapter zaczął
 *     pytać pojedynczo, skan zwolniłby z sekund do kilkunastu minut.
 *  3. POTWIERDZONA DATA WYNIKÓW. `estimated: false` znaczy, że spółka podała
 *     datę — takie daty się nie przesuwają i mogą skorygować kalendarz Finnhuba.
 *  4. BRAK NOTOWAŃ. API nie daje cen opcji na naszym poziomie uprawnień, więc
 *     implied move jest modelem i MUSI być tak oznaczony.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  liquidityToOpenInterestProxy,
  normalizeIvToFraction,
  normalizeTiming,
  TastytradeAdapter,
  type SymbolMetrics,
} from '../src/adapters/tastytrade.ts';

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function withFetch<T>(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Recorded[] }> {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return run()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function makeKv(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  const api = {
    _store: store,
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
  };
  return api as unknown as KVNamespace & { _store: Map<string, string> };
}

const CREDS = { clientSecret: 'secret-abc', refreshToken: 'refresh-xyz', environment: 'sandbox' as const };
const TOKEN_OK = { access_token: 'jwt-1', expires_in: 900, token_type: 'Bearer' };

/** Realistyczne metryki — dokładnie te pola i skale, które zwraca API. */
function metricsItem(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol,
    'implied-volatility-index': '0.677833152',
    'implied-volatility-index-rank': '0.252397109',
    'implied-volatility-percentile': '0.272947139',
    'implied-volatility-30-day': '67.78',
    'historical-volatility-30-day': '53.38',
    'historical-volatility-60-day': '78.28',
    'historical-volatility-90-day': '89.09',
    'iv-hv-30-day-difference': '14.4',
    'liquidity-rating': 3,
    'market-cap': 1147237562785,
    sector: 'Technology',
    industry: 'Semiconductors',
    beta: '2.083576099',
    earnings: { visible: true, 'expected-report-date': '2026-09-30', estimated: false, 'time-of-day': 'AMC' },
    'option-expiration-implied-volatilities': [
      { 'expiration-date': '2026-10-16', 'implied-volatility': '1.111991966' },
      { 'expiration-date': '2026-10-23', 'implied-volatility': '0.617505703' },
      { 'expiration-date': '2026-11-20', 'implied-volatility': '0.507078374' },
    ],
    ...overrides,
  };
}

function chainItems(symbol: string) {
  const out: unknown[] = [];
  // Grudniowe wygaśnięcie jest potrzebne w testach fallbacku na IV indeks:
  // metryki nie mają dla niego IV per termin, więc punkt musi powstać z IV indeksu.
  for (const exp of ['2026-10-16', '2026-10-23', '2026-11-20', '2026-12-18']) {
    for (const k of [150, 155, 160, 165, 170]) {
      for (const t of ['C', 'P']) {
        // Nazwy pól z MYŚLNIKAMI — dokładnie jak w prawdziwym API (patrz komentarz
        // w adapterze). Mock ze podkreśleniami przepuściłby błąd, który realnie wystąpił.
        out.push({
          symbol: `${symbol}   261016${t}00${k * 1000}`,
          'strike-price': String(k),
          'option-type': t,
          'expiration-date': exp,
          'expiration-type': 'Regular',
        });
      }
    }
  }
  return out;
}

function router(overrides: Record<string, unknown> = {}) {
  return (url: string) => {
    if (url.includes('/oauth/token')) return { status: 200, body: TOKEN_OK };
    if (url.includes('/market-metrics')) {
      const syms = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '')
        .split(',')
        .filter(Boolean);
      return {
        status: 200,
        body: { data: { items: syms.map((x) => metricsItem(x, (overrides[x] as Record<string, unknown>) ?? {})) } },
      };
    }
    if (url.includes('/option-chains/')) {
      const sym = url.split('/option-chains/')[1]!.split('?')[0]!;
      return { status: 200, body: { data: { items: chainItems(sym) } } };
    }
    throw new Error(`Nieoczekiwany URL: ${url}`);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizacja skal — najważniejsze testy w pliku
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeIvToFraction: ułamki zostają, procenty są przeliczane', () => {
  assert.equal(normalizeIvToFraction(0.252397109), 0.252397109);
  assert.equal(normalizeIvToFraction(0.677833152), 0.677833152);
  assert.equal(normalizeIvToFraction(67.78), 0.6778);
  assert.equal(normalizeIvToFraction(53.38), 0.5338);
  // Granica 3.0: świadomie traktowana jako PROCENT, bo IV = 300% nie występuje
  // na płynnych spółkach US, a IV = 3% jak najbardziej. Gdyby próg był odwrotny,
  // realna IV 3% zostałaby odczytana jako 300%.
  assert.equal(normalizeIvToFraction(3), 0.03, 'dokładnie 3 to 3%, nie 300%');
  assert.equal(normalizeIvToFraction(2.99), 2.99, 'poniżej progu uznajemy za ułamek (299%)');
  assert.equal(normalizeIvToFraction(undefined), undefined);
  assert.equal(normalizeIvToFraction(0), undefined, 'zero to brak danych, nie 0%');
  assert.equal(normalizeIvToFraction(-5), undefined);
  assert.equal(normalizeIvToFraction(NaN), undefined);
});

test('normalizeTiming: mapuje kody pory dnia z API', () => {
  assert.equal(normalizeTiming('AMC'), 'amc');
  assert.equal(normalizeTiming('amc'), 'amc');
  assert.equal(normalizeTiming('BTO'), 'bmo', 'API używa BTO na "before the open"');
  assert.equal(normalizeTiming('BMO'), 'bmo');
  assert.equal(normalizeTiming(''), 'unknown');
  assert.equal(normalizeTiming(undefined), 'unknown');
  assert.equal(normalizeTiming('coś innego'), 'unknown');
});

test('parsowanie metryk: IV rank jako ułamek, IV30 jako procent przeliczony', async () => {
  const m = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU')).then((r) => r.result);

  assert.equal(m.ivRank, 0.252397109, 'IV rank NIE jest dzielony przez 100 — API daje ułamek');
  assert.equal(m.ivPercentile, 0.272947139);
  assert.equal(m.ivIndex, 0.677833152);
  assert.ok(Math.abs(m.iv30! - 0.6778) < 1e-9, 'IV30 z procentów na ułamek');
  assert.ok(Math.abs(m.hv30! - 0.5338) < 1e-9);
  assert.equal(m.ivHvSpread, 14.4, 'premia IV-HV zostaje w punktach procentowych');
  assert.equal(m.liquidityRating, 3);
  assert.equal(m.sector, 'Technology');
  assert.equal(m.industry, 'Semiconductors');
  assert.ok(Math.abs(m.beta! - 2.083576099) < 1e-9);
});

test('parsowanie metryk: term structure jako ułamki per wygaśnięcie', async () => {
  const m = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU')).then((r) => r.result);
  assert.equal(m.expirationIvs.size, 3);
  assert.ok(Math.abs(m.expirationIvs.get('2026-10-16')! - 1.111991966) < 1e-9);
  assert.ok(Math.abs(m.expirationIvs.get('2026-11-20')! - 0.507078374) < 1e-9);
});

test('parsowanie metryk: potwierdzona data wyników z porą dnia', async () => {
  const m = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU')).then((r) => r.result);
  assert.equal(m.earnings?.date, '2026-09-30');
  assert.equal(m.earnings?.estimated, false, 'estimated=false znaczy POTWIERDZONA data');
  assert.equal(m.earnings?.timing, 'amc');
});

test('parsowanie metryk: brak bloku earnings nie wywala parsowania', async () => {
  const m = await withFetch(router({ NOPE: { earnings: undefined } }), () =>
    new TastytradeAdapter(CREDS, {}).marketMetrics('NOPE'),
  ).then((r) => r.result);
  assert.equal(m.earnings, undefined);
  assert.equal(m.ivRank, 0.252397109, 'reszta metryk nadal się parsuje');
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch — wydajność całego skanu zależy od tego
// ─────────────────────────────────────────────────────────────────────────────

test('marketMetricsBatch: 40 spółek = JEDNO zapytanie HTTP', async () => {
  const symbols = Array.from({ length: 40 }, (_, i) => `SYM${i}`);
  const { result, calls } = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetricsBatch(symbols));

  const metricsCalls = calls.filter((c) => c.url.includes('/market-metrics'));
  assert.equal(metricsCalls.length, 1, 'batch musi zmieścić wszystkie spółki w jednym zapytaniu');
  assert.equal(result.size, 40);
  assert.match(metricsCalls[0]!.url, /symbols=SYM0%2CSYM1/);
});

test('marketMetricsBatch: powyżej 200 symboli dzieli na porcje', async () => {
  const symbols = Array.from({ length: 250 }, (_, i) => `S${i}`);
  const { calls } = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetricsBatch(symbols));
  assert.equal(calls.filter((c) => c.url.includes('/market-metrics')).length, 2, '250 symboli => porcje 200 + 50');
});

test('marketMetricsBatch: drugie wołanie korzysta z cache (zero HTTP)', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const { calls } = await withFetch(router(), async () => {
    await adapter.marketMetricsBatch(['MU', 'NFLX']);
    await adapter.marketMetricsBatch(['MU', 'NFLX']);
  });
  assert.equal(calls.filter((c) => c.url.includes('/market-metrics')).length, 1, 'te same spółki nie są pytane dwa razy');
});

test('marketMetricsBatch: błąd 400 dla porcji nie przerywa całości', async () => {
  const { result } = await withFetch(
    (url) => (url.includes('/market-metrics') ? { status: 400, body: { error: 'bad request' } } : router()(url)),
    () => new TastytradeAdapter(CREDS, {}).marketMetricsBatch(['MU']),
  );
  assert.equal(result.size, 0, 'brak metryk => pusta mapa, nie wyjątek');
});

// ─────────────────────────────────────────────────────────────────────────────
// Uwierzytelnianie
// ─────────────────────────────────────────────────────────────────────────────

test('OAuth: wymienia refresh token, wysyła User-Agent, używa domeny środowiska', async () => {
  const { calls } = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU'));

  const oauth = calls.find((c) => c.url.includes('/oauth/token'))!;
  assert.equal(oauth.method, 'POST');
  assert.equal(oauth.headers['user-agent'], 'earnings-iv-scanner/1.0', 'bez User-Agent API zwraca 401');
  const body = oauth.body as { grant_type: string; refresh_token: string; client_secret: string };
  assert.equal(body.grant_type, 'refresh_token');
  assert.equal(body.client_secret, 'secret-abc');

  const api = calls.find((c) => c.url.includes('/market-metrics'))!;
  assert.equal(api.headers.authorization, 'Bearer jwt-1');
  assert.match(api.url, /api\.cert\.tastyworks\.com/, 'sandbox używa domeny cert');
});

test('OAuth: token jest cache\'owany w pamięci — jedna wymiana na wiele żądań', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const { calls } = await withFetch(router(), async () => {
    await adapter.marketMetrics('MU');
    await adapter.expirations('MU');
    await adapter.marketMetrics('NFLX');
  });
  assert.equal(calls.filter((c) => c.url.includes('/oauth/token')).length, 1);
});

test('OAuth: ważny token z KV jest używany bez wymiany', async () => {
  const kv = makeKv();
  await kv.put('tasty:access_token', JSON.stringify({ token: 'jwt-z-kv', expiresAt: Math.floor(Date.now() / 1000) + 600 }));
  const { calls } = await withFetch(router(), () => new TastytradeAdapter(CREDS, { STATE: kv }).marketMetrics('MU'));
  assert.equal(calls.filter((c) => c.url.includes('/oauth/token')).length, 0);
  assert.equal(calls.find((c) => c.url.includes('/market-metrics'))!.headers.authorization, 'Bearer jwt-z-kv');
});

test('OAuth: wygasły token z KV jest wymieniany', async () => {
  const kv = makeKv();
  await kv.put('tasty:access_token', JSON.stringify({ token: 'stary', expiresAt: Math.floor(Date.now() / 1000) - 10 }));
  const { calls } = await withFetch(router(), () => new TastytradeAdapter(CREDS, { STATE: kv }).marketMetrics('MU'));
  assert.equal(calls.filter((c) => c.url.includes('/oauth/token')).length, 1);
});

test('OAuth: brak access_token => komunikat naprowadza na rozdział środowisk', async () => {
  await assert.rejects(
    () =>
      withFetch(
        (url) => (url.includes('/oauth/token') ? { status: 200, body: { token_type: 'Bearer' } } : router()(url)),
        () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU'),
      ),
    (err: Error) => {
      assert.match(err.message, /access_token/);
      assert.match(err.message, /sandbox|produkcja/i);
      return true;
    },
  );
});

test('produkcja używa api.tastyworks.com, nie domeny sandbox', async () => {
  const adapter = new TastytradeAdapter({ ...CREDS, environment: 'production' }, {});
  const { calls } = await withFetch(router(), () => adapter.marketMetrics('MU'));
  assert.match(calls[0]!.url, /api\.tastyworks\.com/);
  assert.ok(!calls[0]!.url.includes('cert'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Punkt IV
// ─────────────────────────────────────────────────────────────────────────────

/** Metryki gotowe do przekazania do buildIvPoint (bez wywołań sieciowych). */
function metricsFor(symbol: string): SymbolMetrics {
  return {
    symbol,
    ivRank: 0.25,
    ivIndex: 0.677833152,
    liquidityRating: 3,
    expirationIvs: new Map([
      ['2026-10-16', 0.32],
      ['2026-11-20', 0.4],
    ]),
  };
}

test('buildIvPoint: IV z metryk dostawcy (najwyższy priorytet)', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(router(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 160.5,
      expiration: '2026-10-16',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
      metrics: metricsFor('MU'),
    }),
  ).then((r) => r.result);

  assert.ok(point);
  assert.equal(point.ivSource, 'provider', 'są realne IV od dostawcy => nie liczymy z modelu');
  assert.equal(point.atmIv, 0.32);
  assert.equal(point.expiration, '2026-10-16');
  assert.equal(point.dte, 22);
  assert.equal(point.daysToEarnings, 4, '4 dni od frontu do wyników');
  assert.equal(point.strikeCount, 5, '5 wspólnych strikeów call/put w łańcuchu');
});

test('buildIvPoint: brak IV dla terminu => schodzi do IV indeksu i oznacza model', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(router(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 160.5,
      expiration: '2026-12-18',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
      metrics: { ...metricsFor('MU'), expirationIvs: new Map() },
    }),
  ).then((r) => r.result);

  assert.ok(point);
  assert.equal(point.ivSource, 'model', 'szacunek musi być jawnie oznaczony');
  assert.ok(Math.abs(point.atmIv - 0.677833152) < 1e-9, 'użyto IV indeksu jako ułamka');
});

test('buildIvPoint: brak jakiegokolwiek źródła IV => brak punktu', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(router(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 160.5,
      expiration: '2026-12-18',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
      metrics: { symbol: 'MU', expirationIvs: new Map() },
    }),
  ).then((r) => r.result);
  assert.equal(point, undefined);
});

test('buildIvPoint: implied move jest modelem i MUSI być tak oznaczony', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(router(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 160,
      expiration: '2026-10-16',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
      metrics: metricsFor('MU'),
    }),
  ).then((r) => r.result);

  assert.ok(point);
  assert.equal(point.pricingSource, 'model-brak-notowan', 'brak cen opcji => jawnie model');
  assert.ok(point.straddleMid > 0, 'cena straddle policzona modelem');
  assert.ok(
    point.impliedMovePct > 0.03 && point.impliedMovePct < 0.12,
    `implied move sensowny, jest ${(point.impliedMovePct * 100).toFixed(1)}%`,
  );
  assert.equal(point.atmSpreadPct, 1, 'spread nieznany bez notowań — NIE zero (zero zawyżałoby ocenę)');
});

test('atmStrike: wybiera strike najbliżej kursu, przy remisie niższy', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  await withFetch(router(), async () => {
    // Kurs dokładnie między 160 i 165 => remis => niższy strike (mniejsze ryzyko przypisania)
    assert.equal(await adapter.atmStrike('MU', 162.5, '2026-10-16'), 160);
    assert.equal(await adapter.atmStrike('MU', 163, '2026-10-16'), 165, 'wyraźnie bliżej 165');
  });
});

test('buildIvPoint: wygaśnięcie w przeszłości => brak punktu', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(router(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 160,
      expiration: '2026-09-01',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
      metrics: metricsFor('MU'),
    }),
  ).then((r) => r.result);
  assert.equal(point, undefined);
});

test('quote(): zwraca undefined — API nie daje notowań na tym poziomie uprawnień', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const { result, calls } = await withFetch(router(), () => adapter.quote());
  assert.equal(result, undefined, 'kurs pochodzi z Finnhuba, nie stąd');
  assert.equal(calls.length, 0, 'nie marnujemy żądania na endpoint, który zwraca 403');
});

test('expirations(): zwraca unikalne, posortowane terminy', async () => {
  const exps = await withFetch(router(), () => new TastytradeAdapter(CREDS, {}).expirations('MU')).then((r) => r.result);
  assert.deepEqual(exps, ['2026-10-16', '2026-10-23', '2026-11-20', '2026-12-18']);
});

test('liquidityToOpenInterestProxy: mapuje zachowawczo, brak ratingu => 0', () => {
  assert.equal(liquidityToOpenInterestProxy(5), 300);
  assert.equal(liquidityToOpenInterestProxy(4), 150);
  assert.equal(liquidityToOpenInterestProxy(3), 80);
  assert.equal(liquidityToOpenInterestProxy(2), 40);
  assert.equal(liquidityToOpenInterestProxy(1), 10);
  assert.equal(liquidityToOpenInterestProxy(undefined), 0, 'brak ratingu => 0, nie zmyślona płynność');
  assert.ok(liquidityToOpenInterestProxy(5) > 100, 'rating 5 przekracza typowy próg');
  assert.ok(liquidityToOpenInterestProxy(3) < 100, 'rating 3 nie udaje płynności powyżej progu');
});
