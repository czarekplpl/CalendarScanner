/**
 * CLOUDFLARE WORKER — punkt wejścia
 * ================================
 *
 * Trasy:
 *   GET  /                     dashboard HTML (publiczny — nie zawiera sekretów)
 *   GET  /api/scan             ostatni wynik skanu (JSON); ?refresh=1 wymusza nowy
 *   GET  /api/health           diagnostyka konfiguracji (bez ujawniania sekretów)
 *   POST /scan                 ręczne uruchomienie; ?alerts=1 wysyła też alerty
 *   GET  /api/universe         aktualne uniwersum (do weryfikacji listy)
 *
 * Autoryzacja: /api/* oraz /scan wymagają nagłówka `x-api-key` (albo ?key=),
 * gdy REQUIRE_API_KEY=true. Dashboard zostaje publiczny, ale sam pobiera dane
 * z /api/scan, więc bez klucza pokaże tylko to, co jest w cache.
 *
 * Cron: [triggers] w wrangler.toml — dwa przebiegi dziennie w dni robocze.
 *   - przebieg wieczorny (21:10 UTC, po zamknięciu US)  -> skan + alerty
 *   - przebieg poranny  (11:10 UTC, przed otwarciem US) -> skan + alerty
 */

import { runScan, SCANNER_VERSION, readScanConfig } from './core/scan.ts';
import { archiveDailyScan, archiveSpan, loadArchiveIndex, loadArchivedScans } from './core/archive.ts';
import { CANDIDATE_COLUMNS, rowsFromScans, toCsv } from './core/dataset.ts';
import { checkD1Schema, writeScanToD1 } from './core/d1.ts';
import { dispatchAlerts } from './alerts/index.ts';
import { renderDashboard } from './ui/dashboard.ts';
import { UNIVERSE_SNAPSHOT } from './data/universe-snapshot.ts';
import { timeInNewYork, todayInNewYork } from './core/market.ts';
import type { Env, ScanResult } from './types.ts';

