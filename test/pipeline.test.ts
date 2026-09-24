/**
 * TEST INTEGRACYJNY CAŁEGO PRZEPŁYWU (end-to-end, bez sieci)
 * =========================================================
 *
 * Uruchamia PRAWDZIWY handler `scheduled` z src/index.ts i przechodzi całą drogę:
 *
 *   cron -> kalendarz wyników -> przecięcie z uniwersum -> okno alertu
 *        -> wybór nóg -> punkty IV -> scoring -> alert -> rejestr w KV
 *
 * Jedyna rzecz, która jest podmieniona, to warstwa sieciowa (globalny fetch)
 * i KV. Dzięki temu test sprawdza dokładnie ten kod, który pójdzie na produkcję —
 * a nie jego kopię czy atrapę logiki.
 *
 * DLACZEGO TO MA ZNACZENIE: bez kluczy API nie da się odpytać prawdziwych
 * dostawców, więc to jest jedyny sposób, żeby potwierdzić, że cały łańcuch
 * (w tym kształt danych wejściowych) działa po wdrożeniu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.ts';
import { blackScholes } from '../src/core/blackscholes.ts';
import { addDays, todayInNewYork, thirdFriday } from '../src/core/market.ts';
import type { Env } from '../src/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Atrapy
// ─────────────────────────────────────────────────────────────────────────────

type FetchHandler = (url: string) => { status: number; body: unknown };
type Recorded = { url: string; body: unknown };

function installFetch(handler: FetchHandler): { calls: Recorded[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const { status, body: payload } = handler(url);
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

interface FakeKvState {
  store: Map<string, string>;
  puts: number;
  gets: number;
}

function installKv(): { kv: KVNamespace; state: FakeKvState } {
  const state: FakeKvState = { store: new Map(), puts: 0, gets: 0 };
  const kv = {
    async get(key: string, type?: string) {
      state.gets++;
      const raw = state.store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      state.puts++;
      state.store.set(key, value);
    },
    async delete(key: string) {
      state.store.delete(key);
    },
    async list() {
      return { keys: [...state.store.keys()].map((n) => ({ name: n })), list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
  return { kv, state };
}

/**
 * Buduje realistyczny łańcuch opcji z CEN LICZONYCH MODELEM.
 * To nie jest atrapa danych: ceny powstają z Black-Scholesa dla zadanej IV,
 * więc solver IV w produkcji ma z czego odtworzyć zmienność. Dzięki temu test
 * sprawdza też, czy nasz odczyt IV daje wartości zgodne z zadanymi.
 */
