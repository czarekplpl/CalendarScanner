/**
 * Testy wysyłki alertów: formatowanie, deduplikacja i zachowanie przy awariach.
 *
 * Po co: to jedyny fragment, którego błąd jest cichy i kosztowny —
 *   - zła deduplikacja => kanał zasypany powtórkami (albo alert nigdy nie wysłany),
 *   - brak zapisu rejestru => ten sam alert leci 2x dziennie w nieskończoność,
 *   - połknięty błąd wysyłki => myślisz, że masz powiadomienia, a nie masz.
 *
 * Testy używają fałszywego KV i przechwyconego fetch, więc nie dotykają sieci.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchAlerts, formatAlertHtml, alertSubject, formatDigest } from '../src/alerts/index.ts';
import { computeIvRankFromObservations } from '../src/core/history.ts';
import type { CalendarCandidate, Env, ScanResult } from '../src/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Atrapa KV — liczy operacje, żeby dało się sprawdzić, ile zapisów wykonano
// ─────────────────────────────────────────────────────────────────────────────

interface FakeKv {
  store: Map<string, string>;
  gets: number;
  puts: number;
}

function makeKv(): FakeKv & KVNamespace {
  const kv: FakeKv = { store: new Map(), gets: 0, puts: 0 };
  const api = {
    async get(key: string, type?: string) {
      kv.gets++;
      const raw = kv.store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      kv.puts++;
      kv.store.set(key, value);
    },
    async delete(key: string) {
      kv.store.delete(key);
    },
    async list() {
      return { keys: [...kv.store.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
  };
  return Object.assign(kv, api) as FakeKv & KVNamespace;
}

/** Kandydat w kształcie, jaki produkuje scoring (używamy realnych pól). */
function candidate(overrides: Partial<CalendarCandidate> = {}): CalendarCandidate {
  return {
    symbol: 'NKE',
    name: 'NIKE, Inc.',
    sector: 'Consumer Discretionary',
    spot: 74.31,
    earnings: { symbol: 'NKE', date: '2026-10-20', timing: 'amc', confirmed: true, epsEstimate: 0.52 },
    daysToEarnings: 26,
    tradingDaysToEarnings: 18,
    earningsInsideBackOnly: true,
    front: {
      expiration: '2026-10-16',
      dte: 22,
      daysToEarnings: 4,
      atmIv: 0.382,
      ivSource: 'computed',
      straddleMid: 3.42,
      impliedMovePct: 0.046,
      atmOpenInterest: 2840,
      atmSpreadPct: 0.024,
      strikeCount: 61,
    },
    back: {
      expiration: '2026-11-20',
      dte: 57,
      daysToEarnings: -31,
      atmIv: 0.421,
      ivSource: 'computed',
      straddleMid: 4.95,
      impliedMovePct: 0.0666,
      atmOpenInterest: 1180,
      atmSpreadPct: 0.031,
      strikeCount: 58,
    },
    termStructureSlope: 0.039,
    termStructureRatio: 0.907,
    ivRank: 22,
    avgHistoricalMovePct: 0.071,
    score: 82,
    grade: 'A',
    components: [
      { key: 'timing', label: 'Umiejscowienie wyników', points: 34, maxPoints: 34, note: 'Strefa docelowa.' },
    ],
    flags: ['STREFA-DOCELOWA', 'KONTANGO'],
    suggestedEntryDate: '2026-10-01',
    warnings: [],
    ...overrides,
  };
}

function scanWith(candidates: CalendarCandidate[]): ScanResult {
  return {
    generatedAt: '2026-09-24T21:10:04.512Z',
    asOf: '2026-09-24',
    config: { alertMinDays: 25, alertMaxDays: 45, optionsProvider: 'tradier', earningsProvider: 'finnhub', tradierEnv: 'sandbox' },
    counts: { universe: 200, withUpcomingEarnings: 37, inAlertWindow: 11, analyzed: 11, candidates: candidates.length, alertsSent: 0 },
    candidates,
    watchlistOnly: [],
    errors: [],
    durationMs: 1000,
  };
}

interface CapturedCall {
  url: string;
  body: unknown;
}

/** Przechwytuje fetch i zwraca listę wywołań; `fail` wymusza błąd dla danego URL-a. */
function withFetch<T>(
  run: () => Promise<T>,
  options: { failUrls?: (url: string) => boolean } = {},
): Promise<{ result: T; calls: CapturedCall[] }> {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (options.failUrls?.(url)) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, id: 1 }), { status: 200 });
  }) as typeof fetch;
  return run()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    ALERT_CHANNELS: 'telegram,email',
    TELEGRAM_BOT_TOKEN: '123:ABC',
    TELEGRAM_CHAT_ID: '-100200300',
    RESEND_API_KEY: 're_test',
    ALERT_EMAIL_TO: 'ja@example.com',
    ALERT_EMAIL_FROM: 'scanner@example.com',
    MAX_ALERTS_PER_RUN: '25',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatowanie
