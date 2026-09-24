/**
 * LOKALNE URUCHOMIENIE SKANU (bez Cloudflare)
 * ==========================================
 *
 * Używa tych samych adapterów i tej samej logiki co Worker, ale zapisuje wynik
 * na dysk. Do czego służy:
 *   - sprawdzenie, czy klucze API działają, ZANIM wdrożysz cokolwiek do chmury,
 *   - podejrzenie realnych danych i ocen na żywo,
 *   - debugowanie konkretnej spółki.
 *
 * URUCHOMIENIE:
 *   1. Utwórz plik .dev.vars w katalogu projektu (jest w .gitignore):
 *
 *        FINNHUB_API_KEY=...
 *        TRADIER_API_KEY=...
 *
 *   2. Uruchom:
 *
 *        npm run scan:local
 *
 *      albo z zapisem pełnego raportu i dashboardu:
 *
 *        npm run scan:local -- --html --json
 *
 * OPCJE:
 *   --html         zapisz dashboard HTML do test-output/scan.html
 *   --json         zapisz surowy JSON do test-output/scan.json
 *   --symbols=A,B  analizuj tylko wskazane spółki (debug; omija kalendarz dla reszty)
 *   --include-etfs dolicz ETF-y do uniwersum
 *   --verbose      wypisz ostrzeżenia i czasy per spółka
 *
 * UWAGA: ten skrypt nie ma KV, więc:
 *   - IV rank będzie pusty (brak historii),
 *   - deduplikacja alertów nie działa (alerty i tak nie są tu wysyłane).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { runScan, buildUniverse, readScanConfig } from '../src/core/scan.ts';
import { UNIVERSE_SNAPSHOT } from '../src/data/universe-snapshot.ts';
import type { Env, ScanResult } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const OUTPUT_DIR = join(ROOT, 'test-output');

/** Wczytuje .dev.vars (format KEY=value, komentarze #). */
function loadDevVars(): Record<string, string> {
  const path = join(ROOT, '.dev.vars');
  if (!existsSync(path)) {
    console.error(
      `\nBŁĄD: nie ma pliku .dev.vars w ${ROOT}\n\n` +
        'Utwórz go z kluczami API:\n\n' +
        '  FINNHUB_API_KEY=twoj_klucz\n' +
        '  TRADIER_API_KEY=twoj_klucz\n\n' +
        'Klucze: https://finnhub.io/register  oraz  https://developer.tradier.com/\n',
    );
    process.exit(1);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function pct(v: number | undefined, digits = 1): string {
  return v === undefined || !Number.isFinite(v) ? 'n/d' : `${(v * 100).toFixed(digits)}%`;
}

/** Wypisuje tabelę kandydatów w terminalu. */
function printTable(scan: ScanResult): void {
  console.log(
    `\nSkan: ${scan.asOf} | uniwersum ${scan.counts.universe} | w oknie alertu ${scan.counts.inAlertWindow} | ` +
      `przeanalizowane ${scan.counts.analyzed} | kandydaci ${scan.counts.candidates} | ${scan.durationMs} ms\n`,
  );

  if (scan.candidates.length === 0) {
    console.log('Brak kandydatów w oknie alertu.');
  } else {
    const header = [
      'SYMBOL'.padEnd(7),
      'OCENA'.padEnd(7),
      'WYNIKI'.padEnd(12),
      'T-'.padEnd(4),
      'FRONT'.padEnd(12),
      'D'.padEnd(4),
      'BACK'.padEnd(12),
      'IV F/B'.padEnd(13),
      'NACHYL.'.padEnd(9),
      'OI'.padEnd(7),
    ].join('');
    console.log(header);
    console.log('-'.repeat(header.length + 8));
    for (const c of scan.candidates) {
      const slope = c.termStructureSlope ?? 0;
      console.log(
        [
          c.symbol.padEnd(7),
          `${c.grade} ${String(c.score).padStart(3)}`.padEnd(7),
          c.earnings.date.padEnd(12),
          String(c.daysToEarnings).padEnd(4),
          (c.front?.expiration ?? 'n/d').padEnd(12),
          String(c.front?.dte ?? '').padEnd(4),
          (c.back?.expiration ?? 'n/d').padEnd(12),
          `${pct(c.front?.atmIv, 0)}/${pct(c.back?.atmIv, 0)}`.padEnd(13),
          `${slope >= 0 ? '+' : ''}${(slope * 100).toFixed(1)}pp`.padEnd(9),
          String(Math.min(c.front?.atmOpenInterest ?? 0, c.back?.atmOpenInterest ?? 0)).padEnd(7),
        ].join(''),
      );
      if (c.flags.length > 0) console.log(`         flagi: ${c.flags.join(' ')}`);
      for (const w of c.warnings) console.log(`         UWAGA: ${w}`);
    }
  }

  if (scan.watchlistOnly.length > 0) {
    console.log(`\nTylko obserwacja (${scan.watchlistOnly.length}):`);
    for (const w of scan.watchlistOnly.slice(0, 10)) {
      console.log(`  ${w.symbol.padEnd(7)} ${w.earningsDate}  T-${w.daysToEarnings}  ${w.reason}`);
    }
    if (scan.watchlistOnly.length > 10) console.log(`  ... i ${scan.watchlistOnly.length - 10} więcej`);
  }

  if (scan.errors.length > 0) {
    console.log(`\nBłędy (${scan.errors.length}):`);
    for (const e of scan.errors) console.log(`  - ${e}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantHtml = args.includes('--html');
  const wantJson = args.includes('--json');
  const verbose = args.includes('--verbose');
  const includeEtfs = args.includes('--include-etfs');
  const symbolsArg = args.find((a) => a.startsWith('--symbols='));

  const devVars = loadDevVars();

  const env: Env = {
    FINNHUB_API_KEY: devVars.FINNHUB_API_KEY,
    TRADIER_API_KEY: devVars.TRADIER_API_KEY,
    EARNINGS_PROVIDER: devVars.EARNINGS_PROVIDER ?? 'finnhub',
    OPTIONS_PROVIDER: devVars.OPTIONS_PROVIDER ?? 'tradier',
    TRADIER_ENV: devVars.TRADIER_ENV ?? 'sandbox',
    ALERT_MIN_DAYS: devVars.ALERT_MIN_DAYS ?? '25',
    ALERT_MAX_DAYS: devVars.ALERT_MAX_DAYS ?? '45',
    MAX_DEEP_ANALYSIS: devVars.MAX_DEEP_ANALYSIS ?? '25',
    MIN_OPEN_INTEREST: devVars.MIN_OPEN_INTEREST ?? '100',
    INCLUDE_ETFS: includeEtfs ? 'true' : (devVars.INCLUDE_ETFS ?? 'false'),
  };

  if (!env.FINNHUB_API_KEY) {
    console.error('BŁĄD: brak FINNHUB_API_KEY w .dev.vars');
    process.exit(1);
  }
  if (!env.TRADIER_API_KEY) {
    console.error('BŁĄD: brak TRADIER_API_KEY w .dev.vars');
    process.exit(1);
  }

  const cfg = readScanConfig(env);
  let universe = buildUniverse(cfg.includeEtfs);

  if (symbolsArg) {
    const wanted = new Set(
      symbolsArg
        .slice('--symbols='.length)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    universe = universe.filter((u) => wanted.has(u.symbol.toUpperCase()));
    // Dorzuć spółki spoza snapshotu, żeby dało się debugować dowolny ticker
    const known = new Set(universe.map((u) => u.symbol.toUpperCase()));
    for (const symbol of wanted) {
      if (!known.has(symbol)) {
        universe.push({ symbol, name: symbol, sector: 'nieznany', marketCapB: 0 });
      }
    }
    console.log(`Tryb debug: analizuję tylko ${universe.map((u) => u.symbol).join(', ')}`);
  } else {
    console.log(
      `Uniwersum: ${universe.length} instrumentów` +
        (cfg.includeEtfs ? ' (w tym ETF-y)' : '') +
        ` | okno alertu: ${cfg.alertMinDays}-${cfg.alertMaxDays} dni | głęboka analiza max ${cfg.maxDeepAnalysis}`,
    );
  }

  if (verbose) console.log('Start skanu...');
  const started = Date.now();
  const scan = await runScan(env, { universe });
  printTable(scan);

  if (wantJson || wantHtml) {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  if (wantJson) {
    const path = join(OUTPUT_DIR, 'scan.json');
    writeFileSync(path, JSON.stringify(scan, null, 2));
    console.log(`JSON zapisany: ${path}`);
  }

  if (wantHtml) {
    const { renderDashboard } = await import('../src/ui/dashboard.ts');
    const html = renderDashboard(scan, {
      asOf: scan.asOf,
      generatedAt: scan.generatedAt,
      optionsProvider: cfg.optionsProvider,
      earningsProvider: cfg.earningsProvider,
      tradierEnv: cfg.tradierEnv,
      usesKv: false,
      version: 'local',
      scan,
    });
    const path = join(OUTPUT_DIR, 'scan.html');
    writeFileSync(path, html);
    console.log(`Dashboard zapisany: ${path}  (otwórz w przeglądarce)`);
  }

  console.log(`Całkowity czas: ${Date.now() - started} ms`);

  // Kod wyjścia: 2, gdy były błędy (przydatne w CI)
  if (scan.errors.length > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error('\nSKAN NIE POWIÓDŁ SIĘ:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

// Odwołanie do snapshotu tylko po to, żeby liczba pozycji była widoczna w logu
void UNIVERSE_SNAPSHOT.length;
