/**
 * ADAPTER: tastytrade Open API — łańcuchy opcji i metryki zmienności.
 *
 * DLACZEGO TASTYTRADE, A NIE INNY DOSTAWCA:
 * Endpoint /market-metrics zwraca gotowe pola, których nie ma darmowy Tradier:
 *   - implied-volatility-rank       (IV rank — bez czekania na własną historię!)
 *   - implied-volatility-percentile
 *   - option-expiration-implied-volatilities  (IV per wygaśnięcie — term structure
 *     wprost z API, bez liczenia z cen)
 *   - liquidity-rating / liquidity-rank
 * Efekt praktyczny: IV rank działa OD PIERWSZEGO URUCHOMIENIA. W wariancie
 * tradierowym trzeba było zbierać własną historię IV przez ~60 dni.
 *
 * UWIERZYTELNIANIE (potwierdzone w dokumentacji):
 *   - OAuth2: POST /oauth/token z grant_type=refresh_token, refresh_token,
 *     client_secret. client_id opcjonalny (serwer wywnioskuje z refresh tokenu).
 *   - access_token to JWT ważny 15 MINUT. Odświeżanie NIE rotuje refresh tokenu.
 *   - KAŻDE żądanie musi mieć nagłówek User-Agent w formacie produkt/wersja,
 *     inaczej 401. To najczęstsza przyczyna "nie działa".
 *   - Sandbox i produkcja mają OSOBNE poświadczenia:
 *       sandbox:    https://api.cert.tastyworks.com
 *       produkcja:  https://api.tastyworks.com
 *
 * JAK ZDOBYĆ POŚWIADOMENIA (do udokumentowania użytkownikowi):
 *   1. my.tastytrade.com -> Manage -> My Profile -> API -> OAuth Applications
 *      -> + New OAuth client (zakresy: read; ewentualnie trade)
 *      => Client ID i Client Secret (secret pokazywany JEDEN raz!)
 *   2. Przy aplikacji: Manage -> Create Grant => refresh token (nie wygasa)
 *   3. Uwaga: zakresy read/trade wymagają włączonego 2FA na koncie.
 */

import { fetchJson, HttpError, RateLimiter } from '../core/http.ts';
import { atmIvFromQuotes, yearsFromDays } from '../core/blackscholes.ts';
import { daysBetween } from '../core/market.ts';
import type { Env, IvPoint } from '../types.ts';

const PROD_BASE = 'https://api.tastyworks.com';
const CERT_BASE = 'https://api.cert.tastyworks.com';

/**
 * User-Agent jest OBOWIĄZKOWY — bez niego API zwraca 401. Format: produkt/wersja.
 * Wartość nie ma znaczenia merytorycznego, liczy się format.
 */
const USER_AGENT = 'earnings-iv-scanner/1.0';

/** Klucz w KV na access token. */
const TOKEN_KEY = 'tasty:access_token';
/** Margines przed wygaśnięciem: odświeżamy 60 s wcześniej, żeby nie trafić w wyścig. */
const TOKEN_SAFETY_MARGIN_S = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Typy odpowiedzi (wg OpenAPI dostawcy)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface EquityOptionItem {
  symbol?: string;
  strike_price?: string;
  option_type?: string; // 'C' | 'P'
  expiration_date?: string;
  days_to_expiration?: number;
  root_symbol?: string;
  'instrument-type'?: string;
}

interface ChainResponse {
  data?: { items?: EquityOptionItem[] };
}

interface MarketDataItem {
  symbol?: string;
  bid?: string;
  ask?: string;
  last?: string;
  mid?: string;
  mark?: string;
  close?: string;
  prevClose?: string;
  volume?: string;
}

interface MarketDataResponse {
  data?: { items?: MarketDataItem[] };
}

interface ExpirationIv {
  'expiration-date'?: string;
  'implied-volatility'?: string;
  'implied-volatility-index'?: string;
}

interface MarketMetricItem {
  symbol?: string;
  'implied-volatility-index'?: string;
  'implied-volatility-rank'?: string;
  'implied-volatility-percentile'?: string;
  'liquidity-rating'?: string;
  'liquidity-rank'?: string;
  'option-expiration-implied-volatilities'?: ExpirationIv[];
}

interface MarketMetricsResponse {
  data?: { items?: MarketMetricItem[] };
}

