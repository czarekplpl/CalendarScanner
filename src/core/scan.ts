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

import { FinnhubAdapter } from '../adapters/finnhub.ts';
import { TradierAdapter, selectCalendarLegs } from '../adapters/tradier.ts';
import { TastytradeAdapter, type SymbolMetrics } from '../adapters/tastytrade.ts';
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
    metrics?: SymbolMetrics;
  }): Promise<IvPoint | undefined>;
  /** Metryki zmienności — dostępne tylko u części dostawców (tastytrade). */
  marketMetrics?(symbol: string): Promise<SymbolMetrics>;
  /**
   * Metryki dla WIELU spółek jednym zapytaniem (do 200 u tastytrade).
   * Gdy dostawca to obsługuje, skaner używa tej metody zamiast N osobnych
   * zapytań — to różnica między kilkoma sekundami a kilkunastoma minutami.
   */
  marketMetricsBatch?(symbols: string[]): Promise<Map<string, SymbolMetrics>>;
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
    // Wersja w wyniku: bez niej nie odróżnisz w archiwum wierszy z różnych
    // wersji logiki, a to jest warunek uczciwego backtestu.
    scannerVersion: SCANNER_VERSION,
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

  // ── 1. Dostawca danych opcyjnych ───────────────────────────────────────────
  // Tworzymy go PIERWSZEGO, bo w konfiguracji z tastytrade to on jest głównym
  // źródłem dat wyników (patrz krok 2), a nie tylko dostawcą wycen opcji.
  let optionsAdapter: OptionsProvider | undefined = deps.optionsAdapter;
  if (!optionsAdapter) {
    const created = createOptionsProvider(env, cfg);
    if (!created.provider) {
      errors.push(created.error ?? 'Nie udało się utworzyć dostawcy danych opcyjnych');
      result.durationMs = Date.now() - started;
      return result;
    }
    optionsAdapter = created.provider;
  }

  const universeBySymbol = new Map(universe.map((u) => [u.symbol.toUpperCase(), u]));
  const upcoming = new Map<string, EarningsEvent>();
  const dateSource = new Map<string, 'provider' | 'finnhub'>();

  // ── 2. Metryki zmienności + daty wyników od dostawcy opcji ─────────────────
  // JEDNO zapytanie na całe uniwersum (tastytrade obsługuje do 200 symboli).
  // Metryki niosą datę wyników POTWIERDZONĄ przez spółkę (`estimated: false`),
  // więc są lepszym źródłem niż szacunki — i nie mają limitu liczby wpisów.
  const metricsBySymbol = new Map<string, SymbolMetrics>();
  if (optionsAdapter.marketMetricsBatch) {
    try {
      const batch = await optionsAdapter.marketMetricsBatch(universe.map((u) => u.symbol.toUpperCase()));
      for (const [sym, m] of batch) metricsBySymbol.set(sym, m);
    } catch (err) {
      errors.push(`Metryki zmienności (batch): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [sym, m] of metricsBySymbol) {
    const e = m.earnings;
    if (!e?.date || !universeBySymbol.has(sym) || e.date < asOf) continue;
    const days = daysBetween(asOf, e.date);
    if (days < cfg.alertMinDays || days > cfg.alertMaxDays) continue;
    upcoming.set(sym, { symbol: sym, date: e.date, timing: e.timing, confirmed: !e.estimated });
    dateSource.set(sym, 'provider');
  }

  // ── 3. Finnhub jako UZUPEŁNIENIE ───────────────────────────────────────────
  // WAŻNE OGRANICZENIE DARMOWEGO PLANU: jedno zapytanie zwraca MAKSYMALNIE 1500
  // wpisów, posortowanych rosnąco po dacie. W szczycie sezonu jeden dzień ma ich
  // kilkaset, więc szerokie okno kończy się CICHYM UCIĘCIEM odpowiedzi — i to
  // wypadają z niej wpisy NAJBLIŻSZE, czyli dokładnie te, których szukamy.
  //
  // Dlatego pytamy DZIEŃ PO DNIU w oknie alertu. Koszt to ~20 zapytań na przebieg
  // (a nie 200 — tyle byłoby przy pytaniu per spółka), a zysk to pewność, że nic
  // nie wypadło. Zapytania idą do cache na 12 h, więc cron 2x dziennie płaci raz.
  const providerCovered = upcoming.size > 0;
  const finnhubAvailable = Boolean(deps.earningsAdapter || env.FINNHUB_API_KEY);

  if (!finnhubAvailable) {
    if (!providerCovered) {
      errors.push(
        'Brak FINNHUB_API_KEY i brak dat wyników od dostawcy opcji — nie mam skąd wziąć kalendarza. ' +
          'Ustaw sekret: npx wrangler secret bulk .dev.vars',
      );
    }
  } else if (!providerCovered) {
    // Finnhuba pytamy TYLKO wtedy, gdy dostawca opcji nie dał żadnych dat
    // (np. konfiguracja na Tradierze). Przy tastytrade metryki pokrywają całe
    // uniwersum jednym zapytaniem, więc pytanie dzień po dniu byłoby marnowaniem
    // limitu subrequestów Cloudflare — a ten limit jest twardy (patrz niżej).
    const adapter = deps.earningsAdapter ?? new FinnhubAdapter(env.FINNHUB_API_KEY as string);
    const missing = new Set([...universeBySymbol.keys()].filter((sym) => !upcoming.has(sym)));

    for (let offset = cfg.alertMinDays; offset <= cfg.alertMaxDays && missing.size > 0; offset++) {
      const day = addDays(asOf, offset);
      let events: EarningsEvent[] = [];
      try {
        events = await cache.wrap(`calendar:day:${day}`, () => adapter.listEarnings(day, day), 12 * 3600);
      } catch (err) {
        errors.push(`Kalendarz ${day}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (events.length >= 1500) {
        errors.push(
          `Kalendarz ${day}: odpowiedź osiągnęła limit 1500 wpisów — dane mogą być niekompletne dla tego dnia.`,
        );
      }
      for (const ev of events) {
        const sym = ev.symbol.toUpperCase();
        if (!missing.has(sym)) continue;
        missing.delete(sym);
        upcoming.set(sym, ev);
        dateSource.set(sym, 'finnhub');
      }
    }
  }

  // ── 4. Okno alertu: filtr i priorytetyzacja ────────────────────────────────
  const inWindow: { symbol: string; event: EarningsEvent; daysToEarnings: number; marketCapB: number }[] = [];
  for (const [symbol, event] of upcoming) {
    const daysToEarnings = daysBetween(asOf, event.date);
    if (daysToEarnings < cfg.alertMinDays || daysToEarnings > cfg.alertMaxDays) continue;
    const metrics = metricsBySymbol.get(symbol);
    inWindow.push({
      symbol,
      event,
      daysToEarnings,
      // Kapitalizacja z metryk dostawcy jest dokładniejsza niż ze snapshotu
      // uniwersum, więc używamy jej do sortowania, gdy jest dostępna.
      marketCapB: metrics?.marketCap
        ? metrics.marketCap / 1e9
        : (universeBySymbol.get(symbol)?.marketCapB ?? 0),
    });
  }
  result.counts.withUpcomingEarnings = upcoming.size;
  result.counts.inAlertWindow = inWindow.length;

  inWindow.sort((a, b) => {
    // Najpierw te, którym najbardziej się spieszy (mniej dni do wyników),
    // przy remisie — większa kapitalizacja (zwykle lepsza płynność opcji).
    if (a.daysToEarnings !== b.daysToEarnings) return a.daysToEarnings - b.daysToEarnings;
    return b.marketCapB - a.marketCapB;
  });

  const toAnalyze = inWindow.slice(0, cfg.maxDeepAnalysis);
  for (const s of inWindow.slice(cfg.maxDeepAnalysis)) {
    result.watchlistOnly.push({
      symbol: s.symbol,
      earningsDate: s.event.date,
      daysToEarnings: s.daysToEarnings,
      reason: `poza limitem głębokiej analizy (MAX_DEEP_ANALYSIS=${cfg.maxDeepAnalysis}) — zwiększ limit albo zawęź okno alertu`,
    });
  }

  if (toAnalyze.length === 0) {
    result.durationMs = Date.now() - started;
    return result;
  }

  // ── 5. Kursy akcji ─────────────────────────────────────────────────────────
  // Potrzebne do wyboru strike ATM. Dostawca opcji podaje kurs, gdy potrafi
  // (tradier); gdy nie (tastytrade nie ma notowań na naszym poziomie uprawnień),
  // bierzemy go z Finnhuba. Pytamy TYLKO o finalistów, więc to kilkanaście żądań.
  // Finnhub pełni tu DWIE role: kurs akcji dla finalistów oraz (w innym miejscu)
  // kalendarz wyników. Nazwa zmiennej mówi teraz wprost, do czego służy w tym
  // miejscu — wcześniej „historyAdapter" sugerował historię wyników, której już
  // nie używamy do oceny.
  const spotAndCalendarAdapter = env.FINNHUB_API_KEY ? new FinnhubAdapter(env.FINNHUB_API_KEY) : undefined;

  // ── 5b. Budżet żądań ───────────────────────────────────────────────────────
  // Cloudflare ogranicza liczbę subrequestów na JEDNO wywołanie Workera (osobny,
  // niższy limit na planie darmowym). Skan potrzebuje:
  //   1 (metryki) + 1 na spółkę (kurs) + 2 na spółkę (łańcuchy front/back)
  // czyli ~3 żądania na analizowaną spółkę + stała część.
  //
  // Gdy limit zostanie przekroczony, API zwraca błąd i CZĘŚĆ SPÓŁEK po cichu
  // wypada z analizy — dokładnie to się zdarzyło przy 16 spółkach. Dlatego
  // liczymy budżet Z GÓRY i przycinamy listę, zamiast tracić dane w połowie.
  const SUBREQUEST_LIMIT = 45;
  const FIXED_COST = 3; // metryki + ew. kalendarz + jeden zapas
  // Koszt na spółkę: 1 żądanie o kurs akcji (Finnhub) + 1 zapas na ewentualny
  // łańcuch opcji. Terminy wygaśnięć i IV bierzemy z metryk, które są już
  // pobrane zbiorczo, więc NIE płacimy za nie osobno.
  const PER_SYMBOL = 2;
  const maxAffordable = Math.max(1, Math.floor((SUBREQUEST_LIMIT - FIXED_COST) / PER_SYMBOL));
  if (toAnalyze.length > maxAffordable) {
    const odlozone = toAnalyze.splice(maxAffordable);
    for (const s of odlozone) {
      result.watchlistOnly.push({
        symbol: s.symbol,
        earningsDate: s.event.date,
        daysToEarnings: s.daysToEarnings,
        reason: `poza budżetem żądań Cloudflare (limit ~${SUBREQUEST_LIMIT} subrequestów na wywołanie, ~${PER_SYMBOL} na spółkę) — zwiększ limit planu albo zwęź okno alertu`,
      });
    }
    errors.push(
      `Przycięto analizę do ${maxAffordable} spółek z powodu limitu subrequestów Cloudflare ` +
        `(było ${maxAffordable + odlozone.length}). Pozostałe są na liście obserwacyjnej.`,
    );
  }

  // ── 5c. Prefetch łańcuchów opcji ───────────────────────────────────────────
  // Pobieramy łańcuchy dla WSZYSTKICH analizowanych spółek z góry, równolegle,
  // i zapisujemy w pamięci adaptera (ma cache). Dzięki temu głęboka analiza nie
  // wykonuje już żadnych żądań sieciowych, a równoległość jest wyższa niż 3.
  await mapLimit(toAnalyze, 6, async (item) => {
    try {
      await optionsAdapter.expirations(item.symbol);
    } catch {
      /* brak łańcucha obsłuży analyzeSymbol, zwracając undefined */
    }
  });

  // ── 6. Głęboka analiza ─────────────────────────────────────────────────────
  const { results, errors: analysisErrors } = await mapLimit(toAnalyze, 3, async (item) => {
    return analyzeSymbol({
      item,
      universeEntry: universeBySymbol.get(item.symbol),
      optionsAdapter,
      metrics: metricsBySymbol.get(item.symbol),
      spotProvider: spotAndCalendarAdapter,
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
        reason: 'analiza nie zwróciła kandydata (brak kursu, brak łańcucha, brak wygaśnięć w oknie wyników albo brak wyceny IV)',
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
  /** Metryki zmienności pobrane zbiorczo przed analizą (tastytrade). */
  metrics?: SymbolMetrics;
  /**
   * Dostawca kursu akcji. Osobny od dostawcy opcji, bo tastytrade nie udostępnia
   * notowań na naszym poziomie uprawnień — kurs bierzemy z Finnhuba.
   */
  spotProvider?: { quote(symbol: string): Promise<number | undefined> };
  minOpenInterest: number;
  asOf: string;
  env: Env;
}

/** Analiza jednej spółki: spot -> wygaśnięcia -> nogi -> punkty IV -> ocena. */
async function analyzeSymbol(args: AnalyzeArgs): Promise<CalendarCandidate | undefined> {
  const { item, universeEntry, optionsAdapter, minOpenInterest, asOf, env } = args;
  const symbol = item.symbol;

  // Kurs akcji: najpierw dostawca opcji (tradier go ma), potem Finnhub
  // (tastytrade nie udostępnia notowań). Bez kursu nie wybierzemy strike ATM.
  let spot = await optionsAdapter.quote(symbol);
  if ((!spot || spot <= 0) && args.spotProvider) {
    spot = await args.spotProvider.quote(symbol);
  }
  if (!spot || spot <= 0) return undefined;

  const expirations = await optionsAdapter.expirations(symbol);
  if (expirations.length < 2) return undefined;

  const legCandidates = selectCalendarLegs({
    expirations,
    earningsDate: item.event.date,
    today: asOf,
  });
  if (legCandidates.length === 0) return undefined;

  // Metryki zmienności: użyj tych pobranych zbiorczo, a gdy ich nie ma —
  // dociągnij dla tej jednej spółki (tradier nie ma metryk wcale).
  let metrics = args.metrics;
  if (!metrics && optionsAdapter.marketMetrics) {
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

    // HISTORYCZNY RUCH KURSU — świadomie NIE używamy tu danych z Finnhuba.
    //
    // Finnhub /stock/earnings zwraca `surprisePercent`, czyli niespodziankę na EPS,
    // a NIE reakcję kursu po wynikach. Podstawianie jednego za drugie dawało
    // pozornie precyzyjną ocenę taniości opcjonalności opartą na nieprawdziwych
    // liczbach. Do tego darmowy plan zwraca tylko 4 kwartały — za mało na statystykę.
    //
    // Dopóki nie mamy źródła z historycznymi KURSAMI (IBKR je ma), przekazujemy
    // undefined. Scoring użyje wtedy oceny neutralnej i powie o tym wprost.
    const avgHistoricalMovePct: number | undefined = undefined;

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
