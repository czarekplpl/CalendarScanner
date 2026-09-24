/**
 * ARCHIWUM DZIENNE — trwały zapis migawek skanu pod backtest
 * =========================================================
 *
 * PROBLEM, KTÓRY TO ROZWIĄZUJE:
 * Skaner trzyma w KV tylko OSTATNI wynik (`scan:last`) i kasuje go po 14 dniach.
 * Przy pracy crona 2x dziennie oznacza to, że po dwóch tygodniach nie ma czego
 * backtestować — każda migawka została nadpisana przez następną.
 *
 * Backtest wymaga zamrożonej migawki „co system wiedział danego dnia", a kluczowe
 * wartości (term structure, IV rank, implied move, spread, OI) są chwilowe —
 * darmowi dostawcy nie sprzedają ich historii. Dlatego archiwizujemy SUROWY wynik
 * skanu, zanim cokolwiek go nadpisze.
 *
 * Układ kluczy:
 *   scan:day:YYYY-MM-DD  -> pełny ScanResult z tego dnia (nadpisywany tego samego dnia)
 *   scan:index           -> lista dni, które mają migawkę (żeby dało się eksportować)
 *
 * Koszt: 2 zapisy KV na dzień, niezależnie od liczby spółek. Mieści się w darmowym
 * limicie (1000 zapisów/dzień) z ogromnym zapasem.
 */

import type { Env, ScanResult } from '../types.ts';

const DAY_PREFIX = 'scan:day:';
const INDEX_KEY = 'scan:index';
/** 400 dni ~ 13 miesięcy: wystarczy na porównanie rok do roku, wciąż tanie w KV. */
const DAY_TTL_SECONDS = 400 * 24 * 3600;
const INDEX_TTL_SECONDS = 420 * 24 * 3600;
const MAX_INDEX_ENTRIES = 420;

export interface ArchiveIndexEntry {
  /** YYYY-MM-DD */
  date: string;
  /** Liczba kandydatów w tej migawce — szybki podgląd bez czytania całości */
  candidates: number;
  /** Liczba przeanalizowanych spółek */
  analyzed: number;
  /** Kiedy zapisano (ISO) — rozróżnia przebieg wieczorny od porannego */
  archivedAt: string;
}

export interface ArchiveIndex {
  days: ArchiveIndexEntry[];
}

/**
 * Zapisuje migawkę skanu pod datę sesyjną.
 *
 * Wywoływane po KAŻDYM przebiegu: przebieg wieczorny i poranny tego samego dnia
 * nadpisują ten sam klucz. To zamierzone — interesuje nas stan na koniec dnia,
 * a poranny przebieg jest pół dnia świeższy (wyłapuje korekty dat wyników).
 */
export async function archiveDailyScan(env: Env, scan: ScanResult): Promise<void> {
  if (!env.STATE) return;

  try {
    await env.STATE.put(`${DAY_PREFIX}${scan.asOf}`, JSON.stringify(scan), {
      expirationTtl: DAY_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(
      `[scanner] nie udało się zapisać migawki dnia ${scan.asOf}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Indeks dni — bez niego eksport musiałby zgadywać, które daty istnieją.
  try {
    const index = await loadArchiveIndex(env);
    const entry: ArchiveIndexEntry = {
      date: scan.asOf,
      candidates: scan.counts.candidates,
      analyzed: scan.counts.analyzed,
      archivedAt: new Date().toISOString(),
    };
    const without = index.days.filter((d) => d.date !== scan.asOf);
    const days = [...without, entry]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_INDEX_ENTRIES);
    await env.STATE.put(INDEX_KEY, JSON.stringify({ days }), { expirationTtl: INDEX_TTL_SECONDS });
  } catch (err) {
    console.warn(
      `[scanner] nie udało się zaktualizować indeksu archiwum: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function loadArchiveIndex(env: Env): Promise<ArchiveIndex> {
  if (!env.STATE) return { days: [] };
  try {
    const raw = await env.STATE.get<ArchiveIndex>(INDEX_KEY, 'json');
    if (!raw || !Array.isArray(raw.days)) return { days: [] };
    return { days: raw.days.filter((d) => typeof d?.date === 'string') };
  } catch {
    return { days: [] };
  }
}

/**
 * Wczytuje migawki z podanego zakresu dat.
 *
 * `limit` chroni przed przypadkowym pobraniem roku danych naraz (odpowiedź Workera
 * i limit CPU). Domyślnie 60 dni.
 */
export async function loadArchivedScans(
  env: Env,
  options: { from?: string; to?: string; limit?: number } = {},
): Promise<{ scans: ScanResult[]; missing: string[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(options.limit ?? 60, 400));
  const index = await loadArchiveIndex(env);

  let dates = index.days.map((d) => d.date).sort();
  if (options.from) dates = dates.filter((d) => d >= options.from!);
  if (options.to) dates = dates.filter((d) => d <= options.to!);

  // Bierzemy NAJNOWSZE dni — przy eksporcie do backtestu to zwykle to, na czym zależy.
  const truncated = dates.length > limit;
  if (truncated) dates = dates.slice(-limit);

  if (!env.STATE) return { scans: [], missing: dates, truncated };

  const scans: ScanResult[] = [];
  const missing: string[] = [];
  for (const date of dates) {
    try {
      const raw = await env.STATE.get<ScanResult>(`${DAY_PREFIX}${date}`, 'json');
      if (raw) scans.push(raw);
      else missing.push(date);
    } catch {
      missing.push(date);
    }
  }
  return { scans, missing, truncated };
}

/** Data najstarszej i najnowszej migawki — do raportowania w /api/health. */
export function archiveSpan(index: ArchiveIndex): { oldest?: string; newest?: string; days: number } {
  const dates = index.days.map((d) => d.date).sort();
  return { oldest: dates[0], newest: dates[dates.length - 1], days: dates.length };
}
