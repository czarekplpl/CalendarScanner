/**
 * Testy adaptera tastytrade: OAuth, cache tokenu, metryki IV i budowa punktu IV.
 *
 * DLACZEGO TO WAŻNE, SKORO NIE MAMY POŚWIADOMEŃ:
 * Nie możemy odpytać prawdziwego API, ale możemy — i musimy — sprawdzić logikę,
 * która jest najbardziej podatna na ciche błędy:
 *   - cache tokenu: token żyje 15 minut, a przebieg skanu robi dziesiątki żądań.
 *     Błąd w cache oznacza albo setki wymian tokenu (limit API), albo 401 w połowie
 *     przebiegu (bo użyliśmy wygasłego tokenu).
 *   - kolejność źródeł IV: dostawca > nasz solver z cen > model. Pomylenie
 *     priorytetu oznaczałoby wpisanie szacunku tam, gdzie są realne dane.
 *   - nagłówek User-Agent: bez niego API zwraca 401 na KAŻDE żądanie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TastytradeAdapter, liquidityToOpenInterestProxy } from '../src/adapters/tastytrade.ts';
import { blackScholes } from '../src/core/blackscholes.ts';
import type { Env } from '../src/types.ts';

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Podmienia globalny fetch i zapisuje pełne żądania (URL, nagłówki, ciało). */
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
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return run()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

/** Atrapa KV z licznikiem operacji — do sprawdzania cache tokenu. */
function makeKv(): KVNamespace & { _store: Map<string, string>; _puts: number } {
  const store = new Map<string, string>();
  const api = {
    _store: store,
    _puts: 0,
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      (api as { _puts: number })._puts++;
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
  };
  return api as unknown as KVNamespace & { _store: Map<string, string>; _puts: number };
}

const CREDS = {
  clientSecret: 'secret-abc',
  refreshToken: 'refresh-xyz',
  environment: 'sandbox' as const,
};

const TOKEN_OK = { access_token: 'jwt-token-1', expires_in: 900, token_type: 'Bearer' };