// ─────────────────────────────────────────────────────────────────────────────

test('alertSubject: zawiera ocenę, ticker, datę i T-x', () => {
  assert.equal(alertSubject(candidate()), '[A 82] NKE — wyniki 2026-10-20 (T-26)');
});

test('formatAlertHtml: zawiera wszystkie liczby potrzebne do decyzji', () => {
  const text = formatAlertHtml(candidate());
  assert.match(text, /NKE/);
  assert.match(text, /2026-10-20/);
  assert.match(text, /T-26 dni kalendarzowych \/ T-18 sesji/);
  assert.match(text, /2026-10-16/, 'data frontu');
  assert.match(text, /2026-11-20/, 'data backu');
  assert.match(text, /38\.2%/, 'IV frontu');
  assert.match(text, /42\.1%/, 'IV backu');
  assert.match(text, /\+3\.9 pp/, 'nachylenie term structure ze znakiem');
  assert.match(text, /IV rank: 22%/);
  assert.match(text, /Sugerowane wejście: 2026-10-01/);
  assert.match(text, /STREFA-DOCELOWA/);
});

test('formatAlertHtml: brak historii IV jest opisany słownie, nie jako 0%', () => {
  const text = formatAlertHtml(candidate({ ivRank: undefined }));
  assert.match(text, /IV rank: brak historii/);
  assert.ok(!/IV rank: 0%/.test(text), 'brak danych nie może udawać zera');
});

test('formatAlertHtml: ostrzeżenia i niepotwierdzona data są widoczne', () => {
  const text = formatAlertHtml(
    candidate({
      earnings: { symbol: 'NKE', date: '2026-10-20', timing: 'unknown', confirmed: false },
      warnings: ['Data wyników niepotwierdzona — spółka może ją przesunąć.'],
    }),
  );
  assert.match(text, /niepotwierdzona/i);
  assert.match(text, /Uwaga:/);
});

test('formatAlertHtml: informuje, czy wyniki siedzą w krótkiej nodze', () => {
  const inside = formatAlertHtml(candidate({ earningsInsideBackOnly: false }));
  assert.match(inside, /WEWNĄTRZ życia frontu/);
  const outside = formatAlertHtml(candidate({ earningsInsideBackOnly: true }));
  assert.match(outside, /PO wygaśnięciu frontu/);
});

test('formatDigest: podsumowanie radzi sobie z pustą listą i błędami', () => {
  const empty = formatDigest(scanWith([]));
  assert.match(empty, /Brak kandydatów/);

  const withErrors = scanWith([candidate()]);
  withErrors.errors = ['Finnhub: HTTP 401'];
  const digest = formatDigest(withErrors);
  assert.match(digest, /NKE/);
  assert.match(digest, /Błędy:<\/b> 1/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wysyłka i deduplikacja
// ─────────────────────────────────────────────────────────────────────────────

test('dispatchAlerts: wysyła na oba kanały i zapisuje rejestr JEDNYM zapisem KV', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv });

  const { result, calls } = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])));

  assert.equal(result.sent, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(calls.length, 2, 'Telegram + e-mail');
  assert.match(calls[0]!.url, /api\.telegram\.org\/bot123:ABC\/sendMessage/);
  assert.match(calls[1]!.url, /api\.resend\.com\/emails/);
  assert.equal(kv.puts, 1, 'rejestr alertów zapisany DOKŁADNIE raz, nie per alert');

  const registry = JSON.parse(kv.store.get('alerts:sent')!) as Record<string, { channels: string[] }>;
  const key = Object.keys(registry)[0]!;
  assert.match(key, /^NKE\|2026-10-20\|/);
  assert.deepEqual(registry[key]!.channels.sort(), ['email', 'telegram']);
});

test('dispatchAlerts: druga wysyłka tego samego układu jest pomijana (deduplikacja)', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv });
  const scan = scanWith([candidate()]);

  const first = await withFetch(() => dispatchAlerts(env, scan));
  assert.equal(first.result.sent, 1);

  const second = await withFetch(() => dispatchAlerts(env, scan));
  assert.equal(second.result.sent, 0, 'ten sam układ nie może być wysłany drugi raz');
  assert.equal(second.result.skipped, 1);
  assert.equal(second.calls.length, 0, 'żadnego ruchu sieciowego przy powtórce');
});