const LAST_SCAN_KEY = 'scan:last';
const LAST_SCAN_TTL = 14 * 24 * 3600;
const LAST_ALERT_ERRORS_KEY = 'alerts:lastErrors';
const LAST_ALERT_ERRORS_TTL = 7 * 24 * 3600;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' && request.method === 'GET') {
        return await handleDashboard(env);
      }
      if (path === '/api/health' && request.method === 'GET') {
        return json(await healthReport(env));
      }
      if (path === '/api/universe' && request.method === 'GET') {
        return json({ count: UNIVERSE_SNAPSHOT.length, universe: UNIVERSE_SNAPSHOT });
      }
      if (path.startsWith('/api/candidate/') && request.method === 'GET') {
        if (!authorized(request, env)) return unauthorized();
        return await handleCandidate(env, path.slice('/api/candidate/'.length));
      }
      if (path === '/api/export' && request.method === 'GET') {
        if (!authorized(request, env)) return unauthorized();
        return await handleExport(env, url);
      }
      if (path === '/api/scan' && (request.method === 'GET' || request.method === 'POST')) {
        if (!authorized(request, env)) return unauthorized();
        return await handleScan(request, env, ctx, url);
      }
      if (path === '/scan' && request.method === 'POST') {
        if (!authorized(request, env)) return unauthorized();
        return await handleScan(request, env, ctx, url, true);
      }
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }
      return json({ error: 'Nie znaleziono trasy', path }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Celowo nie logujemy zawartości env — mogłaby zawierać sekrety.
      console.error(`[scanner] błąd obsługi ${path}: ${message}`);
      return json({ error: 'Błąd wewnętrzny', message }, 500);
    }
  },

  /** Cron: skan + alerty. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const started = Date.now();
    console.log(`[scanner] cron start ${event.cron} (${new Date().toISOString()})`);
    try {
      const scan = await runScan(env);

      // Alerty PRZED zapisem skanu. Kolejność ma znaczenie: dispatchAlerts ustawia
      // scan.counts.alertsSent, więc zapis przed wysyłką utrwaliłby alertsSent=0
      // i dashboard pokazywałby "0 alertów" mimo wysłanych powiadomień.
      const dispatch = await dispatchAlerts(env, scan);

      // ZAPISY CZEKAMY, NIE waitUntil. Powód: `waitUntil` bywa przerywany, gdy
      // izolat zostanie zwolniony po zakończeniu żądania — a wtedy dane do
      // backtestu przepadają BEZ ŚLADU. Sprawdzone empirycznie: po skanie przez
      // API w KV i D1 nie było ANI JEDNEGO wiersza. Opóźnienie rzędu sekundy
      // jest nieistotne wobec utraty nieodtwarzalnych danych.
      await persistScan(env, scan, dispatch.errors);

      console.log(
        `[scanner] cron koniec: kandydaci=${scan.counts.candidates} alerty=${dispatch.sent} ` +
          `pominięte=${dispatch.skipped} błędy=${scan.errors.length + dispatch.errors.length} ` +
          `czas=${Date.now() - started}ms`,
      );
      for (const e of [...scan.errors, ...dispatch.errors].slice(0, 10)) {
        console.warn(`[scanner] ${e}`);
      }
    } catch (err) {
      console.error(`[scanner] cron FAILED: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

// ─────────────────────────────────────────────────────────────────────────────
// Handlery
// ─────────────────────────────────────────────────────────────────────────────

async function handleDashboard(env: Env): Promise<Response> {
  const scan = await loadScan(env);
  const html = renderDashboard(scan, {
    asOf: todayInNewYork(),
    generatedAt: scan?.generatedAt ?? new Date().toISOString(),
    optionsProvider: env.OPTIONS_PROVIDER ?? 'tradier',
    earningsProvider: env.EARNINGS_PROVIDER ?? 'finnhub',
    tradierEnv: env.TRADIER_ENV ?? 'sandbox',
    usesKv: Boolean(env.STATE),
    version: SCANNER_VERSION,
    scan,
  });
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function handleScan(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  forceAlerts = false,
): Promise<Response> {
  const refresh = url.searchParams.get('refresh') === '1' || forceAlerts;
  const wantsAlerts = forceAlerts || url.searchParams.get('alerts') === '1';

  let scan: ScanResult | undefined;
  if (!refresh) scan = await loadScan(env);

  let alertStats: Awaited<ReturnType<typeof dispatchAlerts>> | undefined;
  if (!scan || refresh) {
    scan = await runScan(env);
    if (wantsAlerts) {
      alertStats = await dispatchAlerts(env, scan);
    }
    // Ręczne uruchomienie MUSI zapisywać tak samo jak cron — wcześniej tego
    // brakowało i skan przez API nie trafiał ani do archiwum, ani do D1.
    await persistScan(env, scan, alertStats?.errors ?? []);
  }

  const cfg = readScanConfig(env);
  return json(
    {
      ...scan,
      meta: {
        version: SCANNER_VERSION,
        servedAt: new Date().toISOString(),
        newYorkTime: timeInNewYork(),
        fromCache: !refresh,
        usesKv: Boolean(env.STATE),
        alertChannels: (env.ALERT_CHANNELS ?? 'dashboard').split(',').map((s) => s.trim()),
        minOpenInterest: cfg.minOpenInterest,
        maxDeepAnalysis: cfg.maxDeepAnalysis,
      },
      ...(alertStats ? { alertDispatch: alertStats } : {}),
    },
    200,
  );
}

/**
 * Pojedynczy kandydat w formie potrzebnej do weryfikacji u brokera.
 *
 *   GET /api/candidate/NFLX
 *
 * PO CO: skrypt weryfikacyjny (scripts/verify_ibkr.py) potrzebuje DOKŁADNYCH nóg
 * — dat wygaśnięć i strike'u — żeby zapytać brokera o te same opcje, które
 * ocenił skaner. Bez tego skrypt musiałby zgadywać, a wtedy porównanie
 * „skaner vs broker" nie miałoby sensu.
 *
 * Zwracamy tylko to, co niezbędne do weryfikacji, plus kontekst z alertu.
 */
