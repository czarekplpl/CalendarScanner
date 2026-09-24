/**
 * WYBÓR CENY OPcji — jedno miejsce, jedna reguła, wspólna dla wszystkich dostawców
 * =============================================================================
 *
 * PROBLEM, KTÓRY TO ROZWIĄZUJE:
 * Standardem w wycenie opcji jest środek widełek bid/ask. Ale na niepłynnych
 * opcjach — a takich jest dużo w top 200 — bid/ask kłamie: rozjazd bywa tak
 * szeroki, że środek wypada daleko od ceny, po jakiej realnie można handlować.
 * `last` to fakt wykonany (transakcja), a bid/ask to tylko oferta.
 *
 * Drugą stroną medalu jest to, że `last` bywa PRZESTARZAŁY: opcja z ostatnim
 * handlem sprzed dwóch dni ma `last` nieaktualny, podczas gdy bid/ask żyją.
 *
 * Dlatego nie wybieramy jednego źródła na sztywno, a rozstrzygamy kontekstem:
 *
 *   ┌────────────────────────────────────────────┬──────────────────────────────┐
 *   │ Sytuacja                                   │ Której ceny użyć             │
 *   ├────────────────────────────────────────────┼──────────────────────────────┤
 *   │ spread wąski (≤ WIDE_SPREAD_PCT)           │ mid — najlepszy estymator    │
 *   │ spread szeroki, last WEWNĄTRZ [bid, ask]   │ last — realna transakcja     │
 *   │ spread szeroki, last POZA widełkami        │ mid + ostrzeżenie (last stary)│
 *   │ brak jednej strony rynku, jest last        │ last                         │
 *   │ brak bid/ask i brak last, jest close       │ close + ostrzeżenie          │
 *   │ nic nie ma                                 │ 0 + ostrzeżenie              │
 *   └────────────────────────────────────────────┴──────────────────────────────┘
 *
 * Efekt: na płynnych łańcuchach zachowujemy standard rynkowy, a na cienkich
 * używamy ceny, po której faktycznie handlowano. Oba przypadki są oznaczone
 * w zwracanym `source`, więc można je rozdzielić w analizie i w danych
 * archiwalnych (kolumna `front_iv_source`/pricing source w schemacie).
 */

export type PriceSource = 'mid' | 'last' | 'last-outside-spread' | 'no-market';

export interface PriceSelection {
  /** Cena wybrana do wyceny IV i implied move */
  price: number;
  /** Spread bid-ask jako % wybranej ceny (1 = brak rynku, czyli 100%) */
  spreadPct: number;
  /** Skąd wzięliśmy cenę — do audytu i do danych archiwalnych */
  source: PriceSource;
  /** Czy mamy obie strony rynku (bid > 0 i ask > 0) */
  twoSided: boolean;
  /** Ostrzeżenie, gdy dane są podejrzane. Puste = bez zastrzeżeń. */
  warning?: string;
}

export interface QuoteInput {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  close?: number | null;
}

/**
 * Progi. Wartości wybrane świadomie, na podstawie realiów notowań opcji.
 *
 * KLUCZOWA DECYZJA: spread oceniamy JEDNOCZEŚNIE kwotowo i procentowo, i musi
 * być wąski w OBU wymiarach. Powód — sam procent myli na tanich opcjach:
 *
 *   bid 3.00 / ask 3.10  => spread 0.10 = 3.3% ceny. Procentowo "szeroko",
 *                           ale kwotowo to TYPOWY, płynny rynek na opcji za $3.
 *   bid 2.00 / ask 2.10  => spread 0.10 = 4.9%. Też normalny rynek.
 *   bid 20.00 / ask 20.20 => spread 0.20 = 1.0% — płynny.
 *   bid 2.00 / ask 6.00  => spread 4.00 = 100% ceny — tu bid/ask jest fikcją.
 *
 * Reguła procentowa odrzucałaby pierwsze dwa przypadki jako "niepłynne", co jest
 * błędem. Dlatego `mid` uznajemy za wiarygodny, gdy spread jest ≤ MAX_TICK_SPREAD
 * (typowy tick dla opcji poniżej $3) ALBO ≤ TIGHT_SPREAD_PCT (dla drogich opcji,
 * gdzie liczy się proporcja).
 *
 *  - STALE_LAST_PCT 0.25: jeśli `last` leży ponad 25% poza widełkami, prawie
 *    na pewno pochodzi z innej sesji (kurs się przesunął), więc ufamy ofertom.
 */
export const MAX_TICK_SPREAD = 0.1;
export const TIGHT_SPREAD_PCT = 0.03;
export const STALE_LAST_PCT = 0.25;