/** Router udający API tastytrade — po jednej gałęzi na endpoint. */
function apiRouter(overrides: Record<string, unknown> = {}) {
  const chainItems = [
    { symbol: 'MU   261016C00160000', strike_price: '160.0', option_type: 'C', expiration_date: '2026-10-16' },
    { symbol: 'MU   261016P00160000', strike_price: '160.0', option_type: 'P', expiration_date: '2026-10-16' },
    { symbol: 'MU   261120C00160000', strike_price: '160.0', option_type: 'C', expiration_date: '2026-11-20' },
    { symbol: 'MU   261120P00160000', strike_price: '160.0', option_type: 'P', expiration_date: '2026-11-20' },
  ];

  return (url: string) => {
    if (url.includes('/oauth/token')) return { status: 200, body: TOKEN_OK };
    if (url.includes('/market-metrics')) {
      return {
        status: 200,
        body: {
          data: {
            items: [
              {
                symbol: 'MU',
                'implied-volatility-rank': '34.5',
                'implied-volatility-percentile': '41.2',
                'implied-volatility-index': '38.9',
                'liquidity-rating': '5',
                'option-expiration-implied-volatilities': [
                  { 'expiration-date': '2026-10-16', 'implied-volatility': '0.3200' },
                  { 'expiration-date': '2026-11-20', 'implied-volatility': '0.4000' },
                ],
              },
            ],
          },
        },
      };
    }
    if (url.includes('/option-chains/')) return { status: 200, body: { data: { items: chainItems } } };
    if (url.includes('equity-option=')) {
      return {
        status: 200,
        body: {
          data: {
            items: [
              { symbol: 'MU   261016C00160000', bid: '6.90', ask: '7.10' },
              { symbol: 'MU   261016P00160000', bid: '5.90', ask: '6.10' },
            ],
          },
        },
      };
    }
    if (url.includes('equity=')) return { status: 200, body: { data: { items: [{ symbol: 'MU', last: '165.00' }] } } };
    if (overrides[url]) return overrides[url] as { status: number; body: unknown };
    throw new Error(`Nieoczekiwany URL w teście: ${url}`);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth i cache tokenu
// ─────────────────────────────────────────────────────────────────────────────

test('tastytrade: wymienia refresh token na access token i wysyła User-Agent', async () => {
  const { result, calls } = await withFetch(
    apiRouter(),
    () => new TastytradeAdapter(CREDS, {}).quote('MU'),
  );

  assert.equal(result, 165);
  const oauth = calls.find((c) => c.url.includes('/oauth/token'))!;
  assert.equal(oauth.method, 'POST');
  assert.equal(oauth.headers['user-agent'], 'earnings-iv-scanner/1.0', 'User-Agent jest obowiązkowy');
  const body = oauth.body as {
    grant_type: string;
    refresh_token: string;
    client_secret: string;
    client_id?: string;
  };
  assert.equal(body.grant_type, 'refresh_token');
  assert.equal(body.refresh_token, 'refresh-xyz');
  assert.equal(body.client_secret, 'secret-abc');
  assert.equal(body.client_id, undefined, 'client_id nie jest wymagany');

  // Żądanie do API musi mieć token i User-Agent
  const api = calls.find((c) => c.url.includes('/market-data/by-type'))!;
  assert.equal(api.headers.authorization, 'Bearer jwt-token-1');
  assert.equal(api.headers['user-agent'], 'earnings-iv-scanner/1.0');
  assert.match(api.url, /api\.cert\.tastyworks\.com/, 'sandbox używa domeny cert');
});

test('tastytrade: token jest cache\'owany — wiele żądań to JEDNA wymiana OAuth', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const { calls } = await withFetch(apiRouter(), async () => {
    await adapter.quote('MU');
    await adapter.expirations('MU');
    await adapter.marketMetrics('MU');
    await adapter.quote('MU');
  });

  const oauthCalls = calls.filter((c) => c.url.includes('/oauth/token'));
  assert.equal(oauthCalls.length, 1, 'token wymieniamy raz, nie przy każdym żądaniu');
});

test('tastytrade: token z KV jest używany bez ponownej wymiany (między przebiegami)', async () => {
  const kv = makeKv();
  const env = { STATE: kv } as unknown as Env;
  const fresh = { token: 'jwt-z-kv', expiresAt: Math.floor(Date.now() / 1000) + 600 };
  await kv.put('tasty:access_token', JSON.stringify(fresh));

  const { calls } = await withFetch(apiRouter(), () => new TastytradeAdapter(CREDS, env).quote('MU'));

  assert.equal(calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'ważny token z KV nie wymaga wymiany');
  const api = calls.find((c) => c.url.includes('/market-data/by-type'))!;
  assert.equal(api.headers.authorization, 'Bearer jwt-z-kv');
});

test('tastytrade: wygasły token z KV jest odrzucany i wymieniany', async () => {
  const kv = makeKv();
  const env = { STATE: kv } as unknown as Env;
  const stale = { token: 'jwt-przeterminowany', expiresAt: Math.floor(Date.now() / 1000) - 10 };
  await kv.put('tasty:access_token', JSON.stringify(stale));

  const { calls } = await withFetch(apiRouter(), () => new TastytradeAdapter(CREDS, env).quote('MU'));

  assert.equal(calls.filter((c) => c.url.includes('/oauth/token')).length, 1, 'wygasły token trzeba wymienić');
  const api = calls.find((c) => c.url.includes('/market-data/by-type'))!;
  assert.equal(api.headers.authorization, 'Bearer jwt-token-1');
});

test('tastytrade: token blisko wygaśnięcia jest odświeżany z marginesem', async () => {
  const kv = makeKv();
  const env = { STATE: kv } as unknown as Env;
  // Ważny jeszcze 30 s — mieści się w marginesie bezpieczeństwa (60 s)
  const almost = { token: 'jwt-zaraz-wygasnie', expiresAt: Math.floor(Date.now() / 1000) + 30 };
  await kv.put('tasty:access_token', JSON.stringify(almost));

  const { calls } = await withFetch(apiRouter(), () => new TastytradeAdapter(CREDS, env).quote('MU'));
  assert.equal(
    calls.filter((c) => c.url.includes('/oauth/token')).length,
    1,
    'token wygasający w trakcie przebiegu musi być odświeżony z wyprzedzeniem',
  );
});

test('tastytrade: nowy token zapisuje się do KV z TTL krótszym niż jego życie', async () => {
  const kv = makeKv();
  const env = { STATE: kv } as unknown as Env;
  await withFetch(apiRouter(), () => new TastytradeAdapter(CREDS, env).quote('MU'));

  assert.ok(kv._store.has('tasty:access_token'), 'token musi trafić do KV, żeby przetrwał między przebiegami');
  const saved = JSON.parse(kv._store.get('tasty:access_token')!) as { token: string; expiresAt: number };
  assert.equal(saved.token, 'jwt-token-1');
  assert.ok(saved.expiresAt > Math.floor(Date.now() / 1000), 'zapisany token musi być jeszcze ważny');
});

test('tastytrade: brak access_token w odpowiedzi => błąd wskazujący na środowisko poświadczeń', async () => {
  await assert.rejects(
    () =>
      withFetch(
        (url) => (url.includes('/oauth/token') ? { status: 200, body: { token_type: 'Bearer' } } : apiRouter()(url)),
        () => new TastytradeAdapter(CREDS, {}).quote('MU'),
      ),
    (err: Error) => {
      assert.match(err.message, /access_token/);
      assert.match(err.message, /sandbox|produkcja/i, 'komunikat musi naprowadzać na rozdział środowisk');
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Metryki IV
// ─────────────────────────────────────────────────────────────────────────────

test('tastytrade: marketMetrics czyta IV rank, percentyl, płynność i IV per wygaśnięcie', async () => {
  const metrics = await withFetch(apiRouter(), () =>
    new TastytradeAdapter(CREDS, {}).marketMetrics('MU'),
  ).then((r) => r.result);

  assert.equal(metrics.ivRank, 34.5);
  assert.equal(metrics.ivPercentile, 41.2);
  assert.equal(metrics.ivIndex, 38.9);
  assert.equal(metrics.liquidityRating, 5);
  assert.equal(metrics.expirationIvs.get('2026-10-16'), 0.32, 'IV per wygaśnięcie w ułamku');
  assert.equal(metrics.expirationIvs.get('2026-11-20'), 0.4);
});

test('tastytrade: IV z pola implied-volatility-index jest przeliczana z procentów', async () => {
  const metrics = await withFetch(
    (url) => {
      // Mock musi obsłużyć OAuth — inaczej adapter nie zdobędzie tokenu.
      if (url.includes('/oauth/token')) return { status: 200, body: TOKEN_OK };
      return {
        status: 200,
        body: {
          data: {
            items: [
              {
                symbol: 'MU',
                'option-expiration-implied-volatilities': [
                  { 'expiration-date': '2026-10-16', 'implied-volatility-index': '32' },
                ],
              },
            ],
          },
        },
      };
    },
    () => new TastytradeAdapter(CREDS, {}).marketMetrics('MU'),
  ).then((r) => r.result);

  assert.equal(metrics.expirationIvs.get('2026-10-16'), 0.32, 'indeks 32 => 0.32, nie 32');
});

test('tastytrade: brak metryk (404) nie wywala analizy', async () => {
  const metrics = await withFetch(
    () => ({ status: 404, body: { error: { code: 'not_found', message: 'brak' } } }),
    () => new TastytradeAdapter(CREDS, {}).marketMetrics('NIEZNANY'),
  ).then((r) => r.result);

  assert.equal(metrics.ivRank, undefined);
  assert.equal(metrics.expirationIvs.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Punkt IV i wybór źródła
// ─────────────────────────────────────────────────────────────────────────────

test('tastytrade: IV pochodzi od dostawcy, gdy jest dostępna (najwyższy priorytet)', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(apiRouter(), () =>
    adapter.buildIvPoint({
      symbol: 'MU',
      spot: 165,
      expiration: '2026-10-16',
      today: '2026-09-24',
      earningsDate: '2026-10-20',
    }),
  ).then((r) => r.result);

  assert.ok(point, 'punkt IV musi powstać');
  assert.equal(point.ivSource, 'provider', 'są realne dane od dostawcy => nie liczymy sami');
  assert.equal(point.atmIv, 0.32);
  assert.equal(point.expiration, '2026-10-16');
  assert.equal(point.daysToEarnings, 4, '4 dni od frontu do wyników');
  assert.ok(point.straddleMid > 0, 'cena straddle z realnych notowań: 7.00 + 6.00');
  assert.ok(Math.abs(point.straddleMid - 13.0) < 0.01, `straddle 7.00+6.00=13.00, jest ${point.straddleMid}`);
});

test('tastytrade: bez IV od dostawcy liczymy z cen opcji (ivSource=computed)', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(
    (url) => {
      if (url.includes('/market-metrics')) {
        // Metryki bez listy IV per wygaśnięcie => musimy policzyć sami
        return {
          status: 200,
          body: { data: { items: [{ symbol: 'MU', 'liquidity-rating': '4' }] } },
        };
      }
      return apiRouter()(url);
    },
    () =>
      adapter.buildIvPoint({
        symbol: 'MU',
        spot: 165,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  ).then((r) => r.result);

  assert.ok(point);
  assert.equal(point.ivSource, 'computed');
  assert.ok(Number.isFinite(point.atmIv) && point.atmIv > 0.05, `IV musi być sensowna, jest ${point.atmIv}`);
});

test('tastytrade: bez notowań opcji schodzimy do IV indeksu i oznaczamy to jako model', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(
    (url) => {
      if (url.includes('/market-metrics')) {
        return {
          status: 200,
          body: { data: { items: [{ symbol: 'MU', 'implied-volatility-index': '42.0', 'liquidity-rating': '3' }] } },
        };
      }
      if (url.includes('equity-option=')) return { status: 200, body: { data: { items: [] } } };
      return apiRouter()(url);
    },
    () =>
      adapter.buildIvPoint({
        symbol: 'MU',
        spot: 165,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  ).then((r) => r.result);

  assert.ok(point);
  assert.equal(point.ivSource, 'model', 'szacunek musi być jawnie oznaczony, nie udawać danych rynkowych');
  assert.ok(Math.abs(point.atmIv - 0.42) < 1e-9, 'indeks 42.0 => 0.42');
  assert.ok(point.impliedMovePct > 0, 'implied move liczony z modelu, gdy brak cen');
});

test('tastytrade: brak jakiegokolwiek źródła IV => brak punktu (nie zero udające IV)', async () => {
  const adapter = new TastytradeAdapter(CREDS, {});
  const point = await withFetch(
    (url) => {
      if (url.includes('/market-metrics')) return { status: 404, body: { error: { code: 'not_found' } } };
      if (url.includes('equity-option=')) return { status: 200, body: { data: { items: [] } } };
      return apiRouter()(url);
    },
    () =>
      adapter.buildIvPoint({
        symbol: 'MU',
        spot: 165,
        expiration: '2026-10-16',
        today: '2026-09-24',
        earningsDate: '2026-10-20',
      }),
  ).then((r) => r.result);

  assert.equal(point, undefined);
});

test('tastytrade: expirations zwraca posortowane, unikalne terminy', async () => {
  const expirations = await withFetch(apiRouter(), () =>
    new TastytradeAdapter(CREDS, {}).expirations('MU'),
  ).then((r) => r.result);

  assert.deepEqual(expirations, ['2026-10-16', '2026-11-20']);
});

test('tastytrade: produkcja używa innej domeny niż sandbox', async () => {
  const adapter = new TastytradeAdapter({ ...CREDS, environment: 'production' }, {});
  const { calls } = await withFetch(apiRouter(), () => adapter.quote('MU'));

  assert.match(calls[0]!.url, /api\.tastyworks\.com/);
  assert.ok(!calls[0]!.url.includes('cert'), 'produkcja nie może trafić na domenę sandbox');
});

// ─────────────────────────────────────────────────────────────────────────────
// Proxy płynności
// ─────────────────────────────────────────────────────────────────────────────

test('liquidityToOpenInterestProxy: mapuje rating na OI zachowawczo', async () => {
  assert.equal(liquidityToOpenInterestProxy(5), 300);
  assert.equal(liquidityToOpenInterestProxy(4), 150);
  assert.equal(liquidityToOpenInterestProxy(3), 80);
  assert.equal(liquidityToOpenInterestProxy(2), 40);
  assert.equal(liquidityToOpenInterestProxy(1), 10);
  assert.equal(liquidityToOpenInterestProxy(undefined), 0, 'brak ratingu => 0, nie zmyślona płynność');

  // Kluczowa własność: rating 5 daje OI powyżej typowego progu (100), ale nie
  // zawyżone — dzięki temu płynny łańcuch nie jest fałszywie ścinany oceną,
  // a cienki nie jest fałszywie promowany.
  assert.ok(liquidityToOpenInterestProxy(5) > 100);
  assert.ok(liquidityToOpenInterestProxy(3) < 100, 'rating 3 nie może udawać płynności powyżej progu');
});