async function handleCandidate(env: Env, symbolRaw: string): Promise<Response> {
  const symbol = decodeURIComponent(symbolRaw).toUpperCase().trim();
  if (!symbol || symbol.length > 12) {
    return json({ error: 'Nieprawidłowy symbol', symbol }, 400);
  }

  const scan = await loadScan(env);
  if (!scan) {
    return json(
      { error: 'Brak wyniku skanu — uruchom najpierw /api/scan?refresh=1', symbol },
      404,
    );
  }

  const c = scan.candidates.find((x) => x.symbol.toUpperCase() === symbol);
  if (!c) {
    // Spółka może być na liście obserwacyjnej — wtedy podajemy powód, bo to
    // istotna informacja: „nie ma jej, bo brak płynności" to nie to samo co
    // „nie ma jej, bo nie raportuje w oknie".
    const w = scan.watchlistOnly.find((x) => x.symbol.toUpperCase() === symbol);
    return json(
      {
        error: w ? 'Spółka jest tylko na liście obserwacyjnej (brak danych do oceny)' : 'Spółki nie ma w bieżącym wyniku skanu',
        symbol,
        reason: w?.reason,
        asOf: scan.asOf,
        hint: 'Lista kandydatów: /api/scan',
      },
      404,
    );
  }

  return json({
    asOf: scan.asOf,
    generatedAt: scan.generatedAt,
    scannerVersion: scan.scannerVersion,
    optionsProvider: scan.config.optionsProvider,
    candidate: c,
    // Podpowiedź dla skryptu weryfikacyjnego: co dokładnie zapytać u brokera.
    legsToVerify: {
      front: c.front
        ? { expiration: c.front.expiration, strike: c.front.atmStrike ?? null, right: 'C' }
        : null,
      back: c.back
        ? { expiration: c.back.expiration, strike: c.back.atmStrike ?? null, right: 'C' }
        : null,
      note:
        'Strike jest wyliczony z kursu i interwału siatki. Jeśli w brokerze nie ma dokładnie ' +
        'takiego strike, skrypt sprawdzi najbliższy dostępny.',
    },
  });
}

/**
 * Eksport danych do backtestu.
 *
 *   GET /api/export              -> JSON z migawkami (domyślnie 60 dni)
 *   GET /api/export?format=csv   -> CSV wg schematu (gotowy do pandas/Excela)
 *   GET /api/export?format=info  -> co jest w archiwum, bez pobierania danych
 *   GET /api/export?from=&to=&limit=
 *
 * Domyślnie oddajemy NAJNOWSZE dni (limit 60). Rok danych to ~kilka MB JSON —
 * przy większych eksportach trzeba podnieść limit świadomie parametrem.
 */