test('dispatchAlerts: eskalacja przy wyższej ocenie jest wysyłana i oznaczona', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv });

  // Najpierw zwykły alert w oknie T30
  await withFetch(() => dispatchAlerts(env, scanWith([candidate({ score: 66, grade: 'B', daysToEarnings: 30 })])));
  // Potem ten sam cykl wyników, ale ocena > 80 => próg SCORE80
  const escalated = await withFetch(() =>
    dispatchAlerts(env, scanWith([candidate({ score: 85, grade: 'A', daysToEarnings: 28 })])),
  );

  assert.equal(escalated.result.sent, 1, 'eskalacja musi zostać wysłana');
  const telegramBody = escalated.calls.find((c) => c.url.includes('telegram'))!.body as { text: string };
  assert.match(telegramBody.text, /Eskalacja/);
});

test('dispatchAlerts: nowy cykl wyników (inna data) jest alertowany ponownie', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv });

  await withFetch(() => dispatchAlerts(env, scanWith([candidate()])));
  const nextQuarter = await withFetch(() =>
    dispatchAlerts(
      env,
      scanWith([
        candidate({
          daysToEarnings: 27,
          earnings: { symbol: 'NKE', date: '2027-01-20', timing: 'amc', confirmed: true },
        }),
      ]),
    ),
  );
  assert.equal(nextQuarter.result.sent, 1, 'kolejny kwartał to nowy alert');
});

test('dispatchAlerts: awaria Telegrama NIE oznacza alertu jako wysłanego', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv, ALERT_CHANNELS: 'telegram' });

  const failed = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])), {
    failUrls: (url) => url.includes('telegram'),
  });
  assert.equal(failed.result.sent, 0);
  assert.equal(failed.result.errors.length, 1);
  assert.match(failed.result.errors[0]!, /telegram/);
  assert.equal(kv.puts, 0, 'nieudana wysyłka nie może zapisać rejestru');

  // Kolejny przebieg musi ponowić próbę (bo alert nie został oznaczony)
  const retry = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])));
  assert.equal(retry.result.sent, 1, 'po awarii alert musi polecieć ponownie');
});

test('dispatchAlerts: awaria e-maila nie blokuje Telegrama', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv });

  const { result } = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])), {
    failUrls: (url) => url.includes('resend'),
  });
  assert.equal(result.sent, 1, 'Telegram dostarczony => alert uznany za wysłany');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /email/);

  const registry = JSON.parse(kv.store.get('alerts:sent')!) as Record<string, { channels: string[] }>;
  assert.deepEqual(Object.values(registry)[0]!.channels, ['telegram'], 'zapisujemy tylko kanały, które faktycznie przyjęły');
});

test('dispatchAlerts: respektuje MAX_ALERTS_PER_RUN', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv, ALERT_CHANNELS: 'telegram', MAX_ALERTS_PER_RUN: '2' });
  const many = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((symbol) =>
    candidate({ symbol, earnings: { symbol, date: '2026-10-20', timing: 'amc', confirmed: true } }),
  );

  const { result, calls } = await withFetch(() => dispatchAlerts(env, scanWith(many)));
  assert.equal(result.sent, 2, 'bezpiecznik musi zadziałać');
  assert.equal(calls.length, 2);
});

test('dispatchAlerts: brak skonfigurowanych kanałów nic nie robi', async () => {
  const kv = makeKv();
  const env = envWith({ STATE: kv, ALERT_CHANNELS: 'dashboard' });
  const { result, calls } = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])));
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
});

test('dispatchAlerts: brak KV nie wywala wysyłki (tylko brak deduplikacji)', async () => {
  const env = envWith({ STATE: undefined });
  const { result } = await withFetch(() => dispatchAlerts(env, scanWith([candidate()])));
  assert.equal(result.sent, 1, 'alert musi polecieć nawet bez KV');
  assert.deepEqual(result.errors, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// IV rank
// ─────────────────────────────────────────────────────────────────────────────

test('computeIvRankFromObservations: percentyl i wymóg minimum próbek', () => {
  const mk = (n: number, ivs: number[]) => ivs.slice(0, n).map((iv, i) => ({ day: i, iv }));

  assert.equal(
    computeIvRankFromObservations(mk(19, Array.from({ length: 19 }, () => 0.3)), 0.3),
    undefined,
    '19 próbek to za mało',
  );

  const flat = Array.from({ length: 20 }, () => 0.3);
  assert.equal(computeIvRankFromObservations(mk(20, flat), 0.3), 100, 'wartość równa wszystkim = 100%');

  const rising = Array.from({ length: 100 }, (_, i) => 0.1 + i * 0.005);
  const rank = computeIvRankFromObservations(mk(100, rising), 0.3)!;
  assert.ok(rank >= 35 && rank <= 45, `środkowa wartość powinna dać ~40%, dała ${rank}%`);
});
