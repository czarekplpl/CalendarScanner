/**
 * ORKIESTRACJA SKANU
 * ==================
 *
 * Przebieg:
 *  1. Kalendarz wyników z dostawcy (Finnhub) dla okna [dziś, dziś+MAX+30].
 *  2. Przecięcie z uniwersum top 200 (jedno zapytanie do API zamiast 200).
 *  3. Wybór spółek w oknie alertu (domyślnie 25-45 dni do wyników).
 *  4. Priorytetyzacja: bliżej wyników i większa kapitalizacja = wyżej.
 *     Powód: limit API. Głęboka analiza łańcuchów opcji jest droga (kilka żądań
 *     na spółkę), więc analizujemy MAX_DEEP_ANALYSIS najważniejszych.
 *  5. Dla każdej spółki: spot -> terminy wygaśnięć -> wybór nóg -> punkty IV.
 *  6. Ocena (scoring) + IV rank z historii + sugerowana data wejścia.
 *
 * Wynik jest w 100% serializowalny — ten sam obiekt idzie do JSON API, dashboardu
 * i treści alertów.
 */

import { FinnhubAdapter, approxMoveFromSurprises } from '../adapters/finnhub.ts';
import { TradierAdapter, selectCalendarLegs } from '../adapters/tradier.ts';
import { TastytradeAdapter, type TastytradeMetrics } from '../adapters/tastytrade.ts';
import { KvCache, mapLimit } from './http.ts';
import { addDays, daysBetween, todayInNewYork, tradingDaysBetween } from './market.ts';
import { scoreCandidate } from './scoring.ts';
import { computeIvRank, loadIvHistory, recordIvObservation } from './history.ts';
import { UNIVERSE_SNAPSHOT } from '../data/universe-snapshot.ts';
import { ETF_UNIVERSE } from '../data/etf-universe.ts';
import type { CalendarCandidate, EarningsEvent, Env, IvPoint, ScanResult } from '../types.ts';

export const SCANNER_VERSION = '1.0.0';

/** Stopa wolna od ryzyka do modelu BS. Wystarczająco dobra dla terminów < 1 roku. */
const RISK_FREE_RATE = 0.04;

