/**
 * ADAPTER: tastytrade Open API — metryki zmienności i łańcuchy opcji.
 * ===================================================================
 *
 * Adapter jest napisany pod FAKTYCZNY kształt odpowiedzi tego API, potwierdzony
 * empirycznie na koncie produkcyjnym (nie na zgadywaniu z dokumentacji).
 *
 * ── CO DZIAŁA (sprawdzone na żywo) ───────────────────────────────────────────
 *
 * `/market-metrics?symbols=A,B,C` — SERCE TEGO ADAPTERA.
 *   Przyjmuje do 200 symboli w JEDNYM zapytaniu i zwraca dla każdego:
 *     - implied-volatility-index-rank     IV rank (UŁAMEK, 0.25 = 25%!)
 *     - implied-volatility-percentile     percentyl (UŁAMEK)
 *     - implied-volatility-index           IV indeks 30-dniowy (ułamek)
 *     - implied-volatility-30-day          IV 30d w PROCENTACH (67.78 = 67.78%)
 *     - historical-volatility-30/60/90-day HV w PROCENTACH
 *     - iv-hv-30-day-difference            premia IV nad HV (punkty procentowe)
 *     - option-expiration-implied-volatilities[]  IV per wygaśnięcie (UŁAMKI)
 *     - earnings {}                        POTWIERDZONA data wyników + pora dnia
 *     - liquidity-rating, liquidity-value, market-cap, sector, industry, beta
 *   Dzięki temu CAŁE UNIWERSUM (200 spółek) skanujemy JEDNYM zapytaniem.
 *
 * `/option-chains/{symbol}` — drabinka strike'ów i terminy wygaśnięć.
 *   Zwraca instrumenty (strike, typ, wygaśnięcie, symbol OCC), BEZ cen.
 *   Odpowiedź dla jednej spółki to kilka MB, więc pytamy TYLKO o finalistów.
 *
 * ── CZEGO NIE MA (HTTP 403 na tym poziomie uprawnień) ───────────────────────
 *
 * `/market-data/by-type` — notowania i greki. Endpoint `/api-quote-tokens`
 *   zwraca token wyłącznie do WebSocketu DXLink (`level: "demo"`, feed opóźniony),
 *   a próby użycia go w REST kończą się HTTP 400. Dlatego:
 *     - KURS AKCJI pobieramy z zewnątrz (Finnhub — patrz spotProvider w scan.ts),
 *     - CEN OPcji nie mamy, więc ceny ATM straddle nie policzymy,
 *     - implied move liczymy MODELOWO z IV i czasu (0.8 * S * IV * sqrt(T))
 *       i oznaczamy jako 'model' — patrz IvPoint.ivSource i pricingSource.
 *
 * UWAGA O SKALACH — najczęstsze źródło cichych błędów w tym API:
 *   pola z sufiksem `-rank` i `-percentile` oraz tablica per wygaśnięcie są
 *   UŁAMKIEM (0.25 = 25%), natomiast `implied-volatility-30-day` oraz
 *   `historical-volatility-*` są w PROCENTACH (25.0 = 25%).
 *   Wszystko normalizujemy do ułamków, bo takiego formatu używa scoring.
 */

import { fetchJson, HttpError, RateLimiter } from '../core/http.ts';
import { yearsFromDays } from '../core/blackscholes.ts';
import { daysBetween } from '../core/market.ts';
import type { Env, IvPoint } from '../types.ts';

const PROD_BASE = 'https://api.tastyworks.com';
const CERT_BASE = 'https://api.cert.tastyworks.com';

/** User-Agent jest OBOWIĄZKOWY — bez niego każde żądanie zwraca 401. */
const USER_AGENT = 'earnings-iv-scanner/1.0';

const TOKEN_KEY = 'tasty:access_token';
/** Token żyje 15 minut; odświeżamy 60 s wcześniej, żeby nie trafić w wyścig. */
const TOKEN_SAFETY_MARGIN_S = 60;

/** Maksymalna liczba symboli w jednym zapytaniu o metryki (potwierdzone: 200 działa). */
const MAX_SYMBOLS_PER_METRICS_CALL = 200;

/** Straddle ATM ≈ 0.8 * S * IV * sqrt(T) — model, bo nie mamy cen opcji. */
const STRADDLE_FACTOR = 0.7979;

// ─────────────────────────────────────────────────────────────────────────────
// Typy odpowiedzi (nazwy pól dokładnie jak w API)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface ExpirationIv {
  'expiration-date'?: string;
  'implied-volatility'?: string;
  'option-chain-type'?: string;
}