function buildChain(spot: number, daysToExpiry: number, expiry: string, iv: number): unknown {
  const options: unknown[] = [];
  const t = daysToExpiry / 365;
  const step = Math.max(1, Math.round(spot * 0.01));
  const base = Math.round(spot / step) * step;

  for (let k = -10; k <= 10; k++) {
    const strike = base + k * step;
    if (strike <= 0) continue;
    for (const type of ['call', 'put'] as const) {
      const mid = blackScholes({ type, spot, strike, timeToExpiry: t, vol: iv, rate: 0.04 }).price;
      if (mid <= 0.01) continue;
      const halfSpread = Math.max(0.02, mid * 0.012);
      options.push({
        symbol: `SIM${expiry.replace(/-/g, '').slice(2)}${type === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
        strike,
        option_type: type,
        bid: Number((mid - halfSpread).toFixed(4)),
        ask: Number((mid + halfSpread).toFixed(4)),
        last: Number(mid.toFixed(4)),
        volume: 500,
        open_interest: k === 0 ? 3000 : 800,
        expiration_date: expiry,
        greeks: null, // sandbox nie zwraca greków — dokładnie ten przypadek testujemy
      });
    }
  }
  return { options: { option: options } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenariusz
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spółka z uniwersum, dla której symulujemy wyniki.
 * MU jest w top 200 (miejsce ~11) i ma realnie płynne opcje — dzięki temu test
 * przechodzi dokładnie tę samą ścieżkę, co produkcyjny skan dla dużej spółki.
 * UWAGA: symbol musi istnieć w src/data/universe-snapshot.ts, inaczej zostanie
 * odfiltrowany przez przecięcie kalendarza z uniwersum (co test ma wykrywać).
 */
const SYMBOL = 'MU';
const SPOT = 168.4;

test('end-to-end: cron wykrywa wyniki ~30 dni wcześniej i wysyła alert', async () => {
  const today = todayInNewYork();
  // Wyniki za ~30 dni (w środku okna alertu 25-45 dni)
  const earningsDate = addDays(today, 30);

  // Wygaśnięcia: najbliższe miesięczne wokół wyników + następne (back).
  // Budujemy je tak, jak zrobiłby to prawdziwy dostawca: szereg piątków.
  const expirations: string[] = [];
  for (let i = 7; i <= 120; i++) {
    const day = addDays(today, i);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 5) expirations.push(day);
  }
  // Upewnij się, że jest wygaśnięcie po wynikach z zapasem >= 21 dni
  const backAnchor = addDays(earningsDate, 30);
  if (!expirations.some((e) => e >= backAnchor)) {
    const [y, m] = backAnchor.split('-').map(Number);
    expirations.push(thirdFriday(y!, m!));
    expirations.sort();
  }

  // UWAGA: nie zgadujemy, KTÓRE wygaśnięcie wybierze algorytm — sprawdzamy jego
  // własności strukturalne. Front musi wygasać przed wynikami z sensownym czasem
  // życia, back po wynikach z zapasem. Sama selekcja jest testowana w scoring.test.ts.
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  const candidatesFront = expirations.filter((e) => days(e, earningsDate) >= 1 && days(e, earningsDate) <= 10);
  const candidatesBack = expirations.filter((e) => days(earningsDate, e) >= 21);
  assert.ok(candidatesFront.length > 0, 'musi istnieć wygaśnięcie 1-10 dni przed wynikami');
  assert.ok(candidatesBack.length > 0, 'musi istnieć wygaśnięcie z zapasem >= 21 dni po wynikach');

  // IV frontu NIŻSZA niż backu => dodatnie nachylenie term structure (teza strategii).
  // Ustawiamy różnicę 8 pp, żeby wynik był jednoznaczny niezależnie od wyboru nóg.
  const FRONT_IV = 0.32;
  const BACK_IV = 0.4;
  const ivByExpiry = new Map<string, number>();
  for (const e of expirations) {
    const beforeEarnings = days(e, earningsDate) > 0;
    ivByExpiry.set(e, beforeEarnings ? FRONT_IV : BACK_IV);
  }
  // Wygaśnięcia POMIĘDZY wynikami a backiem mają IV pośrednią (jak na realnej
  // krzywej: premia eventowa schodzi wraz z oddalaniem się od zdarzenia).
  // Warunek `days(e, earningsDate) < 0` jest istotny — bez niego nadpisalibyśmy
  // także wygaśnięcia PRZED wynikami i zabili różnicę, którą test chce zmierzyć.
  for (const e of expirations) {
    if (days(e, earningsDate) < 0 && days(earningsDate, e) < 21) ivByExpiry.set(e, 0.38);
  }

  const { calls, restore } = installFetch((url) => {
    // ── Finnhub ──
    if (url.includes('finnhub.io/api/v1/calendar/earnings')) {
      return {
        status: 200,
        body: {
          earningsCalendar: [
            // Spółka z uniwersum, w oknie alertu
            { symbol: SYMBOL, date: earningsDate, hour: 'amc', epsEstimate: 0.52 },
            // Spółka z uniwersum, ale poza oknem (za 5 dni) — nie może trafić do kandydatów
            { symbol: 'AAPL', date: addDays(today, 5), hour: 'amc', epsEstimate: 1.4 },
            // Spółka spoza uniwersum — musi zostać odfiltrowana
            { symbol: 'ZZZZ', date: earningsDate, hour: 'bmo', epsEstimate: 0.1 },
          ],
        },
      };
    }
    if (url.includes('finnhub.io/api/v1/stock/earnings')) {
      return {
        status: 200,
        body: [
          { symbol: SYMBOL, period: '2026-06-30', actual: 0.6, estimate: 0.52, surprisePercent: 15.4 },
          { symbol: SYMBOL, period: '2026-03-31', actual: 0.55, estimate: 0.5, surprisePercent: 10.0 },
          { symbol: SYMBOL, period: '2025-12-31', actual: 0.5, estimate: 0.46, surprisePercent: 8.7 },
          { symbol: SYMBOL, period: '2025-09-30', actual: 0.48, estimate: 0.45, surprisePercent: 6.7 },
        ],
      };
    }

    // ── Tradier ──
    if (url.includes('/v1/markets/quotes')) {
      return { status: 200, body: { quotes: { quote: { symbol: SYMBOL, last: SPOT, close: SPOT } } } };
    }
    if (url.includes('/v1/markets/options/expirations')) {
      return { status: 200, body: { expirations: { date: expirations } } };
    }
    if (url.includes('/v1/markets/options/chains')) {
      const expiry = new URL(url).searchParams.get('expiration')!;
      const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      return { status: 200, body: buildChain(SPOT, dte, expiry, ivByExpiry.get(expiry) ?? 0.36) };
    }

    // ── Kanały alertów ──
    if (url.includes('api.telegram.org')) return { status: 200, body: { ok: true, result: { message_id: 1 } } };
    if (url.includes('api.resend.com')) return { status: 200, body: { id: 'email-1' } };

    throw new Error(`Nieoczekiwany URL w teście: ${url}`);
  });

  const { kv, state } = installKv();
  const env = {
    STATE: kv,
    FINNHUB_API_KEY: 'test-finnhub',
    TRADIER_API_KEY: 'test-tradier',
    TRADIER_ENV: 'sandbox',
    EARNINGS_PROVIDER: 'finnhub',
    OPTIONS_PROVIDER: 'tradier',
    ALERT_MIN_DAYS: '25',
    ALERT_MAX_DAYS: '45',
    MAX_DEEP_ANALYSIS: '10',
    MIN_OPEN_INTEREST: '100',
    ALERT_CHANNELS: 'telegram,email',
    TELEGRAM_BOT_TOKEN: '123:TEST',
    TELEGRAM_CHAT_ID: '-100',
    RESEND_API_KEY: 're_test',
    ALERT_EMAIL_TO: 'ja@example.com',
    ALERT_EMAIL_FROM: 'scanner@example.com',
    REQUIRE_API_KEY: 'true',
    API_KEY: 'tajny-klucz',
    CACHE_TTL_SECONDS: '3600',
    MAX_ALERTS_PER_RUN: '25',
  } as unknown as Env;

  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;

  try {
    await worker.scheduled!(
      { cron: '10 21 * * 1-5', scheduledTime: Date.now(), type: 'scheduled', noRetry: () => {} } as unknown as ScheduledController,
      env,
      ctx,
    );
    await Promise.allSettled(waits);
  } finally {
    restore();
  }

  // ── Zapisany skan (to, co trafia do KV i na dashboard) ────────────────────
  const stored = state.store.get('scan:last');
  assert.ok(stored, 'skan musi zostać zapisany do KV dla dashboardu');
  const scan = JSON.parse(stored) as import('../src/types.ts').ScanResult;

  assert.equal(scan.errors.length, 0, `skan nie może zgłaszać błędów: ${scan.errors.join('; ')}`);
  assert.equal(scan.counts.universe, 200, 'uniwersum to 200 spółek');
  assert.equal(scan.counts.withUpcomingEarnings, 2, 'dwie spółki z uniwersum mają wyniki w kalendarzu');
  assert.equal(scan.counts.inAlertWindow, 1, 'tylko NKE jest w oknie 25-45 dni');
  assert.equal(scan.counts.candidates, 1, 'dokładnie jeden kandydat');
  assert.equal(scan.counts.alertsSent, 1, 'alert musi zostać wysłany');

  const c = scan.candidates[0]!;
  assert.equal(c.symbol, SYMBOL);
  assert.equal(c.earnings.date, earningsDate);
  assert.equal(c.earnings.confirmed, true, 'godzina AMC => data potwierdzona');
  assert.equal(c.daysToEarnings, 30);
  // ── Własności strukturalne wybranych nóg ─────────────────────────────────
  assert.ok(c.front!.expiration < earningsDate, 'front musi wygasać PRZED wynikami');
  assert.ok(c.back!.expiration > earningsDate, 'back musi wygasać PO wynikach');
  assert.ok(c.front!.dte >= 7, `front musi mieć co najmniej 7 dni życia, ma ${c.front!.dte}`);
  assert.ok(c.back!.dte > c.front!.dte, 'back musi być dłuższy niż front');
  assert.ok(
    days(c.back!.expiration, earningsDate) <= 0 && days(earningsDate, c.back!.expiration) >= 21,
    'back musi mieć co najmniej 21 dni zapasu po wynikach',
  );

  // ── Dowód, że solver IV czyta PRAWDZIWE ceny z łańcucha ──────────────────
  // Nie zgadujemy, które wygaśnięcie wybierze algorytm (to zależy od dostępnych
  // terminów), ale sprawdzamy, że odczytana IV odpowiada tej, którą włożyliśmy
  // w ceny opcji. To jest właściwy test solvera na realnym kształcie danych.
  const frontInputIv = ivByExpiry.get(c.front!.expiration)!;
  const backInputIv = ivByExpiry.get(c.back!.expiration)!;
  assert.ok(
    Math.abs(c.front!.atmIv - frontInputIv) < 0.02,
    `IV frontu powinna odtworzyć ${(frontInputIv * 100).toFixed(0)}%, jest ${(c.front!.atmIv * 100).toFixed(1)}%`,
  );
  assert.ok(
    Math.abs(c.back!.atmIv - backInputIv) < 0.02,
    `IV backu powinna odtworzyć ${(backInputIv * 100).toFixed(0)}%, jest ${(c.back!.atmIv * 100).toFixed(1)}%`,
  );
  assert.equal(c.front!.ivSource, 'computed', 'sandbox nie daje greków => liczymy sami');
  assert.ok(c.front!.impliedMovePct > 0.01, 'implied move musi być policzony z cen');
  assert.ok(c.front!.atmOpenInterest > 0, 'open interest musi być odczytany z łańcucha');
  assert.ok(c.front!.strikeCount > 5, 'musi być widoczna głębokość łańcucha (liczba strike)');

  // Dodatnie nachylenie term structure => flaga KONTANGO i punkty za tezę strategii
  assert.ok(
    c.termStructureSlope! > 0.05,
    `nachylenie powinno być ~+8 pp, jest ${(c.termStructureSlope! * 100).toFixed(1)} pp`,
  );
  assert.ok(c.flags.includes('KONTANGO'), `brak flagi KONTANGO, flagi: ${c.flags.join(' ')}`);

  // Front 30 dni przed wynikami jest w strefie docelowej (1-10 dni przed)
  assert.ok(c.front!.daysToEarnings >= 1 && c.front!.daysToEarnings <= 10, 'front tuż przed wynikami');
  assert.ok(c.flags.includes('STREFA-DOCELOWA'), `brak STREFA-DOCELOWA, flagi: ${c.flags.join(' ')}`);
  assert.ok(c.score >= 60, `ocena powinna być solidna, jest ${c.score}`);
  assert.equal(c.ivRank, undefined, 'pierwszy przebieg nie ma jeszcze historii IV');

  // ── Alerty ────────────────────────────────────────────────────────────────
  const telegram = calls.filter((x) => x.url.includes('api.telegram.org'));
  const emails = calls.filter((x) => x.url.includes('api.resend.com'));
  assert.equal(telegram.length, 1, 'dokładnie jeden alert na Telegramie');
  assert.equal(emails.length, 1, 'dokładnie jeden e-mail');

  const text = (telegram[0]!.body as { text: string }).text;
  assert.match(text, new RegExp(SYMBOL));
  assert.match(text, /\[A 9\d\]/, 'alert musi nieść ocenę i literę');
  assert.match(text, /IV 32\.0%/, 'alert pokazuje IV frontu');
  assert.match(text, /IV 40\.0%/, 'alert pokazuje IV backu');
  assert.match(text, new RegExp(earningsDate));
  assert.match(text, /T-30 dni/);
  assert.match(text, /STREFA-DOCELOWA/);

  // ── Stan w KV ─────────────────────────────────────────────────────────────
  assert.ok(state.store.has('alerts:sent'), 'rejestr alertów musi zostać zapisany');
  const registry = JSON.parse(state.store.get('alerts:sent')!) as Record<string, unknown>;
  assert.equal(Object.keys(registry).length, 1);
  assert.match(Object.keys(registry)[0]!, new RegExp(`^${SYMBOL}\\|${earningsDate}\\|`));

  const ivKeys = [...state.store.keys()].filter((k) => k.startsWith('ivhist:'));
  assert.deepEqual(ivKeys, [`ivhist:${SYMBOL}`], 'zapisana historia IV tylko dla analizowanej spółki');

  // ── Drugi przebieg: deduplikacja ─────────────────────────────────────────
  const second = installFetch((url) => {
    if (url.includes('calendar/earnings')) {
      return { status: 200, body: { earningsCalendar: [{ symbol: SYMBOL, date: earningsDate, hour: 'amc' }] } };
    }
    if (url.includes('stock/earnings')) return { status: 200, body: [] };
    if (url.includes('/v1/markets/quotes')) return { status: 200, body: { quotes: { quote: { symbol: SYMBOL, last: SPOT } } } };
    if (url.includes('/v1/markets/options/expirations')) return { status: 200, body: { expirations: { date: expirations } } };
    if (url.includes('/v1/markets/options/chains')) {
      const expiry = new URL(url).searchParams.get('expiration')!;
      const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      return { status: 200, body: buildChain(SPOT, dte, expiry, ivByExpiry.get(expiry) ?? 0.36) };
    }
    if (url.includes('api.telegram.org')) return { status: 200, body: { ok: true } };
    if (url.includes('api.resend.com')) return { status: 200, body: { id: 'e2' } };
    throw new Error(`Nieoczekiwany URL: ${url}`);
  });

  try {
    await worker.scheduled!(
      { cron: '10 21 * * 1-5', scheduledTime: Date.now(), type: 'scheduled', noRetry: () => {} } as unknown as ScheduledController,
      env,
      ctx,
    );
    await Promise.allSettled(waits);
  } finally {
    second.restore();
  }

  const alertsSecondRun = second.calls.filter(
    (x) => x.url.includes('api.telegram.org') || x.url.includes('api.resend.com'),
  );
  assert.equal(alertsSecondRun.length, 0, 'drugi przebieg nie może powtórzyć alertu (deduplikacja w KV)');

  // Historia IV rośnie: druga obserwacja tego samego dnia nadpisuje, nie duplikuje
  const hist = JSON.parse(state.store.get(`ivhist:${SYMBOL}`)!) as { o: { day: number; iv: number }[] };
  assert.equal(hist.o.length, 1, 'jedna obserwacja na dzień — kolejny przebieg nadpisuje');
});