function toNumber(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Cena środkowa z bid/ask; gdy brak rynku — mid/mark/last/close. */
function midFromQuote(q: MarketDataItem): { mid: number; spreadPct: number } {
  const bid = toNumber(q.bid) ?? 0;
  const ask = toNumber(q.ask) ?? 0;
  if (bid > 0 && ask > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    return { mid, spreadPct: mid > 0 ? (ask - bid) / mid : 1 };
  }
  const fallback = toNumber(q.mid) ?? toNumber(q.mark) ?? toNumber(q.last) ?? toNumber(q.close) ?? 0;
  return { mid: fallback, spreadPct: 1 };
}

export interface TastytradeCredentials {
  clientId?: string;
  clientSecret: string;
  refreshToken: string;
  environment: 'sandbox' | 'production';
}

export interface TastytradeMetrics {
  ivRank?: number;
  ivPercentile?: number;
  ivIndex?: number;
  liquidityRating?: number;
  /** IV per data wygaśnięcia — term structure wprost z API */
  expirationIvs: Map<string, number>;
}

export class TastytradeAdapter {
  private readonly limiter = new RateLimiter(100);
  private readonly base: string;
  private readonly creds: TastytradeCredentials;
  private readonly env: Env;
  /** Cache łańcucha w pamięci przebiegu — łańcuch jest duży, a pytamy o niego raz. */
  private readonly chainCache = new Map<string, EquityOptionItem[]>();
  private readonly metricsCache = new Map<string, TastytradeMetrics>();
  /** Token w pamięci izoluje nas od KV, gdy KV nie jest podpięte. */
  private memoryToken?: { token: string; expiresAt: number };

  constructor(creds: TastytradeCredentials, env: Env = {}) {
    this.creds = creds;
    this.env = env;
    this.base = creds.environment === 'production' ? PROD_BASE : CERT_BASE;
  }

  // ── Uwierzytelnianie ───────────────────────────────────────────────────────

  /**
   * Zwraca ważny access token. Kolejność: pamięć -> KV -> OAuth.
   * Cache jest konieczny: token żyje 15 minut, a przebieg skanu trwa kilka minut
   * i wykonuje dziesiątki żądań. Bez cache robilibyśmy setki wymian tokenu.
   */
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
        /* brak KV nie jest błędem — po prostu wymienimy token */
      }
    }

    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.creds.refreshToken,
      client_secret: this.creds.clientSecret,
    };
    // client_id jest opcjonalny, ale jeśli go mamy, musi się zgadzać z grantem.
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
        'tastytrade: odpowiedź OAuth nie zawiera access_token. Sprawdź, czy client_secret i refresh_token pochodzą z TEGO SAMEGO środowiska (sandbox vs produkcja) — poświadczenia nie działają zamiennie.',
      );
    }

    const expiresIn = res.expires_in ?? 900; // wg dokumentacji 15 minut
    const record = { token, expiresAt: now + expiresIn };
    this.memoryToken = record;

    if (this.env.STATE) {
      try {
        // TTL krótszy niż życie tokenu — nie trzymamy wygasłych śmieci.
        await this.env.STATE.put(TOKEN_KEY, JSON.stringify(record), {
          expirationTtl: Math.max(60, expiresIn - TOKEN_SAFETY_MARGIN_S),
        });
      } catch {
        /* cache tokenu jest optymalizacją, nie wymogiem */
      }
    }

    return token;
  }

  private async get<T>(path: string, label: string): Promise<T> {
    const token = await this.accessToken();
    await this.limiter.acquire();
    return fetchJson<T>(`${this.base}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      label,
      retries: 3,
    });
  }

  // ── Metryki zmienności (IV rank wprost z API) ──────────────────────────────

  /**
   * Metryki rynkowe: IV rank, percentyl, rating płynności i IV per wygaśnięcie.
   * To najcenniejsza część tego adaptera — zastępuje własną historię IV.
   */
  async marketMetrics(symbol: string): Promise<TastytradeMetrics> {
    const cached = this.metricsCache.get(symbol);
    if (cached) return cached;

    const empty: TastytradeMetrics = { expirationIvs: new Map() };
    let data: MarketMetricsResponse;
    try {
      data = await this.get<MarketMetricsResponse>(
        `/market-metrics?symbols=${encodeURIComponent(symbol)}`,
        `tastytrade.metrics.${symbol}`,
      );
    } catch (err) {
      // Metryki są opcjonalne — brak nie może wywalić analizy spółki.
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        this.metricsCache.set(symbol, empty);
        return empty;
      }
      throw err;
    }

    const item = data.data?.items?.[0];
    if (!item) {
      this.metricsCache.set(symbol, empty);
      return empty;
    }

    const expirationIvs = new Map<string, number>();
    for (const e of item['option-expiration-implied-volatilities'] ?? []) {
      const date = e['expiration-date'];
      // Pole 'implied-volatility' jest w ułamku; 'implied-volatility-index'
      // w punktach procentowych. Preferujemy ułamek, przeliczamy gdy go brak.
      const iv = toNumber(e['implied-volatility']);
      const ivIndex = toNumber(e['implied-volatility-index']);
      if (date && iv && iv > 0) expirationIvs.set(date, iv);
      else if (date && ivIndex && ivIndex > 0) expirationIvs.set(date, ivIndex / 100);
    }

    const metrics: TastytradeMetrics = {
      ivRank: toNumber(item['implied-volatility-rank']),
      ivPercentile: toNumber(item['implied-volatility-percentile']),
      ivIndex: toNumber(item['implied-volatility-index']),
      liquidityRating: toNumber(item['liquidity-rating']),
      expirationIvs,
    };
    this.metricsCache.set(symbol, metrics);
    return metrics;
  }

  // ── Interfejs wspólny dla dostawców opcji ─────────────────────────────────

  /** Cena instrumentu bazowego. */
  async quote(symbol: string): Promise<number | undefined> {
    const data = await this.get<MarketDataResponse>(
      `/market-data/by-type?equity=${encodeURIComponent(symbol)}`,
      `tastytrade.quote.${symbol}`,
    );
    const q = data.data?.items?.[0];
    if (!q) return undefined;
    return toNumber(q.last) ?? toNumber(q.mid) ?? toNumber(q.mark) ?? toNumber(q.close) ?? toNumber(q.prevClose);
  }

  /** Pełny łańcuch opcji (definicje instrumentów) — cache'owany w pamięci przebiegu. */
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

  /** Lista dostępnych terminów wygaśnięcia (posortowana). */
  async expirations(symbol: string): Promise<string[]> {
    const items = await this.chain(symbol);
    const dates = new Set<string>();
    for (const o of items) {
      if (o.expiration_date) dates.add(o.expiration_date);
    }
    return [...dates].sort();
  }

  /** Buduje OCC-owy symbol opcji w formacie wymaganym przez tastytrade. */
  private occSymbol(symbol: string, expiration: string, type: 'C' | 'P', strike: number): string {
    const [y, m, d] = expiration.split('-');
    // Format OCC: ROOT + YYMMDD + C/P + 8 cyfr strike (w tysięcznych częściach centa)
    const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
    return `${symbol}${y!.slice(2)}${m}${d}${type}${strikePart}`;
  }

  /**
   * Buduje punkt IV dla jednego wygaśnięcia.
   *
   * Kolejność źródeł IV (od najlepszego):
   *   1. IV per wygaśnięcie z /market-metrics (dostawca, realne dane) — 'provider'
   *   2. IV policzona z cen ATM call/put (nasz solver) — 'computed'
   *   3. IV z modelu, gdy brak notowań opcji — 'model' (oznaczone jako szacunek)
   */
  async buildIvPoint(params: {
    symbol: string;
    spot: number;
    expiration: string;
    today: string;
    earningsDate: string;
    metrics?: TastytradeMetrics;
  }): Promise<IvPoint | undefined> {
    const { symbol, spot, expiration, today, earningsDate } = params;
    const dte = daysBetween(today, expiration);
    if (dte <= 0) return undefined;

    const items = await this.chain(symbol);
    const atExpiry = items.filter((o) => o.expiration_date === expiration);
    if (atExpiry.length === 0) return undefined;

    const calls = atExpiry.filter((o) => o.option_type === 'C');
    const puts = atExpiry.filter((o) => o.option_type === 'P');
    if (calls.length === 0 || puts.length === 0) return undefined;

    // Strike ATM = najbliżej spot; przy remisie wygrywa ten, który ma oba typy.
    const putsByStrike = new Map<number, EquityOptionItem>();
    for (const p of puts) {
      const k = toNumber(p.strike_price);
      if (k !== undefined) putsByStrike.set(k, p);
    }

    let best: { strike: number; call: EquityOptionItem; put: EquityOptionItem; distance: number } | undefined;
    for (const c of calls) {
      const strike = toNumber(c.strike_price);
      if (strike === undefined) continue;
      const put = putsByStrike.get(strike);
      if (!put) continue;
      const distance = Math.abs(strike - spot);
      if (!best || distance < best.distance) best = { strike, call: c, put, distance };
    }
    if (!best) return undefined;

    const metrics = params.metrics ?? (await this.marketMetrics(symbol));

    // Notowania ATM call/put — potrzebne do ceny straddle (implied move).
    const callSym = best.call.symbol ?? this.occSymbol(symbol, expiration, 'C', best.strike);
    const putSym = best.put.symbol ?? this.occSymbol(symbol, expiration, 'P', best.strike);

    let straddleMid = 0;
    let atmSpreadPct = 1;
    let quotesAvailable = false;
    try {
      const quoteData = await this.get<MarketDataResponse>(
        `/market-data/by-type?equity-option=${encodeURIComponent(`${callSym},${putSym}`)}`,
        `tastytrade.optquotes.${symbol}.${expiration}`,
      );
      const bySymbol = new Map<string, MarketDataItem>();
      for (const q of quoteData.data?.items ?? []) {
        if (q.symbol) bySymbol.set(q.symbol, q);
      }
      const cq = bySymbol.get(callSym);
      const pq = bySymbol.get(putSym);
      if (cq && pq) {
        const cm = midFromQuote(cq);
        const pm = midFromQuote(pq);
        if (cm.mid > 0 && pm.mid > 0) {
          straddleMid = cm.mid + pm.mid;
          atmSpreadPct = Math.max(cm.spreadPct, pm.spreadPct);
          quotesAvailable = true;
        }
      }
    } catch {
      /* brak notowań opcji nie przekreśla punktu — użyjemy IV od dostawcy */
    }

    // ── Wybór źródła IV ──────────────────────────────────────────────────────
    const providerIv = metrics.expirationIvs.get(expiration);
    let atmIv: number;
    let ivSource: IvPoint['ivSource'];

    if (providerIv && providerIv > 0) {
      atmIv = providerIv;
      ivSource = 'provider';
    } else if (quotesAvailable) {
      const computed = atmIvFromQuotes({
        spot,
        strike: best.strike,
        daysToExpiry: dte,
        callMid: straddleMid / 2,
        putMid: straddleMid / 2,
        rate: 0.04,
      });
      if (!computed.reliable) return undefined; // artefakt numeryczny — patrz blackscholes.ts
      atmIv = computed.iv;
      ivSource = 'computed';
    } else if (metrics.ivIndex && metrics.ivIndex > 0) {
      // Ostatnia deska ratunku: IV indeks spółki. Wyraźnie oznaczamy jako szacunek,
      // bo to nie jest IV tego konkretnego wygaśnięcia.
      atmIv = metrics.ivIndex > 3 ? metrics.ivIndex / 100 : metrics.ivIndex;
      ivSource = 'model';
    } else {
      return undefined;
    }

    // Implied move: z realnej ceny straddle, a gdy jej brak — z modelu BS
    // (cena ATM straddle ≈ 0.8 * S * IV * sqrt(T)).
    const impliedMovePct =
      quotesAvailable && straddleMid > 0
        ? straddleMid / spot
        : 0.7979 * atmIv * Math.sqrt(yearsFromDays(dte));

    // Głębokość rynku: liczba strike'ów z oboma typami opcji na tym wygaśnięciu.
    const strikeCount = calls.filter((c) => {
      const k = toNumber(c.strike_price);
      return k !== undefined && putsByStrike.has(k);
    }).length;

    return {
      expiration,
      dte,
      daysToEarnings: daysBetween(expiration, earningsDate),
      atmIv,
      ivSource,
      straddleMid,
      impliedMovePct,
      // OI nie jest dostępny w tym API — zamiast zera (które udawałoby brak
      // płynności i ścinało ocenę) używamy ratingu płynności dostawcy jako proxy.
      atmOpenInterest: liquidityToOpenInterestProxy(metrics.liquidityRating),
      atmSpreadPct,
      strikeCount,
    };
  }
}

/**
 * Zamienia rating płynności tastytrade (zwykle 1-5) na przybliżony open interest.
 *
 * PO CO: nasz scoring ocenia wykonalność struktury po OI ATM. To API nie podaje
 * OI, więc bez tej funkcji każdy kandydat dostałby zero punktów za płynność
 * (i cięcie oceny jako "problem krytyczny"), mimo realnie płynnego łańcucha.
 * Rating dostawcy jest oparty na realnych danych, więc jest uczciwym proxy.
 *
 * Mapowanie jest CELOWO zachowawcze: rating 5 daje wartość tuż powyżej typowego
 * progu (100), a nie zawyżoną — lepiej zaniżyć niż pokazać strukturę jako
 * płynniejszą, niż jest.
 */
export function liquidityToOpenInterestProxy(rating: number | undefined): number {
  if (rating === undefined || !Number.isFinite(rating)) return 0;
  if (rating >= 5) return 300;
  if (rating >= 4) return 150;
  if (rating >= 3) return 80;
  if (rating >= 2) return 40;
  return 10;
}