async function handleExport(env: Env, url: URL): Promise<Response> {
  const format = (url.searchParams.get('format') ?? 'json').toLowerCase();
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit') ?? '60');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 400)) : 60;

  if (!env.STATE) {
    return json(
      {
        error: 'Brak namespace KV — archiwum nie działa',
        hint: 'Bez KV nie ma gdzie zapisywać migawek. Utwórz namespace i podepnij go w wrangler.toml (sekcja [[kv_namespaces]]).',
      },
      503,
    );
  }

  if (format === 'info') {
    const index = await loadArchiveIndex(env);
    const span = archiveSpan(index);
    const totalCandidates = index.days.reduce((sum, d) => sum + (d.candidates ?? 0), 0);
    return json({
      archivedDays: span.days,
      oldest: span.oldest ?? null,
      newest: span.newest ?? null,
      totalCandidatesArchived: totalCandidates,
      daysWithCandidates: index.days.filter((d) => (d.candidates ?? 0) > 0).length,
      recentDays: index.days.slice(-20),
      hint:
        span.days < 30
          ? 'Danych jest jeszcze mało — backtest ma sens po kilku miesiącach zbierania. Uruchom teraz archiwizację, żeby nie tracić kolejnych dni.'
          : 'Zakres pozwala już na wstępną analizę sezonową.',
    });
  }

  const { scans, missing, truncated } = await loadArchivedScans(env, { from, to, limit });
  const rows = rowsFromScans(scans);

  if (format === 'csv') {
    return new Response(toCsv(CANDIDATE_COLUMNS, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="candidates-${scans[0]?.asOf ?? 'brak'}_${scans[scans.length - 1]?.asOf ?? 'brak'}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return json({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    scansIncluded: scans.length,
    candidatesIncluded: rows.length,
    truncated,
    missingDates: missing,
    note: truncated
      ? `Zwrócono najnowsze ${limit} dni. Zwiększ ?limit= (max 400) albo zawęź ?from=/?to=, żeby pobrać więcej.`
      : 'Zwrócono wszystkie dni z zakresu.',
    scans,
  });
}

async function healthReport(env: Env): Promise<Record<string, unknown>> {
  const cfg = readScanConfig(env);
  const channels = (env.ALERT_CHANNELS ?? 'dashboard').split(',').map((s) => s.trim());
  const missing: string[] = [];
  if (!env.FINNHUB_API_KEY) {
    // Finnhub jest potrzebny zawsze: kalendarz wyników (dla spółek pominiętych
    // przez dostawcę opcji), historia wyników i KURSY AKCJI do wyboru strike ATM.
    missing.push('FINNHUB_API_KEY (kalendarz wyników + kursy akcji)');
  }
  // Sprawdzamy poświadczenia TEGO dostawcy opcji, który jest wybrany. Wcześniej
  // health zawsze pytał o TRADIER_API_KEY, więc konfiguracja na tastytrade
  // pokazywała fałszywy brak klucza.
  const wantsOptions = cfg.optionsProvider;
  if (wantsOptions === 'tastytrade') {
    if (!env.TASTYTRADE_CLIENT_SECRET || !env.TASTYTRADE_REFRESH_TOKEN) {
      missing.push('TASTYTRADE_CLIENT_SECRET + TASTYTRADE_REFRESH_TOKEN (dane opcyjne)');
    }
  } else if (!env.TRADIER_API_KEY) {
    missing.push('TRADIER_API_KEY (dane opcyjne)');
  }
  if (channels.includes('telegram') && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    missing.push('TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
  }
  if (channels.includes('email')) {
    // Kolejność musi odpowiadać wyborowi w `alerts/index.ts`: EMAIL_PROVIDER decyduje
    // o dostawcy, a przy dostawcy domyślnym (brak zmiennej) dopuszczamy zejście na
    // drugiego, jeśli tylko on ma klucz. Inaczej /api/health pokazuje „brakuje
    // RESEND_API_KEY” w konfiguracji, która wysyła przez Brevo (i odwrotnie).
    const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
    const hasEmailKey =
      provider === 'resend'
        ? Boolean(env.RESEND_API_KEY)
        : provider === 'brevo'
          ? Boolean(env.BREVO_API_KEY)
          : Boolean(env.BREVO_API_KEY || env.RESEND_API_KEY);
    if (!hasEmailKey) {
      // Przy Brevo nazywamy klucz po imieniu: najczęstsza pomyłka to wklejenie
      // klucza SMTP (xsmtpsib-), który z API v3 nie działa.
      missing.push(
        provider === 'resend'
          ? 'RESEND_API_KEY'
          : provider === 'brevo'
            ? 'BREVO_API_KEY (klucz API v3, nie SMTP)'
            : 'BREVO_API_KEY (klucz API v3, nie SMTP) albo RESEND_API_KEY',
      );
    }
    if (!env.ALERT_EMAIL_TO || !env.ALERT_EMAIL_FROM) {
      missing.push('ALERT_EMAIL_TO + ALERT_EMAIL_FROM');
    }
  }

  // `missing` = rzeczy, które użytkownik ma ustawić (sekrety). `notices` =
  // problemy infrastrukturalne (bindingi, uprawnienia). Rozdział jest istotny:
  // brak bindingu naprawia się w konfiguracji Workera, a nie komendą `secret put`,
  // więc podpowiedź „ustaw brakujące sekrety" byłaby myląca.
  const notices: string[] = [];
  if (!env.STATE) {
    notices.push(
      'Brak bindingu STATE (KV) — archiwum do backtestu i IV rank nie działają. ' +
        'Utwórz namespace i podepnij go w wrangler.toml (sekcja [[kv_namespaces]]).',
    );
  }
  if (!env.DB) {
    notices.push(
      'Brak bindingu DB (D1) — dane trafiają tylko do KV i eksportu CSV. ' +
        'Utwórz bazę (npx wrangler d1 create earnings-iv-scanner) i podepnij w [[d1_databases]].',
    );
  }

  return {
    ok: missing.length === 0,
    version: SCANNER_VERSION,
    asOf: todayInNewYork(),
    newYorkTime: timeInNewYork(),
    config: cfg,
    alertChannels: channels,
    state: env.STATE
      ? 'KV podpięte (IV rank, deduplikacja alertów i archiwum do backtestu działają)'
      : 'BRAK KV — IV rank, deduplikacja ORAZ ARCHIWUM DO BACKTESTU wyłączone. To krytyczne: bez KV dane przepadają.',
    d1: env.DB
      ? await checkD1Schema(env)
      : {
          ok: false,
          detail:
            'Brak bindingu DB — dane do backtestu trafiają tylko do KV i eksportu CSV. ' +
            'Żeby włączyć D1: utwórz bazę (npx wrangler d1 create earnings-iv-scanner), ' +
            'odkomentuj sekcję [[d1_databases]] w wrangler.toml i zastosuj schema.sql.',
        },
    archive: env.STATE
      ? await (async () => {
          const index = await loadArchiveIndex(env);
          const span = archiveSpan(index);
          return {
            days: span.days,
            oldest: span.oldest ?? null,
            newest: span.newest ?? null,
            note:
              span.days < 30
                ? 'Za mało dni na backtest — dane zbierają się od pierwszego przebiegu.'
                : 'Zakres pozwala na wstępną analizę.',
          };
        })()
      : null,
    universeSize: UNIVERSE_SNAPSHOT.length,
    missing,
    notices,
    nextSteps: missing.length > 0 ? 'Ustaw brakujące sekrety: npx wrangler secret put NAZWA' : 'Konfiguracja kompletna.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pomocnicze
// ─────────────────────────────────────────────────────────────────────────────

function authorized(request: Request, env: Env): boolean {
  if ((env.REQUIRE_API_KEY ?? 'true') !== 'true') return true;
  const expected = env.API_KEY;
  if (!expected) return true; // brak klucza w konfiguracji = brak ochrony (świadomy wybór)
  const provided =
    request.headers.get('x-api-key') ??
    new URL(request.url).searchParams.get('key') ??
    '';
  if (provided.length !== expected.length) return false;
  // Porównanie odporne na timing attack (choć ryzyko jest tu marginalne)
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return json(
    {
      error: 'Brak autoryzacji',
      hint: 'Dodaj nagłówek x-api-key (albo parametr ?key=). Klucz ustawiasz przez: npx wrangler secret put API_KEY',
    },
    401,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function loadScan(env: Env): Promise<ScanResult | undefined> {
  if (!env.STATE) return undefined;
  try {
    const raw = await env.STATE.get(LAST_SCAN_KEY, 'json');
    const scan = (raw as ScanResult | null) ?? undefined;
    if (!scan) return undefined;

    // Błędy wysyłki alertów trzymamy pod osobnym kluczem, bo powstają PO skanie.
    // Bez tego błąd typu "Telegram odrzucił wiadomość" byłby widoczny wyłącznie
    // w logach crona — a to najczęstsza cicha awaria w tym systemie.
    const errRaw = await env.STATE.get(LAST_ALERT_ERRORS_KEY, 'json');
    const alertErrors = (errRaw as { errors?: string[] } | null)?.errors;
    if (alertErrors && alertErrors.length > 0) {
      scan.errors = [...scan.errors, ...alertErrors.map((e) => `alert: ${e}`)];
    }
    return scan;
  } catch {
    return undefined;
  }
}

/**
 * Utrwala wynik skanu we WSZYSTKICH warstwach, w kolejności od najważniejszej:
 *
 *   1. Archiwum KV — nieodtwarzalne dane (term structure, IV rank, implied move
 *      z danego dnia). Bez tego backtest po fakcie jest niemożliwy.
 *   2. D1 — warstwa analityczna (SQL).
 *   3. "Ostatni skan" — to, co pokazuje dashboard.
 *   4. Błędy alertów — żeby cicha awaria wysyłki była widoczna.
 *
 * Wołane przez cron ORAZ przez /api/scan. Wcześniej /api/scan nie zapisywał
 * niczego poza "ostatnim skanem", więc ręczne uruchomienie nie zbierało danych
 * do backtestu — a to najgorszy rodzaj błędu, bo cichy i nieodwracalny.
 */
async function persistScan(env: Env, scan: ScanResult, alertErrors: string[]): Promise<void> {
  await archiveDailyScan(env, scan);

  const d1 = await writeScanToD1(env, scan);
  if (d1.attempted && d1.skippedReason) {
    console.warn(`[scanner] D1: ${d1.skippedReason}`);
  } else if (d1.attempted) {
    console.log(`[scanner] D1: kandydaci=${d1.candidatesWritten} watchlist=${d1.watchlistWritten}`);
  }

  await storeScan(env, scan);
  await storeAlertErrors(env, alertErrors);
}

async function storeScan(env: Env, scan: ScanResult): Promise<void> {
  if (!env.STATE) return;
  try {
    await env.STATE.put(LAST_SCAN_KEY, JSON.stringify(scan), { expirationTtl: LAST_SCAN_TTL });
  } catch (err) {
    console.warn(`[scanner] nie udało się zapisać skanu: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Zapisuje błędy wysyłki alertów, żeby były widoczne w dashboardzie i /api/scan.
 * Powód: błąd dostarczenia powiadomienia jest CICHY — bez tego myślałbyś, że
 * alerty działają, podczas gdy Telegram odrzuca wiadomości (zły chat_id, bot
 * zablokowany przez użytkownika). Zapis pustej listy czyści poprzednie błędy.
 */
async function storeAlertErrors(env: Env, errors: string[]): Promise<void> {
  if (!env.STATE) return;
  try {
    await env.STATE.put(LAST_ALERT_ERRORS_KEY, JSON.stringify({ at: new Date().toISOString(), errors }), {
      expirationTtl: LAST_ALERT_ERRORS_TTL,
    });
  } catch {
    /* best-effort */
  }
}
