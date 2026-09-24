/**
 * ADAPTER: Tradier — łańcuchy opcji.
 *
 * Endpointy:
 *   GET /v1/markets/quotes?symbols=AAPL
 *   GET /v1/markets/options/expirations?symbol=AAPL&strikes=true
 *   GET /v1/markets/options/chains?symbol=AAPL&expiration=YYYY-MM-DD&greeks=true
 *
 * WAŻNE (potwierdzone w dokumentacji Tradier):
 *   Greki i IV dostarcza ORATS i są dostępne TYLKO na koncie brokerskim.
 *   W sandboxie (darmowym) tych pól nie ma — więc IV liczymy sami z cen opcji
 *   (patrz core/blackscholes.ts). Kod obsługuje oba przypadki: jeśli dostawca
 *   poda `mid_iv`, użyjemy jego; jeśli nie — policzymy.
 *
 * Limity: sandbox 60 żądań/min na token (nagłówki X-Ratelimit-*).
 * Dokumentacja: https://docs.tradier.com/docs/market-data
 */

import { fetchJson, HttpError, RateLimiter } from '../core/http.ts';
import { atmIvFromQuotes, impliedMoveFromStraddle, yearsFromDays } from '../core/blackscholes.ts';
import { daysBetween, thirdFriday } from '../core/market.ts';
import type { IvPoint } from '../types.ts';

interface TradierQuote {
  symbol?: string;
  last?: number | null;
  close?: number | null;
  prevclose?: number | null;
  bid?: number | null;
  ask?: number | null;
}

interface TradierQuotesResponse {
  quotes?: { quote?: TradierQuote | TradierQuote[] };
}

interface TradierOption {
  symbol?: string;
  strike?: number;
  option_type?: 'call' | 'put' | string;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  close?: number | null;
  volume?: number | null;
  open_interest?: number | null;
  expiration_date?: string;
  greeks?: {
    mid_iv?: number | null;
    smv_vol?: number | null;
    delta?: number | null;
    gamma?: number | null;
    theta?: number | null;
    vega?: number | null;
  } | null;
}

interface TradierChainResponse {
  options?: { option?: TradierOption | TradierOption[] } | null;
}

interface TradierExpirationsResponse {
  expirations?: { date?: string | string[] } | null;
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Cena środkowa z bid/ask; gdy brak rynku — last, potem close. Zwraca też spread w %. */
function midPrice(o: TradierOption): { mid: number; spreadPct: number; fromMarket: boolean } {
  const bid = typeof o.bid === 'number' ? o.bid : 0;
  const ask = typeof o.ask === 'number' ? o.ask : 0;
  if (bid > 0 && ask > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    return { mid, spreadPct: mid > 0 ? (ask - bid) / mid : 1, fromMarket: true };
  }
  const fallback = typeof o.last === 'number' && o.last > 0 ? o.last : typeof o.close === 'number' ? o.close : 0;
  return { mid: fallback, spreadPct: 1, fromMarket: false };
}

export interface TradierEnvOptions {
  /** 'sandbox' = darmowe, dane 15 min opóźnione; 'production' = konto brokerskie */
  environment: 'sandbox' | 'production';
  /** Stopa wolna od ryzyka do modelu (ułamek) */
  riskFreeRate: number;
}

export class TradierAdapter {
  private readonly limiter = new RateLimiter(55); // 60/min z marginesem
  private readonly base: string;
  private readonly chainCache = new Map<string, TradierOption[]>();

  private readonly apiKey: string;
  private readonly opts: TradierEnvOptions;

  constructor(
    apiKey: string,
    opts: TradierEnvOptions = { environment: 'sandbox', riskFreeRate: 0.04 },
  ) {
    this.apiKey = apiKey;
    this.opts = opts;
    this.base =
      opts.environment === 'production' ? 'https://api.tradier.com' : 'https://sandbox.tradier.com';
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
  }

  /** Cena instrumentu bazowego (spot). */
  async quote(symbol: string): Promise<number | undefined> {
    await this.limiter.acquire();
    const data = await fetchJson<TradierQuotesResponse>(
      `${this.base}/v1/markets/quotes?symbols=${encodeURIComponent(symbol)}`,
      { headers: this.headers(), label: `tradier.quote.${symbol}` },
    );
    const q = asArray(data.quotes?.quote)[0];
    if (!q) return undefined;
    // W sandboxie `last` bywa null poza sesją — wtedy bierzemy close.
    const price = [q.last, q.close, q.prevclose].find((v) => typeof v === 'number' && v > 0);
    return typeof price === 'number' ? price : undefined;
  }

  /** Lista dostępnych terminów wygaśnięcia. */
  async expirations(symbol: string): Promise<string[]> {
    await this.limiter.acquire();
    const data = await fetchJson<TradierExpirationsResponse>(
      `${this.base}/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=false&strikes=false`,
      { headers: this.headers(), label: `tradier.expirations.${symbol}` },
    );
    return asArray(data.expirations?.date).filter((d): d is string => typeof d === 'string');
  }