function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readScanConfig(env: Env) {
  return {
    alertMinDays: num(env, 'ALERT_MIN_DAYS', 25),
    alertMaxDays: num(env, 'ALERT_MAX_DAYS', 45),
    maxDeepAnalysis: num(env, 'MAX_DEEP_ANALYSIS', 40),
    minOpenInterest: num(env, 'MIN_OPEN_INTEREST', 100),
    cacheTtlSeconds: num(env, 'CACHE_TTL_SECONDS', 3600),
    includeEtfs: (env.INCLUDE_ETFS ?? 'false') === 'true',
    tradierEnv: (env.TRADIER_ENV === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production',
    tastytradeEnv: (env.TASTYTRADE_ENV === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production',
    earningsProvider: env.EARNINGS_PROVIDER ?? 'finnhub',
    optionsProvider: env.OPTIONS_PROVIDER ?? 'tradier',
  };
}

/**
 * Wspólny interfejs dostawcy danych opcyjnych.
 *
 * Dzięki temu skaner nie wie, czy pracuje na Tradierze, czy na tastytrade.
 * Oba adaptery mają identyczne metody, więc podmiana to jedna zmienna
 * środowiskowa (OPTIONS_PROVIDER), a nie zmiana logiki.
 */
export interface OptionsProvider {
  quote(symbol: string): Promise<number | undefined>;
  expirations(symbol: string): Promise<string[]>;
  buildIvPoint(params: {
    symbol: string;
    spot: number;
    expiration: string;
    today: string;
    earningsDate: string;
    metrics?: TastytradeMetrics;
  }): Promise<IvPoint | undefined>;
  /** Metryki zmienności — dostępne tylko u części dostawców (tastytrade). */
  marketMetrics?(symbol: string): Promise<TastytradeMetrics>;
}

/**
 * Tworzy adapter opcji na podstawie konfiguracji.
 * Zwraca undefined, gdy brakuje poświadczeń — wołający raportuje to jako błąd,
 * zamiast wywalać cały skan.
 */
export function createOptionsProvider(
  env: Env,
  cfg: ReturnType<typeof readScanConfig>,
): { provider?: OptionsProvider; error?: string } {
  if (cfg.optionsProvider === 'tastytrade') {
    const clientSecret = env.TASTYTRADE_CLIENT_SECRET;
    const refreshToken = env.TASTYTRADE_REFRESH_TOKEN;
    if (!clientSecret || !refreshToken) {
      return {
        error:
          'Brak TASTYTRADE_CLIENT_SECRET lub TASTYTRADE_REFRESH_TOKEN — nie mogę pobrać danych opcyjnych. ' +
          'Poświadczenia wygenerujesz na my.tastytrade.com -> Manage -> My Profile -> API -> OAuth Applications ' +
          '(Client Secret + Create Grant => refresh token). Ustaw je przez: npx wrangler secret bulk .dev.vars',
      };
    }
    return {
      provider: new TastytradeAdapter(
        {
          clientId: env.TASTYTRADE_CLIENT_ID,
          clientSecret,
          refreshToken,
          environment: cfg.tastytradeEnv,
        },
        env,
      ),
    };
  }

  if (!env.TRADIER_API_KEY) {
    return {
      error:
        'Brak TRADIER_API_KEY — pomijam analizę opcji. Ustaw sekret: npx wrangler secret put TRADIER_API_KEY ' +
        'albo przełącz się na tastytrade: OPTIONS_PROVIDER = "tastytrade" w wrangler.toml',
    };
  }
  return {
    provider: new TradierAdapter(env.TRADIER_API_KEY, {
      environment: cfg.tradierEnv,
      riskFreeRate: RISK_FREE_RATE,
    }),
  };
}

export interface ScanDeps {
  /** Nadpisanie "dziś" (testy) */
  asOf?: string;
  /** Wstrzyknięcie adapterów (testy / inni dostawcy) */
  earningsAdapter?: { listEarnings(from: string, to: string): Promise<EarningsEvent[]> };
  optionsAdapter?: OptionsProvider;
  universe?: UniverseRow[];
}

/** Wiersz uniwersum: spółka z top 200 albo ETF (z flagą isEtf). */
export type UniverseRow = {
  symbol: string;
  name: string;
  sector: string;
  marketCapB: number;
  isEtf?: boolean;
};

/** Buduje uniwersum skanu: top 200 spółek + opcjonalnie płynne ETF-y. */
export function buildUniverse(includeEtfs: boolean): UniverseRow[] {
  if (!includeEtfs) return UNIVERSE_SNAPSHOT;
  // ETF-y wchodzą z flagą isEtf — scoring doda ostrzeżenie, bo ETF nie ma
  // własnych wyników, a kalendarz zwraca dla nich daty dystrybucji.
  return [...UNIVERSE_SNAPSHOT, ...ETF_UNIVERSE];
}

export async function runScan(env: Env, deps: ScanDeps = {}): Promise<ScanResult> {
  const started = Date.now();
  const cfg = readScanConfig(env);
  const asOf = deps.asOf ?? todayInNewYork();
  const universe = deps.universe ?? buildUniverse(cfg.includeEtfs);
  const errors: string[] = [];

  const cache = new KvCache(env.STATE, cfg.cacheTtlSeconds);

  const result: ScanResult = {
    generatedAt: new Date().toISOString(),
    asOf,
    config: {
      alertMinDays: cfg.alertMinDays,
      alertMaxDays: cfg.alertMaxDays,
      optionsProvider: cfg.optionsProvider,
      earningsProvider: cfg.earningsProvider,
      tradierEnv: cfg.tradierEnv,
    },
    counts: {
      universe: universe.length,
      withUpcomingEarnings: 0,
      inAlertWindow: 0,
      analyzed: 0,
      candidates: 0,
      alertsSent: 0,
    },
    candidates: [],
    watchlistOnly: [],
    errors,
    durationMs: 0,
  };

  // ── 1. Kalendarz wyników ───────────────────────────────────────────────────
  if (!deps.earningsAdapter && !env.FINNHUB_API_KEY) {
    errors.push('Brak FINNHUB_API_KEY — nie mogę pobrać kalendarza wyników. Ustaw sekret: npx wrangler secret put FINNHUB_API_KEY');
    result.durationMs = Date.now() - started;
    return result;
  }

  const calendarFrom = asOf;
  const calendarTo = addDays(asOf, cfg.alertMaxDays + 30);

  let calendar: EarningsEvent[] = [];
  try {
    const adapter =
      deps.earningsAdapter ?? new FinnhubAdapter(env.FINNHUB_API_KEY as string);
    // Cache kalendarza na 6 h — cron chodzi 2x dziennie, a kalendarz zmienia się rzadko.
    calendar = await cache.wrap(
      `calendar:${cfg.earningsProvider}:${calendarFrom}:${calendarTo}`,
      () => adapter.listEarnings(calendarFrom, calendarTo),
      6 * 3600,
    );
  } catch (err) {
    errors.push(`Kalendarz wyników: ${err instanceof Error ? err.message : String(err)}`);
    result.durationMs = Date.now() - started;
    return result;
  }

  // ── 2. Przecięcie z uniwersum ──────────────────────────────────────────────
  const universeBySymbol = new Map(universe.map((u) => [u.symbol.toUpperCase(), u]));

  // Jedna spółka może mieć kilka wpisów (np. korekta daty) — bierzemy najbliższy przyszły.
  const upcoming = new Map<string, EarningsEvent>();
  for (const ev of calendar) {
    const symbol = ev.symbol.toUpperCase();
    if (!universeBySymbol.has(symbol)) continue;
    if (ev.date < asOf) continue;
    const existing = upcoming.get(symbol);
    if (!existing || ev.date < existing.date) upcoming.set(symbol, ev);
  }
  result.counts.withUpcomingEarnings = upcoming.size;

  // ── 3. Okno alertu ─────────────────────────────────────────────────────────
  const inWindow: { symbol: string; event: EarningsEvent; daysToEarnings: number; marketCapB: number }[] = [];
  for (const [symbol, event] of upcoming) {
    const daysToEarnings = daysBetween(asOf, event.date);
    if (daysToEarnings >= cfg.alertMinDays && daysToEarnings <= cfg.alertMaxDays) {
      inWindow.push({
        symbol,
        event,
        daysToEarnings,
        marketCapB: universeBySymbol.get(symbol)?.marketCapB ?? 0,
      });
    }
  }
  result.counts.inAlertWindow = inWindow.length;

  // ── 4. Priorytetyzacja i limit głębokiej analizy ───────────────────────────
  inWindow.sort((a, b) => {
    // Najpierw te, którym najbardziej się spieszy (mniej dni do wyników),
    // przy remisie — większa kapitalizacja (lepsza płynność opcji).
    if (a.daysToEarnings !== b.daysToEarnings) return a.daysToEarnings - b.daysToEarnings;
    return b.marketCapB - a.marketCapB;
  });

  const toAnalyze = inWindow.slice(0, cfg.maxDeepAnalysis);
  const skipped = inWindow.slice(cfg.maxDeepAnalysis);
  for (const s of skipped) {
    result.watchlistOnly.push({
      symbol: s.symbol,
      earningsDate: s.event.date,
      daysToEarnings: s.daysToEarnings,
      reason: `poza oknem głębokiej analizy (limit MAX_DEEP_ANALYSIS=${cfg.maxDeepAnalysis}) — zwiększ limit albo zawęź ALERT_MIN_DAYS/MAX_DAYS`,
    });
  }

  if (toAnalyze.length === 0) {
    result.durationMs = Date.now() - started;
    return result;
  }

  // ── 5. Adapter opcji ───────────────────────────────────────────────────────
  let optionsAdapter: OptionsProvider | undefined = deps.optionsAdapter;
  if (!optionsAdapter) {
    const created = createOptionsProvider(env, cfg);
    if (!created.provider) {
      errors.push(created.error ?? 'Nie udało się utworzyć dostawcy danych opcyjnych');
      for (const item of toAnalyze) {
        result.watchlistOnly.push({
          symbol: item.symbol,
          earningsDate: item.event.date,
          daysToEarnings: item.daysToEarnings,
          reason: 'brak działającego dostawcy opcji — analiza niemożliwa',
        });
      }
      result.durationMs = Date.now() - started;
      return result;
    }
    optionsAdapter = created.provider;
  }

  const historyAdapter = env.FINNHUB_API_KEY ? new FinnhubAdapter(env.FINNHUB_API_KEY) : undefined;

  // ── 6. Głęboka analiza ─────────────────────────────────────────────────────
  // Równoległość 3: przy limiterze Tradier (55/min) daje ~3 żądania/s, czyli
  // pełny przebieg dla 40 spółek to ~3-4 minuty. Mieści się w budżecie crona.
  const { results, errors: analysisErrors } = await mapLimit(toAnalyze, 3, async (item) => {
    return analyzeSymbol({
      item,
      universeEntry: universeBySymbol.get(item.symbol),
      optionsAdapter,
      historyAdapter,
      minOpenInterest: cfg.minOpenInterest,
      asOf,
      env,
    });
  });

  errors.push(...analysisErrors);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const item = toAnalyze[i]!;
    if (!r) {
      result.watchlistOnly.push({
        symbol: item.symbol,
        earningsDate: item.event.date,
        daysToEarnings: item.daysToEarnings,
        reason: 'analiza opcji nie zwróciła kandydata (brak łańcucha, brak wygaśnięć w oknie wyników albo brak wyceny)',
      });
      continue;
    }
    result.counts.analyzed++;
    result.candidates.push(r);
  }

  // ── 7. Porządek wyniku ─────────────────────────────────────────────────────
  result.candidates.sort((a, b) => b.score - a.score);
  result.counts.candidates = result.candidates.length;
  result.durationMs = Date.now() - started;
  return result;
}

interface AnalyzeArgs {
  item: { symbol: string; event: EarningsEvent; daysToEarnings: number };
  universeEntry?: UniverseRow;
  optionsAdapter: OptionsProvider;
  historyAdapter?: FinnhubAdapter;
  minOpenInterest: number;
  asOf: string;
  env: Env;
}

/** Analiza jednej spółki: spot -> wygaśnięcia -> nogi -> punkty IV -> ocena. */
async function analyzeSymbol(args: AnalyzeArgs): Promise<CalendarCandidate | undefined> {
  const { item, universeEntry, optionsAdapter, historyAdapter, minOpenInterest, asOf, env } = args;
  const symbol = item.symbol;

  const spot = await optionsAdapter.quote(symbol);
  if (!spot || spot <= 0) return undefined;

  const expirations = await optionsAdapter.expirations(symbol);
  if (expirations.length < 2) return undefined;

  const legCandidates = selectCalendarLegs({
    expirations,
    earningsDate: item.event.date,
    today: asOf,
  });
  if (legCandidates.length === 0) return undefined;

  // Próbujemy kolejne układy nóg — pierwszy może mieć zerowy OI na ATM
  // (np. w sandboxie brak notowań dla części terminów).
  // Metryki zmienności od dostawcy (jeśli je ma). Dla tastytrade zawierają
  // IV rank, percentyl i IV per wygaśnięcie — czyli term structure bez liczenia
  // z cen. Pobieramy RAZ na spółkę, nie per noga.
  let metrics: TastytradeMetrics | undefined;
  if (optionsAdapter.marketMetrics) {
    try {
      metrics = await optionsAdapter.marketMetrics(symbol);
    } catch {
      metrics = undefined; // metryki są opcjonalne — analiza toczy się dalej
    }
  }

  for (const legs of legCandidates) {
    const [front, back] = await Promise.all([
      optionsAdapter.buildIvPoint({
        symbol,
        spot,
        expiration: legs.front,
        today: asOf,
        earningsDate: item.event.date,
        metrics,
      }),
      optionsAdapter.buildIvPoint({
        symbol,
        spot,
        expiration: legs.back,
        today: asOf,
        earningsDate: item.event.date,
        metrics,
      }),
    ]);

    if (!front || !back) continue;
    if (!Number.isFinite(front.atmIv) || !Number.isFinite(back.atmIv)) continue;
    if (front.atmIv <= 0 || back.atmIv <= 0) continue;

    // IV rank — kolejność źródeł:
    //  1. wartość od dostawcy (tastytrade podaje gotowy IV rank) — działa od razu,
    //  2. własna historia z KV — potrzebuje ~60 dni obserwacji.
    // Zapisujemy obserwację ZAWSZE, gdy mamy KV: nawet jeśli dostawca daje rank,
    // własna historia pozwoli później porównać oba źródła i nie zależeć od dostawcy.
    let ivRank: number | undefined = metrics?.ivRank;
    if (env.STATE) {
      const recorded = await recordIvObservation(env, symbol, asOf, front.atmIv);
      if (ivRank === undefined) ivRank = recorded.ivRank;
    }

    // Typowy ruch historyczny — best-effort, nie blokuje analizy.
    let avgHistoricalMovePct: number | undefined;
    if (historyAdapter) {
      try {
        const history = await historyAdapter.earningsHistory(symbol, 8);
        avgHistoricalMovePct = approxMoveFromSurprises(history).avgAbsMovePct;
      } catch {
        /* opcjonalne */
      }
    }

    return scoreCandidate({
      symbol,
      name: universeEntry?.name,
      sector: universeEntry?.sector,
      isEtf: universeEntry?.isEtf,
      spot,
      earnings: item.event,
      front,
      back,
      daysToEarnings: item.daysToEarnings,
      today: asOf,
      ivRank,
      avgHistoricalMovePct,
      minOpenInterest,
    });
  }

  return undefined;
}

/** Liczba dni sesyjnych do wyników — eksport pomocniczy dla alertów i dashboardu. */
export function tradingDaysTo(earningsDate: string, asOf: string): number {
  return tradingDaysBetween(asOf, earningsDate);
}

/** Pierwsza wolna historia IV z KV — używane przy pierwszym uruchomieniu. */
export async function currentIvRank(env: Env, symbol: string, iv: number): Promise<number | undefined> {
  const history = await loadIvHistory(env, symbol);
  return computeIvRank(history, iv);
}