interface EarningsBlock {
  visible?: boolean;
  'expected-report-date'?: string;
  estimated?: boolean;
  'time-of-day'?: string;
  'actual-eps'?: string;
  'consensus-estimate'?: string;
}

interface MarketMetricItem {
  symbol?: string;
  'implied-volatility-index'?: string;
  'implied-volatility-index-rank'?: string;
  'implied-volatility-percentile'?: string;
  'implied-volatility-30-day'?: string;
  'historical-volatility-30-day'?: string;
  'historical-volatility-60-day'?: string;
  'historical-volatility-90-day'?: string;
  'iv-hv-30-day-difference'?: string;
  'liquidity-rating'?: number;
  'liquidity-value'?: string;
  'market-cap'?: number;
  sector?: string;
  industry?: string;
  beta?: string;
  earnings?: EarningsBlock;
  'option-expiration-implied-volatilities'?: ExpirationIv[];
}

interface MarketMetricsResponse {
  data?: { items?: MarketMetricItem[] };
}

/**
 * UWAGA KRYTYCZNA: endpoint /option-chains używa nazw pól z MYŚLNIKAMI
 * (`strike-price`, `option-type`, `expiration-date`), a nie z podkreśleniami.
 * To była realna przyczyna tego, że łańcuch wyglądał na pusty — adapter czytał
 * `strike_price`, dostawał undefined przy każdym instrumencie i zwracał zero
 * wygaśnięć. Nazwy pól w tym API są NIESPÓJNE między endpointami:
 *   /option-chains        -> myślniki  (strike-price)
 *   /market-metrics       -> podkreślenia (strike_price nie występuje, ale
 *                            `implied-volatility-index-rank` ma myślniki,
 *                            a `option-expiration-implied-volatilities` podkreślenia)
 * Dlatego KAŻDE nowe pole trzeba potwierdzić empirycznie, nie zgadywać.
 */
interface EquityOptionItem {
  symbol?: string;
  'strike-price'?: string;
  'option-type'?: string;
  'expiration-date'?: string;
  'days-to-expiration'?: number;
  'expiration-type'?: string;
  'option-chain-type'?: string;
  'root-symbol'?: string;
  'streamer-symbol'?: string;
}

interface ChainResponse {
  data?: { items?: EquityOptionItem[] };
}

