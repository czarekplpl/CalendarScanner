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

      // Archiwum PRZED wszystkim innym: to jedyny nieodwracalny krok. Jeśli
      // alerty albo zapis "ostatniego skanu" padną, migawka dnia i tak zostanie.
      ctx.waitUntil(archiveDailyScan(env, scan));

      // D1 (baza pod backtest) — po archiwum KV, bo KV jest źródłem prawdy,
      // a D1 warstwą analityczną. Awaria D1 nie przerywa skanu.
      ctx.waitUntil(
        writeScanToD1(env, scan).then((r) => {
          if (r.attempted) {
            console.log(`[scanner] D1: kandydaci=${r.candidatesWritten} watchlist=${r.watchlistWritten}`);
          } else if (r.skippedReason) {
            console.log(`[scanner] D1 pominięte: ${r.skippedReason}`);
          }
        }),
      );

      // Alerty PRZED zapisem skanu. Kolejność ma znaczenie: dispatchAlerts ustawia
      // scan.counts.alertsSent, więc zapis przed wysyłką utrwaliłby alertsSent=0
      // i dashboard pokazywałby "0 alertów" mimo wysłanych powiadomień.
      const dispatch = await dispatchAlerts(env, scan);
      ctx.waitUntil(storeScan(env, scan));
      ctx.waitUntil(storeAlertErrors(env, dispatch.errors));

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
    ctx.waitUntil(storeScan(env, scan));
    if (wantsAlerts) {
      alertStats = await dispatchAlerts(env, scan);
    }
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
  if (!env.FINNHUB_API_KEY) missing.push('FINNHUB_API_KEY (kalendarz wyników)');
  if (!env.TRADIER_API_KEY) missing.push('TRADIER_API_KEY (łańcuchy opcji)');
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
