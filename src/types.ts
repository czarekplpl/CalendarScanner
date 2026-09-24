/**
 * Typy współdzielone przez cały skaner.
 *
 * Terminologia (żeby kod i decyzje były spójne):
 *  - earningsDate  — data publikacji wyników (BMO = przed otwarciem, AMC = po zamknięciu)
 *  - front / back  — krótsza i dłuższa noga kalendarza (ta sama strike, różne wygaśnięcia)
 *  - T-x           — ile dni kalendarzowych zostało do wyników
 *  - "okno zdarzenia" — przedział czasu, w którym wygasająca noga NIE zawiera wyników,
 *                        a dłuższa je zawiera. To jest strefa, w której kalendarz
 *                        zarabia na narastaniu IV krótkiej nogi.
 */

export type EarningsTiming = 'bmo' | 'amc' | 'unknown';

export interface EarningsEvent {
  symbol: string;
  /** YYYY-MM-DD */
  date: string;
  timing: EarningsTiming;
  /** Czy data potwierdzona przez spółkę (Finnhub: potwierdzone vs. szacowane) */
  confirmed: boolean;
  epsEstimate?: number;
  revenueEstimate?: number;
  /** Poprzednie kwartały — do oszacowania typowego ruchu po wynikach */
  history?: EarningsHistoryPoint[];
}

export interface EarningsHistoryPoint {
  /** YYYY-MM-DD */
  date: string;
  epsActual?: number;
  epsEstimate?: number;
  /** Zmiana kursu w dniu publikacji (jeśli dostawca podaje) */
  surprisePercent?: number;
}

/** Wycena jednego wygaśnięcia (jedna noga kalendarza). */
export interface IvPoint {
  /** YYYY-MM-DD */
  expiration: string;
  /** Dni kalendarzowe do wygaśnięcia */
  dte: number;
  /** Dni kalendarzowe od wygaśnięcia do wyników (ujemne = wygasa po wynikach) */
  daysToEarnings: number;
  /** IV opcji ATM, w ułamku (0.45 = 45%) */
  atmIv: number;
  /**
   * Skąd wzięliśmy IV:
   *  - 'provider' — pole od dostawcy (np. tasty trade /market-metrics albo greki ORATS)
   *  - 'computed' — nasz solver Black-Scholes z cen opcji ATM
   *  - 'model'    — IV indeksu spółki jako szacunek, gdy brak notowań opcji.
   *                 Oznaczone jawnie, bo to NIE jest IV tego wygaśnięcia.
   */
  ivSource: 'provider' | 'computed' | 'model';
  /** Cena ATM straddle (call + put) — koszt "ruchu" wycenianego przez rynek */
  straddleMid: number;
  /** Wskaźnik zmienności implikowanej: straddle / spot (ułamek ceny) */
  impliedMovePct: number;
  /** Open interest na strike ATM (call + put) */
  atmOpenInterest: number;
  /** Spread bid-ask ATM jako % mid (im niżej, tym lepiej) */
  atmSpreadPct: number;
  /** Liczba strike'ów z rynkiem w łańcuchu — proxy głębokości rynku */
  strikeCount: number;
  /** Strike wybrany jako ATM — potrzebny do zaraportowania konkretnej struktury */
  atmStrike?: number;
  /**
   * Z której ceny policzono IV i implied move:
   *  - 'mid'                 — środek widełek bid/ask (rynek płynny)
   *  - 'last'                — ostatnia transakcja (szeroki spread, ale realny handel)
   *  - 'last-poza-widelkami' — last poza widełkami; przy dużej odległości użyto mid
   *  - 'brak-rynku'          — brak bid/ask i last (wycena z close)
   * Do analizy: wiersze z 'brak-rynku' traktuj ostrożnie, bo IV z nich jest niepewna.
   */
  pricingSource?: string;
}

/** Składowe oceny — pokazywane użytkownikowi, żeby wiedział ZA CO jest punkt. */
export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  note: string;
}