/**
 * Zapas na błąd reprezentacji double. 3.1 - 3.0 daje 0.10000000000000009, czyli
 * WIĘCEJ niż próg 0.1 — bez tolerancji spread dokładnie na granicy (najczęstszy
 * przypadek: typowy tick) byłby klasyfikowany jako szeroki. 1e-9 jest o wiele
 * rzędów mniejszy niż jakakolwiek realna różnica między spreadami.
 */
const FLOAT_EPSILON = 1e-9;

/**
 * Czy spread jest na tyle ciasny, że środek widełek jest wiarygodny?
 * Wąski kwotowo (typowy tick) LUB wąski procentowo (dla wysokich cen).
 */
export function isTightSpread(bid: number, ask: number, mid: number): boolean {
  const absSpread = ask - bid;
  if (absSpread <= MAX_TICK_SPREAD + FLOAT_EPSILON) return true;
  return mid > 0 && absSpread / mid <= TIGHT_SPREAD_PCT + FLOAT_EPSILON;
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Wybiera cenę opcji zgodnie z regułą opisaną w nagłówku pliku.
 * Funkcja jest czysta — bez sieci i stanu, więc testowalna w izolacji.
 */
export function selectOptionPrice(q: QuoteInput): PriceSelection {
  const bid = positive(q.bid);
  const ask = positive(q.ask);
  const last = positive(q.last);
  const close = positive(q.close);

  // ── Brak dwóch stron rynku ────────────────────────────────────────────────
  if (bid === undefined || ask === undefined || ask < bid) {
    const fallback = last ?? close;
    if (fallback === undefined) {
      return {
        price: 0,
        spreadPct: 1,
        source: 'no-market',
        twoSided: false,
        warning: 'Brak bid/ask i brak ostatniej ceny — nie ma z czego policzyć wyceny.',
      };
    }
    return {
      price: fallback,
      spreadPct: 1,
      source: 'no-market',
      twoSided: false,
      warning: last === undefined
        ? 'Brak rynku (jednostronny lub zerowy) — użyto ceny zamknięcia; wycena może być nieaktualna.'
        : 'Brak dwóch stron rynku — użyto ostatniej ceny transakcji; spread nieznany.',
    };
  }

  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (ask - bid) / mid : 1;

  // ── Spread wąski (kwotowo lub procentowo): mid jest najlepszym estymatorem ─
  if (isTightSpread(bid, ask, mid)) {
    return { price: mid, spreadPct, source: 'mid', twoSided: true };
  }

  // ── Spread szeroki: sprawdzamy, czy last mieści się w widełkach ───────────
  if (last !== undefined) {
    const insideSpread = last >= bid && last <= ask;
    if (insideSpread) {
      // Realna transakcja wewnątrz ofert — lepszy estymator niż środek szerokiego
      // spreadu, bo środek może leżeć daleko od tego, gdzie rynek faktycznie schodzi.
      return {
        price: last,
        spreadPct,
        source: 'last',
        twoSided: true,
        warning:
          spreadPct > 0.15
            ? `Bardzo szeroki spread (${(spreadPct * 100).toFixed(0)}% mid) — użyto ostatniej transakcji zamiast środka.`
            : undefined,
      };
    }

    // last poza widełkami — najpewniej z wcześniejszej sesji
    const deviation = mid > 0 ? Math.abs(last - mid) / mid : 0;
    if (deviation <= STALE_LAST_PCT) {
      return {
        price: last,
        spreadPct,
        source: 'last-outside-spread',
        twoSided: true,
        warning: 'Ostatnia transakcja poza widełkami bid/ask, ale blisko — użyto jej; możliwy nieaktualny odczyt.',
      };
    }

    return {
      price: mid,
      spreadPct,
      source: 'last-outside-spread',
      twoSided: true,
      warning:
        `Ostatnia transakcja odległa o ${(deviation * 100).toFixed(0)}% od środka widełek ` +
        '— najpewniej z wcześniejszej sesji, więc użyto środka bid/ask.',
    };
  }

  // ── Szeroki spread i brak last: zostaje mid ───────────────────────────────
  return {
    price: mid,
    spreadPct,
    source: 'mid',
    twoSided: true,
    warning: `Szeroki spread (${(spreadPct * 100).toFixed(0)}% mid) i brak ostatniej transakcji — wycena oparta na środku widełek.`,
  };
}

/** Etykieta źródła ceny do zapisania w danych archiwalnych. */
export function priceSourceLabel(source: PriceSource): string {
  switch (source) {
    case 'mid':
      return 'mid';
    case 'last':
      return 'last';
    case 'last-outside-spread':
      return 'last-poza-widelkami';
    case 'no-market':
      return 'brak-rynku';
  }
}
