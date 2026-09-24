/**
 * Black-Scholes + solver zmienności implikowanej.
 *
 * PO CO TO JEST:
 * Posiadany zestaw danych (Tradier sandbox) NIE zwraca greków ani IV — te pola
 * są dostępne dopiero na koncie brokerskim. Zamiast więc zależeć od dostawcy,
 * liczymy IV sami z cen opcji. Efekt uboczny jest pozytywny: ten sam kod działa
 * na każdym źródle cen (Tradier, Polygon, plik CSV), a wynik jest porównywalny
 * między dostawcami.
 *
 * Umowa: stopy i dywidendy w ułamkach (0.04 = 4%), czas w latach,
 * zmienność w ułamku (0.35 = 35%).
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Gęstość rozkładu normalnego. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Dystrybuanta rozkładu normalnego — aproksymacja Zelen & Severo (błąd < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - normPdf(x) * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** Odwrotna dystrybuanta (Acklam) — potrzebna do liczenia moneyness w deltach. */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('normInv: p musi być w (0,1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

export type OptionType = 'call' | 'put';

export interface BsInput {
  /** Typ opcji */
  type: OptionType;
  /** Cena instrumentu bazowego */
  spot: number;
  /** Cena wykonania */
  strike: number;
  /** Czas do wygaśnięcia w latach */
  timeToExpiry: number;
  /** Zmienność w ułamku */
  vol: number;
  /** Stopa wolna od ryzyka */
  rate: number;
  /** Stopa dywidendy (ciągła) */
  dividendYield?: number;
}

export interface BsGreeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  d1: number;
  d2: number;
}

/** Wycena + greki. Vega jest na 1 punkt zmienności (1.00 = 100%), theta na rok. */
export function blackScholes(input: BsInput): BsGreeks {
  const { type, spot, strike, timeToExpiry: T, vol, rate: r } = input;
  const q = input.dividendYield ?? 0;

  // Przypadek graniczny: brak czasu lub zerowa zmienność => wartość wewnętrzna.
  if (T <= 0 || vol <= 0) {
    const intrinsic =
      type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return {
      price: intrinsic,
      delta: type === 'call' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
      rho: 0,
      d1: NaN,
      d2: NaN,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * vol * vol) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discQ = Math.exp(-q * T);
  const discR = Math.exp(-r * T);

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const npd1 = normPdf(d1);

  let price: number;
  let delta: number;
  let rho: number;
  if (type === 'call') {
    price = spot * discQ * nd1 - strike * discR * nd2;
    delta = discQ * nd1;
    rho = (strike * T * discR * nd2) / 100;
  } else {
    price = strike * discR * (1 - nd2) - spot * discQ * (1 - nd1);
    delta = -discQ * (1 - nd1);
    rho = -(strike * T * discR * (1 - nd2)) / 100;
  }

  const gamma = (discQ * npd1) / (spot * vol * sqrtT);
  const vega = (spot * discQ * npd1 * sqrtT) / 100;
  const theta =
    (-(spot * discQ * npd1 * vol) / (2 * sqrtT) +
      (type === 'call'
        ? -r * strike * discR * nd2 + q * spot * discQ * nd1
        : r * strike * discR * (1 - nd2) - q * spot * discQ * (1 - nd1))) /
    365;

  return { price, delta, gamma, vega, theta, rho, d1, d2 };
}

const DAYS_PER_YEAR = 365;

/** Przelicza dni kalendarzowe na lata (baza 365 — standard dla IV w akcjach). */
export function yearsFromDays(days: number): number {
  return Math.max(days, 0) / DAYS_PER_YEAR;
}

export interface IvResult {
  iv: number;
  /** true, jeśli solver zbiegł do rozwiązania, któremu można ufać */
  converged: boolean;
  method: 'newton' | 'bisection' | 'fallback' | 'low-vega';
  /** Cena modelowa dla znalezionej IV — do kontroli jakości */
  modelPrice: number;
  /** Vega (na 1.00 zmienności) w rozwiązaniu — miara wiarygodności IV */
  vega?: number;
}

/**
 * Liczy IV z ceny rynkowej (mid).
 *
 * KLUCZOWA DECYZJA PROJEKTOWA — kryterium zbieżności jest w PRZESTRZENI IV,
 * a nie w przestrzeni ceny. Uzasadnienie na realnym przypadku z testów:
 *
 *   Call spot=100, K=80, T=0.2, prawdziwa IV=8%.
 *   Vega w rozwiązaniu ≈ 1.4e-8 na jednostkę zmienności. Żeby odczytać IV
 *   z dokładnością do 1e-4, residual ceny musi być rzędu 1e-12 — czyli na
 *   poziomie precyzji maszynowej. Gdyby solver zatrzymywał się na typowej
 *   tolerancji CENY (1e-6), zwróciłby IV ≈ 0.106 zamiast 0.08: liczbę, która
 *   wygląda wiarygodnie, a jest artefaktem tolerancji.
 *
 * Dlatego:
 *   - Newton zatrzymuje się, gdy KROK (diff/vega) < 1e-5 w jednostkach IV,
 *     co jest wprost błędem zmienności, jaki popełniamy,
 *   - po rozwiązaniu liczymy błąd IV z residualu (z vega i z wypukłości),
 *   - jeśli błąd > 1 punkt procentowy zmienności => converged=false, method='low-vega'.
 *
 * Warstwa wyżej (TradierAdapter.buildIvPoint) pomija punkty z converged=false,
 * zamiast wpisywać artefakt numeryczny do oceny kalendarza.
 */
export function impliedVolatility(
  targetPrice: number,
  input: Omit<BsInput, 'vol'>,
  options: { lo?: number; hi?: number; maxIter?: number } = {},
): IvResult {
  const lo = options.lo ?? 0.005; // 0.5% — dolna granica sensownej zmienności
  const hi = options.hi ?? 5.0; // 500% IV — powyżej tego dane są zwykle śmieciowe
  const maxIter = options.maxIter ?? 100;

  const priceAt = (vol: number) => blackScholes({ ...input, vol }).price;
  const vegaAt = (vol: number) => blackScholes({ ...input, vol }).vega * 100; // na 1.00 zmienności
  const curvatureAt = (vol: number) => {
    const h = 0.01;
    return (priceAt(vol + h) - 2 * priceAt(vol) + priceAt(vol - h)) / (h * h);
  };

  const priceLo = priceAt(lo);
  const priceHi = priceAt(hi);

  const IV_ERROR_TOLERANCE = 0.01; // 1 punkt procentowy zmienności
  const finalize = (iv: number, method: IvResult['method']): IvResult => {
    const modelPrice = priceAt(iv);
    const residual = Math.abs(modelPrice - targetPrice);
    const vega = vegaAt(iv);
    const curvature = Math.abs(curvatureAt(iv));
    const ivErrorFromVega = vega > 0 ? residual / vega : Number.POSITIVE_INFINITY;
    const ivErrorFromCurvature =
      curvature > 0 ? Math.sqrt((2 * residual) / curvature) : Number.POSITIVE_INFINITY;
    const reliable =
      ivErrorFromVega <= IV_ERROR_TOLERANCE && ivErrorFromCurvature <= IV_ERROR_TOLERANCE * 3;

    return {
      iv,
      converged: reliable,
      method: reliable ? method : 'low-vega',
      modelPrice,
      vega,
    };
  };

  // Kontrola zakresu: cena poza [cena(lo), cena(hi)] => brak rozwiązania w zakresie.
  if (targetPrice <= priceLo) {
    return { iv: lo, converged: false, method: 'fallback', modelPrice: priceLo, vega: vegaAt(lo) };
  }
  if (targetPrice >= priceHi) {
    return { iv: hi, converged: false, method: 'fallback', modelPrice: priceHi, vega: vegaAt(hi) };
  }

  // Newton-Raphson z kryterium stopu w przestrzeni IV.
  const IV_STEP_TOLERANCE = 1e-5;
  let vol = 0.5;
  for (let i = 0; i < maxIter; i++) {
    const diff = priceAt(vol) - targetPrice;
    const v = vegaAt(vol);
    if (!Number.isFinite(v) || v < 1e-12) break; // vega znikoma => Newton zawodny
    const step = diff / v;
    if (Math.abs(step) < IV_STEP_TOLERANCE) return finalize(vol, 'newton');
    const next = vol - step;
    if (!Number.isFinite(next) || next <= lo || next >= hi) break; // ucieczka z zakresu
    vol = next;
  }

  // Bisekcja — wolniejsza, ale niezawodna. Stop: szerokość przedziału < 1e-6 w IV.
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (a + b);
    if (b - a < 1e-6) return finalize(mid, 'bisection');
    if (priceAt(mid) - targetPrice > 0) b = mid;
    else a = mid;
  }
  return finalize(0.5 * (a + b), 'bisection');
}