function toNumber(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalizuje zmienność do ułamka. API miesza skale między polami:
 *   - `-rank`, `-percentile`, tablica per wygaśnięcie: UŁAMEK (0.25)
 *   - `implied-volatility-30-day`, `historical-volatility-*`: PROCENT (25.0)
 *
 * Wartości poniżej 3 traktujemy jako ułamek, większe jako procent. Progi są
 * bezpieczne: na płynnych spółkach US nie ma IV poniżej 3% ani powyżej 300%,
 * więc nie ma ryzyka błędnej klasyfikacji.
 */
export function normalizeIvToFraction(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 3 ? value : value / 100;
}

/** Zamienia porę dnia z API na nasz format. API używa m.in. 'AMC' i 'BTO'. */
export function normalizeTiming(timeOfDay: string | undefined): 'bmo' | 'amc' | 'unknown' {
  if (!timeOfDay) return 'unknown';
  const t = timeOfDay.trim().toUpperCase();
  if (t === 'AMC' || t === 'AFTER MARKET' || t === 'AFTERMARKET') return 'amc';
  if (t === 'BTO' || t === 'BMO' || t === 'BEFORE MARKET' || t === 'PREMARKET') return 'bmo';
  return 'unknown';
}

export interface TastytradeCredentials {
  clientId?: string;
  clientSecret: string;
  refreshToken: string;
  environment: 'sandbox' | 'production';
}

/** Metryki jednej spółki, znormalizowane do formatu, którego używa scoring. */
export interface SymbolMetrics {
  symbol: string;
  /** IV rank jako UŁAMEK (0.25 = 25%) — tak podaje API, nie przeliczamy. */
  ivRank?: number;
  ivPercentile?: number;
  /** IV indeks 30-dniowy jako ułamek */
  ivIndex?: number;
  iv30?: number;
  hv30?: number;
  hv60?: number;
  hv90?: number;
  /** Premia IV nad HV w punktach procentowych (np. 14.4) */
  ivHvSpread?: number;
  liquidityRating?: number;
  marketCap?: number;
  sector?: string;
  industry?: string;
  beta?: number;
  /** Term structure: IV per data wygaśnięcia, jako ułamki */
  expirationIvs: Map<string, number>;
  /** Dane o wynikach — API podaje POTWIERDZONĄ datę, nie szacowaną */
  earnings?: {
    date: string;
    estimated: boolean;
    timing: 'bmo' | 'amc' | 'unknown';
  };
}

export class TastytradeAdapter {
  private readonly limiter = new RateLimiter(100);
  private readonly base: string;
  private readonly creds: TastytradeCredentials;
  private readonly env: Env;
  private readonly chainCache = new Map<string, EquityOptionItem[]>();
  private readonly metricsCache = new Map<string, SymbolMetrics>();
  private memoryToken?: { token: string; expiresAt: number };

  constructor(creds: TastytradeCredentials, env: Env = {}) {
    this.creds = creds;
    this.env = env;
    this.base = creds.environment === 'production' ? PROD_BASE : CERT_BASE;
  }

  // ── Uwierzytelnianie ───────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.memoryToken && this.memoryToken.expiresAt - TOKEN_SAFETY_MARGIN_S > now) {
      return this.memoryToken.token;
    }
    if (this.env.STATE) {
      try {
        const cached = await this.env.STATE.get<{ token: string; expiresAt: number }>(TOKEN_KEY, 'json');
        if (cached?.token && cached.expiresAt - TOKEN_SAFETY_MARGIN_S > now) {
          this.memoryToken = cached;
          return cached.token;
        }
      } catch {
        /* brak KV to nie błąd — po prostu wymienimy token */
      }
    }

    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.creds.refreshToken,
      client_secret: this.creds.clientSecret,
    };
    if (this.creds.clientId) body.client_id = this.creds.clientId;

    const res = await fetchJson<TokenResponse>(`${this.base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      label: 'tastytrade.oauth',
      retries: 2,
    });

    const token = res.access_token;
    if (!token) {
      throw new Error(
        'tastytrade: odpowiedź OAuth nie zawiera access_token. Najczęstsza przyczyna: client_secret i refresh_token ' +
          'pochodzą z RÓŻNYCH środowisk (sandbox vs produkcja) — poświadczenia nie działają zamiennie.',
      );
    }

    const expiresIn = res.expires_in ?? 900;
    const record = { token, expiresAt: now + expiresIn };
    this.memoryToken = record;
    if (this.env.STATE) {
      try {
        await this.env.STATE.put(TOKEN_KEY, JSON.stringify(record), {
          expirationTtl: Math.max(60, expiresIn - TOKEN_SAFETY_MARGIN_S),
        });
      } catch {
        /* cache jest optymalizacją, nie wymogiem */
      }
    }
    return token;
  }

  private async get<T>(path: string, label: string): Promise<T> {
    const token = await this.accessToken();
    await this.limiter.acquire();
    return fetchJson<T>(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
      label,
      retries: 3,
    });
  }

  // ── Metryki zmienności (serce adaptera) ────────────────────────────────────

  /** Parsuje jeden wpis metryk na znormalizowany format. */
  private parseMetrics(item: MarketMetricItem): SymbolMetrics {
    const expirationIvs = new Map<string, number>();
    for (const e of item['option-expiration-implied-volatilities'] ?? []) {
      const date = e['expiration-date'];
      const iv = normalizeIvToFraction(toNumber(e['implied-volatility']));
      if (date && iv) expirationIvs.set(date, iv);
    }

    const earningsDate = item.earnings?.['expected-report-date'];
    return {
      symbol: (item.symbol ?? '').toUpperCase(),
      // UWAGA: rank i percentyl są ułamkami — NIE dzielimy przez 100.
      ivRank: toNumber(item['implied-volatility-index-rank']),
      ivPercentile: toNumber(item['implied-volatility-percentile']),
      ivIndex: toNumber(item['implied-volatility-index']),
      iv30: normalizeIvToFraction(toNumber(item['implied-volatility-30-day'])),
      hv30: normalizeIvToFraction(toNumber(item['historical-volatility-30-day'])),
      hv60: normalizeIvToFraction(toNumber(item['historical-volatility-60-day'])),
      hv90: normalizeIvToFraction(toNumber(item['historical-volatility-90-day'])),
      ivHvSpread: toNumber(item['iv-hv-30-day-difference']),
      liquidityRating: typeof item['liquidity-rating'] === 'number' ? item['liquidity-rating'] : undefined,
      marketCap: typeof item['market-cap'] === 'number' ? item['market-cap'] : undefined,
      sector: item.sector,
      industry: item.industry,
      beta: toNumber(item.beta),
      expirationIvs,
      earnings: earningsDate
        ? {
            date: earningsDate,
            // `estimated: false` = data POTWIERDZONA przez spółkę. To cenniejsze niż
            // szacunki z innych źródeł, bo takich dat spółka zwykle nie przesuwa.
            estimated: item.earnings?.estimated === true,
            timing: normalizeTiming(item.earnings?.['time-of-day']),
          }
        : undefined,
    };
  }

  /**
   * Metryki dla wielu spółek w JEDNYM zapytaniu (do 200).
   *
   * Najważniejsza optymalizacja w adapterze: całe uniwersum top 200 kosztuje
   * jedno zapytanie HTTP zamiast dwustu. Bez tego skan trwałby kilkanaście minut
   * i zjadał limity API.
   */
  async marketMetricsBatch(symbols: string[]): Promise<Map<string, SymbolMetrics>> {
    const out = new Map<string, SymbolMetrics>();
    if (symbols.length === 0) return out;

    const missing: string[] = [];
    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      const cached = this.metricsCache.get(sym);
      if (cached) out.set(sym, cached);
      else missing.push(sym);
    }
    if (missing.length === 0) return out;

    for (let i = 0; i < missing.length; i += MAX_SYMBOLS_PER_METRICS_CALL) {
      const chunk = missing.slice(i, i + MAX_SYMBOLS_PER_METRICS_CALL);
      let data: MarketMetricsResponse;
      try {
        data = await this.get<MarketMetricsResponse>(
          `/market-metrics?symbols=${encodeURIComponent(chunk.join(','))}`,
          `tastytrade.metrics.batch(${chunk.length})`,
        );
      } catch (err) {
        // Brak metryk dla fragmentu nie może wywalić całego skanu — te spółki
        // po prostu nie trafią do kandydatów, a reszta przejdzie normalnie.
        if (err instanceof HttpError && (err.status === 400 || err.status === 404)) continue;
        throw err;
      }
      for (const item of data.data?.items ?? []) {
        const parsed = this.parseMetrics(item);
        if (parsed.symbol) {
          this.metricsCache.set(parsed.symbol, parsed);
          out.set(parsed.symbol, parsed);
        }
      }
    }
    return out;
  }

  /** Metryki jednej spółki (wygodne opakowanie na batch). */
  async marketMetrics(symbol: string): Promise<SymbolMetrics> {
    const map = await this.marketMetricsBatch([symbol]);
    return map.get(symbol.toUpperCase()) ?? { symbol: symbol.toUpperCase(), expirationIvs: new Map() };
  }

  // ── Interfejs wspólny dla dostawców opcji ─────────────────────────────────

  /**
   * Kurs instrumentu bazowego.
   *
   * To API nie udostępnia notowań na tym poziomie uprawnień (`/market-data`
   * zwraca 403), więc metoda zwraca undefined i skaner pobiera kurs z dostawcy
   * zewnętrznego (Finnhub — patrz spotProvider w core/scan.ts). Zostaje, bo
   * wymaga jej wspólny interfejs dostawcy opcji.
   */
  async quote(): Promise<number | undefined> {
    return undefined;
  }

  /** Pełny łańcuch opcji (definicje instrumentów), cache'owany w pamięci przebiegu. */
  private async chain(symbol: string): Promise<EquityOptionItem[]> {
    const cached = this.chainCache.get(symbol);
    if (cached) return cached;
    let data: ChainResponse;
    try {
      data = await this.get<ChainResponse>(`/option-chains/${encodeURIComponent(symbol)}`, `tastytrade.chain.${symbol}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        this.chainCache.set(symbol, []);
        return [];
      }
      throw err;
    }
    const items = data.data?.items ?? [];
    this.chainCache.set(symbol, items);
    return items;
  }

  /** Dostępne terminy wygaśnięcia (posortowane). */
  async expirations(symbol: string): Promise<string[]> {
    const items = await this.chain(symbol);
    const dates = new Set<string>();
    for (const o of items) if (o['expiration-date']) dates.add(o['expiration-date']);
    return [...dates].sort();
  }

  /**
   * Buduje punkt IV dla jednego wygaśnięcia.
   *
   * Źródła danych:
   *  - IV: tablica `option-expiration-implied-volatilities` z metryk (ułamek);
   *        gdy brak wpisu dla tego terminu — IV indeks 30d jako szacunek ('model').
   *  - implied move: MODELOWO, bo nie mamy cen opcji. Jawnie oznaczone, żeby
   *    w backteście dało się odfiltrować wiersze oparte na modelu.
   *  - open interest: API go nie podaje, więc używamy ratingu płynności jako proxy.
   *    Wpisanie zera ścinęłoby ocenę każdemu kandydatowi jako „brak płynności".
   */
  async buildIvPoint(params: {
    symbol: string;
    spot: number;
    expiration: string;
    today: string;
    earningsDate: string;
    metrics?: SymbolMetrics;
  }): Promise<IvPoint | undefined> {
    const { symbol, spot, expiration, today, earningsDate } = params;
    const dte = daysBetween(today, expiration);
    if (dte <= 0) return undefined;

    const items = await this.chain(symbol);
    const atExpiry = items.filter((o) => o['expiration-date'] === expiration);
    if (atExpiry.length === 0) return undefined;

    const calls = atExpiry.filter((o) => o['option-type'] === 'C');
    const puts = atExpiry.filter((o) => o['option-type'] === 'P');
    if (calls.length === 0 || puts.length === 0) return undefined;

    // Strike ATM = najbliżej kursu. Ceny opcji nie potrzebujemy: IV bierzemy
    // z metryk, a implied move liczymy modelowo z tego samego IV.
    const putStrikes = new Set(
      puts.map((p) => toNumber(p['strike-price'])).filter((k): k is number => k !== undefined),
    );
    const wspolne = calls
      .map((c) => toNumber(c['strike-price']))
      .filter((k): k is number => k !== undefined && putStrikes.has(k));
    if (wspolne.length === 0) return undefined;

    let atmStrike = wspolne[0]!;
    let bestDistance = Math.abs(atmStrike - spot);
    for (const k of wspolne) {
      const d = Math.abs(k - spot);
      // Przy remisie wybieramy strike NIŻSZY — mniejsze ryzyko przypisania
      // na krótkiej nodze, gdy kurs rośnie.
      if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) < 1e-9 && k < atmStrike)) {
        atmStrike = k;
        bestDistance = d;
      }
    }

    const metrics = params.metrics ?? (await this.marketMetrics(symbol));
    const providerIv = metrics.expirationIvs.get(expiration);
    const ivIndex = normalizeIvToFraction(metrics.ivIndex);

    let atmIv: number;
    let ivSource: IvPoint['ivSource'];
    if (providerIv && providerIv > 0) {
      atmIv = providerIv;
      ivSource = 'provider';
    } else if (ivIndex && ivIndex > 0) {
      atmIv = ivIndex;
      ivSource = 'model';
    } else {
      return undefined;
    }

    const straddleMid = STRADDLE_FACTOR * spot * atmIv * Math.sqrt(yearsFromDays(dte));

    return {
      expiration,
      dte,
      daysToEarnings: daysBetween(expiration, earningsDate),
      atmIv,
      ivSource,
      straddleMid,
      impliedMovePct: spot > 0 ? straddleMid / spot : 0,
      atmOpenInterest: liquidityToOpenInterestProxy(metrics.liquidityRating),
      // Spread bid-ask nieznany bez notowań. 1 = brak danych; NIE wpisujemy 0,
      // bo zero znaczyłoby „idealnie ciasny spread" i sztucznie zawyżało ocenę.
      atmSpreadPct: 1,
      strikeCount: wspolne.length,
      pricingSource: 'model-brak-notowan',
    };
  }

  /** Strike ATM dla spółki i wygaśnięcia — do raportu i testów. */
  async atmStrike(symbol: string, spot: number, expiration: string): Promise<number | undefined> {
    const items = await this.chain(symbol);
    const ks = new Set<number>();
    for (const o of items) {
      if (o['expiration-date'] !== expiration) continue;
      const k = toNumber(o['strike-price']);
      if (k !== undefined) ks.add(k);
    }
    let best: number | undefined;
    let bestD = Infinity;
    for (const k of ks) {
      const d = Math.abs(k - spot);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }
}

/**
 * Zamienia rating płynności tastytrade (1-5) na przybliżony open interest.
 *
 * PO CO: scoring ocenia wykonalność struktury po OI ATM, a to API go nie podaje.
 * Bez tej funkcji KAŻDY kandydat dostałby zero punktów za płynność i cięcie oceny
 * jako „problem krytyczny", mimo realnie płynnego łańcucha. Rating dostawcy jest
 * oparty na realnych danych, więc jest uczciwym proxy.
 *
 * Mapowanie jest CELOWO zachowawcze: rating 5 daje wartość tuż powyżej typowego
 * progu (100), a rating 3 już poniżej — lepiej zaniżyć niż pokazać strukturę
 * jako płynniejszą, niż jest.
 */
export function liquidityToOpenInterestProxy(rating: number | undefined): number {
  if (rating === undefined || !Number.isFinite(rating)) return 0;
  if (rating >= 5) return 300;
  if (rating >= 4) return 150;
  if (rating >= 3) return 80;
  if (rating >= 2) return 40;
  return 10;
}
