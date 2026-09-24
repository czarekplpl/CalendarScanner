/**
 * ADAPTER: Finnhub — kalendarz wyników i historia niespodzianek.
 *
 * Kontrakt adaptera (żeby dało się podmienić dostawcę bez ruszania skanera):
 *   listEarnings(from, to)  -> EarningsEvent[]
 *   historicalMoves(symbol) -> { avgAbsMovePct, samples }
 *
 * Dokumentacja: https://finnhub.io/docs/api/earnings-calendar
 * Darmowy plan: 60 żądań/min, dane US wystarczające do kalendarza.
 *
 * UWAGA o "avgAbsMovePct": Finnhub w /stock/earnings zwraca `surprisePercent`,
 * czyli niespodziankę na EPS — to NIE jest ruch kursu po wynikach. Dopóki nie
 * podłączysz dostawcy z realnymi ruchami (Polygon/FMP/Orats), traktuj tę wartość
 * jako przybliżenie i skaluj ostrożnie. Dla uczciwości wynik jest oznaczany
 * jako przybliżony i skaner nie opiera na nim kluczowej decyzji.
 */

import { fetchJson, HttpError, RateLimiter } from '../core/http.ts';
import type { EarningsEvent, EarningsHistoryPoint, EarningsTiming } from '../types.ts';

const BASE = 'https://finnhub.io/api/v1';

interface FinnhubCalendarRow {
  symbol?: string;
  date?: string;
  hour?: string; // 'bmo' | 'amc' | 'dmh' | ''
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  quarter?: number;
  year?: number;
}

interface FinnhubCalendarResponse {
  earningsCalendar?: FinnhubCalendarRow[];
}

interface FinnhubQuoteResponse {
  c?: number; // cena bieżąca
  pc?: number; // zamknięcie poprzedniej sesji
  t?: number; // znacznik czasu
}

interface FinnhubSurpriseRow {
  actual?: number | null;
  estimate?: number | null;
  period?: string;
  surprise?: number | null;
  surprisePercent?: number | null;
  symbol?: string;
}

function normalizeTiming(hour: string | undefined): EarningsTiming {
  if (hour === 'bmo') return 'bmo';
  if (hour === 'amc') return 'amc';
  return 'unknown';
}

export class FinnhubAdapter {
  private readonly limiter = new RateLimiter(55); // 60/min z marginesem
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private url(path: string, params: Record<string, string>): string {
    const qs = new URLSearchParams({ ...params, token: this.apiKey });
    return `${BASE}${path}?${qs.toString()}`;
  }

  /**
   * Kalendarz wyników dla zakresu dat. Zapytanie bez `symbol` zwraca cały rynek US
   * (setki rekordów dziennie) — dlatego filtrujemy po swoim uniwersum w skanerze,
   * a nie 200 osobnymi zapytaniami (oszczędza limit API).
   */
  async listEarnings(from: string, to: string): Promise<EarningsEvent[]> {
    await this.limiter.acquire();
    const data = await fetchJson<FinnhubCalendarResponse>(
      this.url('/calendar/earnings', { from, to }),
      { label: 'finnhub.calendar', retries: 3 },
    );
    const rows = data.earningsCalendar ?? [];
    return rows
      .filter((r): r is FinnhubCalendarRow & { symbol: string; date: string } =>
        Boolean(r.symbol && r.date),
      )
      .map((r) => ({
        symbol: r.symbol.toUpperCase(),
        date: r.date,
        timing: normalizeTiming(r.hour),
        // Finnhub nie oznacza wprost "potwierdzone"; brak godziny traktujemy jako
        // datę szacowaną, co jest bezpieczniejszą domyślną postawą.
        confirmed: r.hour === 'bmo' || r.hour === 'amc',
        epsEstimate: r.epsEstimate ?? undefined,
        revenueEstimate: r.revenueEstimate ?? undefined,
      }));
  }

  /**
   * Kurs akcji — używany jako źródło SPOT, bo tastytrade nie udostępnia notowań
   * na naszym poziomie uprawnień (`/market-data` zwraca 403).
   *
   * Dlaczego Finnhub, a nie inny dostawca: klucz już mamy (potrzebny i tak do
   * kalendarza wyników), a `/quote` jest w darmowym planie i odpowiada szybko.
   * Jedno zapytanie na spółkę, ale pytamy TYLKO o finalistów w oknie alertu
   * (kilkanaście spółek na przebieg), więc zużycie jest znikome.
   */
  async quote(symbol: string): Promise<number | undefined> {
    await this.limiter.acquire();
    try {
      const data = await fetchJson<FinnhubQuoteResponse>(
        this.url('/quote', { symbol: symbol.toUpperCase() }),
        { label: `finnhub.quote.${symbol}`, retries: 2 },
      );
      // c = 0 oznacza brak danych (Finnhub tak sygnalizuje nieznany symbol)
      const price = typeof data.c === 'number' && data.c > 0 ? data.c : undefined;
      return price;
    } catch {
      // Brak kursu nie może wywalić skanu — spółka po prostu wypadnie z analizy
      return undefined;
    }
  }

  /** Historia wyników spółki (ostatnie kwartały). */
  async earningsHistory(symbol: string, limit = 8): Promise<EarningsHistoryPoint[]> {
    await this.limiter.acquire();
    try {
      const rows = await fetchJson<FinnhubSurpriseRow[]>(
        this.url('/stock/earnings', { symbol, limit: String(limit) }),
        { label: `finnhub.earnings.${symbol}`, retries: 2 },
      );
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => Boolean(r.period))
        .map((r) => ({
          date: r.period as string,
          epsActual: r.actual ?? undefined,
          epsEstimate: r.estimate ?? undefined,
          surprisePercent: r.surprisePercent ?? undefined,
        }));
    } catch (err) {
      // Historia jest opcjonalna — nie może przerwać skanu.
      if (err instanceof HttpError && err.status === 403) return [];
      return [];
    }
  }
}

/**
 * Przybliżony "typowy ruch po wynikach" z historii niespodzianek EPS.
 *
 * Metoda: bierzemy średnią |surprisePercent| z ostatnich kwartałów. To proxy,
 * nie realny ruch kursu — dla spółek, które raportują zgodnie z trendem, ruch
 * bywa większy niż sama niespodzianka EPS. Zwracamy też liczbę próbek, żeby
 * skaner mógł oznaczyć wynik jako niepewny przy małej historii.
 */
export function approxMoveFromSurprises(
  history: EarningsHistoryPoint[],
): { avgAbsMovePct?: number; samples: number } {
  const values = history
    .map((h) => h.surprisePercent)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100);
  if (values.length < 4) return { samples: values.length };
  const avg = values.reduce((s, v) => s + Math.abs(v), 0) / values.length;
  return { avgAbsMovePct: avg / 100, samples: values.length };
}