  /** Łańcuch opcji dla jednego wygaśnięcia (z cache w pamięci przebiegu). */
  async chain(symbol: string, expiration: string): Promise<TradierOption[]> {
    const key = `${symbol}:${expiration}`;
    const cached = this.chainCache.get(key);
    if (cached) return cached;

    await this.limiter.acquire();
    const url = `${this.base}/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`;
    let data: TradierChainResponse;
    try {
      data = await fetchJson<TradierChainResponse>(url, {
        headers: this.headers(),
        label: `tradier.chain.${symbol}.${expiration}`,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        // Brak łańcucha dla tego terminu — traktujemy jak pusty, nie przerywamy skanu.
        this.chainCache.set(key, []);
        return [];
      }
      throw err;
    }
    const options = asArray(data.options?.option);
    this.chainCache.set(key, options);
    return options;
  }

  /**
   * Buduje punkt IV dla jednego wygaśnięcia: znajduje strike najbliżej spot,
   * liczy IV ATM (z pary call/put), implied move, OI i spread.
   */
  async buildIvPoint(params: {
    symbol: string;
    spot: number;
    expiration: string;
    today: string;
    earningsDate: string;
    providerIv?: number;
  }): Promise<IvPoint | undefined> {
    const { symbol, spot, expiration, today, earningsDate } = params;
    const options = await this.chain(symbol, expiration);
    if (options.length === 0) return undefined;

    const dte = daysBetween(today, expiration);
    if (dte <= 0) return undefined;

    const calls = options.filter((o) => o.option_type === 'call');
    const puts = options.filter((o) => o.option_type === 'put');
    if (calls.length === 0 || puts.length === 0) return undefined;

    // Strike ATM = najbliżej spot, a przy remisie — ten z większym OI (płynniejszy).
    const putsByStrike = new Map<number, TradierOption>();
    for (const p of puts) if (typeof p.strike === 'number') putsByStrike.set(p.strike, p);

    let best: { strike: number; call: TradierOption; put: TradierOption; distance: number } | undefined;
    for (const c of calls) {
      if (typeof c.strike !== 'number') continue;
      const p = putsByStrike.get(c.strike);
      if (!p) continue;
      const distance = Math.abs(c.strike - spot);
      const oi = (c.open_interest ?? 0) + (p.open_interest ?? 0);
      const bestOi = best ? (best.call.open_interest ?? 0) + (best.put.open_interest ?? 0) : -1;
      if (
        !best ||
        distance < best.distance - 0.001 ||
        (Math.abs(distance - best.distance) < 0.001 && oi > bestOi)
      ) {
        best = { strike: c.strike, call: c, put: p, distance };
      }
    }
    if (!best) return undefined;

    const callMid = midPrice(best.call);
    const putMid = midPrice(best.put);
    if (callMid.mid <= 0 && putMid.mid <= 0) return undefined;

    const computed = atmIvFromQuotes({
      spot,
      strike: best.strike,
      daysToExpiry: dte,
      callMid: callMid.mid,
      putMid: putMid.mid,
      rate: this.opts.riskFreeRate,
    });

    // Priorytet: IV od dostawcy (ORATS na koncie brokerskim), potem własne wyliczenie.
    const providerCallIv = best.call.greeks?.mid_iv ?? best.call.greeks?.smv_vol ?? undefined;
    const providerPutIv = best.put.greeks?.mid_iv ?? best.put.greeks?.smv_vol ?? undefined;
    let atmIv: number;
    let ivSource: IvPoint['ivSource'];
    if (typeof providerCallIv === 'number' && typeof providerPutIv === 'number' && providerCallIv > 0) {
      atmIv = (providerCallIv + providerPutIv) / 2;
      ivSource = 'provider';
    } else if (params.providerIv && params.providerIv > 0) {
      atmIv = params.providerIv;
      ivSource = 'provider';
    } else {
      // Bez IV od dostawcy (sandbox) liczymy sami. Jeśli solver zgłosił brak
      // wiarygodności (cena nie pozwala odczytać zmienności — np. strike daleko
      // od spot albo rynek bez notowań), odrzucamy CAŁE wygaśnięcie. Lepiej
      // pokazać "brak danych" niż wpisać do oceny artefakt numeryczny.
      if (!computed.reliable) return undefined;
      atmIv = computed.iv;
      ivSource = 'computed';
    }

    const straddleMid = callMid.mid + putMid.mid;
    const strikesWithBothSides = calls.filter(
      (c) => typeof c.strike === 'number' && putsByStrike.has(c.strike),
    ).length;

    return {
      expiration,
      dte,
      daysToEarnings: daysBetween(expiration, earningsDate),
      atmIv: Number.isFinite(atmIv) ? atmIv : NaN,
      ivSource,
      straddleMid,
      impliedMovePct: impliedMoveFromStraddle(straddleMid, spot),
      atmOpenInterest: (best.call.open_interest ?? 0) + (best.put.open_interest ?? 0),
      atmSpreadPct: Math.max(callMid.spreadPct, putMid.spreadPct),
      strikeCount: strikesWithBothSides,
    };
  }
}

/**
 * Wybór nóg kalendarza.
 *
 * Cel: front ma wygasać MOŻLIWIE BLISKO przed wynikami (ale przed), a back ma
 * wyniki objąć. Preferujemy standardowe wygaśnięcia miesięczne (3. piątek) —
 * są najpłynniejsze — ale dopuszczamy tygodniowe, gdy dają lepsze dopasowanie.
 *
 * Zwraca do 3 kandydatów na front (posortowanych od najlepszego), żeby skaner
 * mógł awaryjnie użyć kolejnego, jeśli pierwszy ma zerowy OI.
 */
export function selectCalendarLegs(params: {
  expirations: string[];
  earningsDate: string;
  today: string;
  /** Minimalna liczba dni życia frontu (im mniej, tym większy pin risk / brak płynności) */
  minFrontDte?: number;
}): { front: string; back: string }[] {
  const { expirations, earningsDate, today } = params;
  const minFrontDte = params.minFrontDte ?? 7;

  const usable = expirations
    .filter((e) => daysBetween(today, e) >= minFrontDte)
    .sort((a, b) => a.localeCompare(b));
  if (usable.length < 2) return [];

  const candidates: { front: string; back: string; quality: number }[] = [];

  for (const front of usable) {
    // UWAGA NA ZNAK: daysBetween(expiration, earnings) = dni OD wygaśnięcia DO wyników.
    //   > 0 : front wygasa przed wynikami  (strefa docelowa)
    //   < 0 : front wygasa po wynikach     (krótka noga zawiera zdarzenie)
    const dFront = daysBetween(front, earningsDate);

    // Front dopuszczamy w oknie: do 25 dni przed wynikami (dalej premia eventowa
    // jeszcze nie napływa) i do 3 dni po wynikach (krótka noga wygasa praktycznie
    // ze zdarzeniem). Dalej odrzucamy — to już inna struktura i inne ryzyko.
    if (dFront > 25 || dFront < -3) continue;

    // Back: najbliższe wygaśnięcie PO wynikach, które ma jeszcze zapas czasu na
    // zdarzenie. UWAGA: nie wystarczy `find(e => e > earningsDate)` — to wzięłoby
    // np. tygodniowe wygaśnięcie 3 dni po wynikach, gdzie zdarzenie jest słabo
    // wycenione i nie ma miejsca na ekspansję. Dlatego filtrujemy po zapasie:
    // co najmniej MIN_BACK_ROOM dni od wyników do wygaśnięcia długiej nogi.
    const MIN_BACK_ROOM = 21;
    const backs = usable
      .filter((e) => e > earningsDate && e > front)
      .map((e) => ({ expiration: e, room: daysBetween(earningsDate, e) }))
      .filter((b) => b.room >= MIN_BACK_ROOM);
    if (backs.length === 0) continue;

    // Najbliższy taki back — im bliżej zdarzenia, tym większa jego czułość na nie.
    const back = backs[0]!.expiration;
    const dBack = daysBetween(back, earningsDate);

    // Ocena jakości układu (im mniej, tym lepiej):
    //  1. Front ma wygasać TUŻ przed wynikami (ideał: 5 dni przed) — wtedy cały
    //     okres trzymania to napływ premii eventowej do bliższego wygaśnięcia.
    //  2. Preferujemy standardowe wygaśnięcia miesięczne (3. piątek) — najpłynniejsze,
    //     najwęższe spreadu, najwięcej strike'ów w okolicy ATM.
    //  3. Delikatnie karzemy bardzo odległe backi (więcej czasu = więcej zmienności
    //     na rynku, ale też mniejsza wrażliwość na samo zdarzenie).
    const frontProximity = Math.abs(dFront - 5);
    const monthlyBonus = isMonthly(back) ? -4 : 0;
    const backRoom = Math.min(Math.abs(dBack), 90);
    const quality = frontProximity - monthlyBonus - backRoom * 0.03;

    candidates.push({ front, back, quality });
  }

  candidates.sort((a, b) => a.quality - b.quality);

  // Deduplikacja po parze front|back (jedna para może powstać raz)
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const k = `${c.front}|${c.back}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
}

function isMonthly(expiration: string): boolean {
  const [y, m] = expiration.split('-').map(Number);
  if (!y || !m) return false;
  return thirdFriday(y, m) === expiration;
}

/** Przelicza IV na "w przybliżeniu oczekiwany ruch" — pomocnicze dla raportu. */
export function ivToApproxMove(iv: number, dte: number): number {
  return iv * Math.sqrt(Math.max(yearsFromDays(dte), 1 / 365));
}