/** Cena ATM straddle wg modelu BS — do porównania z ceną rynkową. */
export function straddlePrice(input: Omit<BsInput, 'type'>): number {
  return (
    blackScholes({ ...input, type: 'call' }).price + blackScholes({ ...input, type: 'put' }).price
  );
}

/**
 * Przybliżony ruch implikowany (w ułamku ceny) z ceny ATM straddle.
 * To najbardziej praktyczna miara "co rynek wycenia na wyniki" — dla kalendarza
 * liczy się to, jak tanio kupujesz ten ruch na krótkiej nodze.
 */
export function impliedMoveFromStraddle(straddle: number, spot: number): number {
  if (spot <= 0) return 0;
  return straddle / spot;
}

/**
 * IV ATM z pary call/put o tej samej strike.
 * Używamy średniej IV z obu nóg (przy strike ATM wegi są zbliżone, a średnia jest
 * odporniejsza na outlier w jednej z nóg niż pojedyncza noga).
 *
 * `reliable` jest false, gdy którakolwiek noga jest nieidentyfikowalna — wtedy
 * wywołujący powinien odrzucić punkt, a nie używać samej liczby `iv`.
 */
export function atmIvFromQuotes(params: {
  spot: number;
  strike: number;
  daysToExpiry: number;
  callMid: number;
  putMid: number;
  rate: number;
  dividendYield?: number;
}): { iv: number; reliable: boolean; callIv: number; putIv: number; straddle: number } {
  const T = yearsFromDays(params.daysToExpiry);
  const base = {
    spot: params.spot,
    strike: params.strike,
    timeToExpiry: T,
    rate: params.rate,
    dividendYield: params.dividendYield ?? 0,
  };
  const call = impliedVolatility(params.callMid, { ...base, type: 'call' });
  const put = impliedVolatility(params.putMid, { ...base, type: 'put' });
  return {
    iv: (call.iv + put.iv) / 2,
    reliable: call.converged && put.converged,
    callIv: call.iv,
    putIv: put.iv,
    straddle: params.callMid + params.putMid,
  };
}