export interface CalendarCandidate {
  symbol: string;
  name?: string;
  sector?: string;
  spot: number;
  earnings: EarningsEvent;
  /** Dni kalendarzowe do wyników (T-x) */
  daysToEarnings: number;
  /** Dni sesyjne do wyników */
  tradingDaysToEarnings: number;
  /** Czy wyniki wypadają w oknie między front a back (najlepszy przypadek) */
  earningsInsideBackOnly: boolean;
  front?: IvPoint;
  back?: IvPoint;
  /** back.atmIv - front.atmIv (punkty procentowe IV) */
  termStructureSlope?: number;
  /** front.atmIv / back.atmIv — <1 znaczy "przód jeszcze nie wycenił zdarzenia" */
  termStructureRatio?: number;
  /** Percentyl własnej IV z historii (0-100). undefined = za mało danych. */
  ivRank?: number;
  /** Typowy historyczny ruch po wynikach (wartość bezwzględna, ułamek) */
  avgHistoricalMovePct?: number;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  components: ScoreComponent[];
  flags: string[];
  /** Sugerowana data wejścia (T-ENTRY) — kiedy struktura jest najlepiej ustawiona */
  suggestedEntryDate?: string;
  warnings: string[];
}

export interface ScanResult {
  generatedAt: string;
  /** Wersja skanera, która wygenerowała wynik — do proweniencji danych w archiwum. */
  scannerVersion?: string;
  /** Data sesyjna, dla której liczono */
  asOf: string;
  config: {
    alertMinDays: number;
    alertMaxDays: number;
    optionsProvider: string;
    earningsProvider: string;
    tradierEnv: string;
  };
  counts: {
    universe: number;
    withUpcomingEarnings: number;
    inAlertWindow: number;
    analyzed: number;
    candidates: number;
    alertsSent: number;
  };
  candidates: CalendarCandidate[];
  /** Spółki w oknie alertu, dla których nie udało się pobrać opcji */
  watchlistOnly: { symbol: string; earningsDate: string; daysToEarnings: number; reason: string }[];
  errors: string[];
  durationMs: number;
}

export interface AlertRecord {
  /** Klucz deduplikacji: symbol + data wyników + próg */
  key: string;
  symbol: string;
  earningsDate: string;
  score: number;
  sentAt: string;
  channels: string[];
}

/** Zmienne środowiskowe workera (wrangler.toml [vars] + sekrety). */
export interface Env {
  STATE?: KVNamespace;
  /** Baza D1 na dane do backtestu (opcjonalna — archiwum KV działa bez niej). */
  DB?: D1Database;
  FINNHUB_API_KEY?: string;
  TRADIER_API_KEY?: string;
  POLYGON_API_KEY?: string;

  // ── tastytrade Open API (OAuth2) ───────────────────────────────────────────
  // Uwaga: sandbox i produkcja mają OSOBNE poświadczenia — nie działają zamiennie.
  TASTYTRADE_CLIENT_ID?: string;
  TASTYTRADE_CLIENT_SECRET?: string;
  TASTYTRADE_REFRESH_TOKEN?: string;

  // ── E-mail ─────────────────────────────────────────────────────────────────
  // Brevo API v3 wymaga klucza API (xkeysib-...), NIE klucza SMTP (xsmtpsib-...).
  BREVO_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  API_KEY?: string;

  EARNINGS_PROVIDER?: string;
  OPTIONS_PROVIDER?: string;
  TRADIER_ENV?: string;
  TASTYTRADE_ENV?: string;
  EMAIL_PROVIDER?: string;
  ALERT_MIN_DAYS?: string;
  ALERT_MAX_DAYS?: string;
  MAX_DEEP_ANALYSIS?: string;
  MIN_OPEN_INTEREST?: string;
  ALERT_CHANNELS?: string;
  INCLUDE_ETFS?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  REQUIRE_API_KEY?: string;
  CACHE_TTL_SECONDS?: string;
  MAX_ALERTS_PER_RUN?: string;
}
