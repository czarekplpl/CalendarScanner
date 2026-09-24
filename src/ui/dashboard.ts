/**
 * DASHBOARD SKANERA — kompletny, samodzielny dokument HTML
 * ========================================================
 *
 * Worker serwuje ten dokument pod trasą `/`. Dokument jest w 100% offline:
 * zero CDN, zero `<script src>`, zero `<link href="http...">`, zero web-fontów.
 * Cały CSS i cały JS siedzą inline, a wynik skanu jest osadzony w
 * `<script type="application/json" id="scan-data">` (z `<` zamienionym na `\u003c`,
 * żeby nie dało się domknąć taga danymi).
 *
 * Zasady, których ten plik pilnuje:
 *  1. Każda wartość pochodząca z danych (nazwa spółki, sektor, noty, ostrzeżenia,
 *     powody z watchlistOnly, błędy, flagi) przechodzi przez `esc()` — żadnego
 *     surowego HTML-a z danych.
 *  2. Brak danych (`scan === undefined`) i pusta lista kandydatów to normalne stany,
 *     nie błędy — mają własne, czytelne komunikaty.
 *  3. Filtrowanie i sortowanie dzieje się po stronie klienta, bez przeładowania.
 *  4. Klucz API żyje wyłącznie w `localStorage['scanner_api_key']` i leci wyłącznie
 *     jako nagłówek `x-api-key` do `/api/scan?refresh=1` — nigdzie indziej i nigdy
 *     do logów.
 *
 * Plik nie importuje niczego poza typami (import type) i nie ma żadnych zależności
 * runtime — dzięki temu działa w Cloudflare Workers bez bundlowania.
 */

import type {
  CalendarCandidate,
  EarningsEvent,
  EarningsTiming,
  IvPoint,
  ScanResult,
  ScoreComponent,
} from '../types.ts';

export interface DashboardMeta {
  /** Data sesyjna, dla której policzono skan, np. "2026-09-24" */
  asOf: string;
  /** ISO, np. "2026-09-24T21:10:04.512Z" */
  generatedAt: string;
  /** "tradier" */
  optionsProvider: string;
  /** "finnhub" */
  earningsProvider: string;
  /** "sandbox" | "production" */
  tradierEnv: string;
  /** Czy historia IV / deduplikacja alertów działa (KV podpięte) */
  usesKv: boolean;
  /** np. "1.0.0" */
  version: string;
  /** Pełny wynik skanu (ScanResult) — może być undefined przed pierwszym przebiegiem */
  scan?: unknown;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  WEJŚCIE
 * ──────────────────────────────────────────────────────────────────────────── */

/** Zwraca KOMPLETNY dokument HTML (od `<!DOCTYPE html>`) dla dashboardu. */
export function renderDashboard(scan: unknown, meta: DashboardMeta): string {
  // Skan może przyjść pierwszym argumentem albo siedzieć w `meta.scan` — obsługujemy oba warianty.
  const fromMeta = readMetaScan(meta);
  const source: unknown = scan === undefined || scan === null ? fromMeta : scan;
  const result = normalizeScan(source) ?? (source === fromMeta ? undefined : normalizeScan(fromMeta));
  const view = buildViewMeta(meta, result);
  const body = result ? renderBody(result, view) : renderNoDataState();

  const rawJson = safeJson(source);
  const embeddedScan = rawJson ?? safeJson(fromMeta) ?? safeJson(result ?? null) ?? 'null';
  const embeddedMeta = safeJson(view) ?? '{}';

  return [
    '<!DOCTYPE html>',
    '<html lang="pl">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="color-scheme" content="dark">',
    '<title>Skaner wyników — kalendarze na ekspansję IV</title>',
    '<style>',
    STYLES,
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    renderHeader(view, result),
    renderCards(result),
    body,
    renderFooter(view, result),
    '</div>',
    '<script type="application/json" id="scan-data">',
    escapeJsonForScript(embeddedScan),
    '</script>',
    '<script type="application/json" id="meta-data">',
    escapeJsonForScript(embeddedMeta),
    '</script>',
    '<script>',
    CLIENT_SCRIPT,
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 *  SEKCJE
 * ──────────────────────────────────────────────────────────────────────────── */

function renderHeader(view: ViewMeta, scan: ScanResult | undefined): string {
  const parts: string[] = [];
  parts.push('<header class="top">');
  parts.push('<div class="top-grid">');
  parts.push('<div class="brand">');
  parts.push('<h1>Skaner wyników — kalendarze na ekspansję IV</h1>');
  parts.push(
    '<p class="sub">Duże spółki US na ' +
      alertWindowLabel(scan) +
      ' dni przed publikacją wyników, oceniane pod long calendar spread.</p>',
  );
  parts.push('</div>');
  parts.push('<div class="stamp">');
  parts.push('<div class="stamp-row"><span class="stamp-k">Sesja</span><span class="mono">' + esc(view.asOf || DASH) + '</span></div>');
  parts.push(
    '<div class="stamp-row"><span class="stamp-k">Wygenerowano</span><span class="mono">' +
      esc(formatIsoUtc(view.generatedAt)) +
      '</span></div>',
  );
  parts.push('</div>');
  parts.push('</div>');

  parts.push('<div class="chips">');
  parts.push(chip('Opcje: ' + view.optionsProvider, 'muted'));
  parts.push(chip('Wyniki: ' + view.earningsProvider, 'muted'));
  parts.push(chip('Środowisko: ' + view.tradierEnv, view.delayed ? 'warn' : 'ok'));
  parts.push(
    view.usesKv
      ? chip('Historia IV: KV aktywne', 'ok')
      : chip('Historia IV: brak KV', 'warn'),
  );
  parts.push(chip('v' + view.version, 'muted'));
  parts.push('</div>');

  if (view.delayed) {
    parts.push(
      '<p class="notice warn"><strong>Dane opcyjne z sandboxa Tradier są opóźnione o 15 minut.</strong> ' +
        'To nie jest real-time — kwotowania służą do oceny struktury, nie do składania zleceń po tych cenach.</p>',
    );
  } else if (view.unknownEnv) {
    parts.push(
      '<p class="notice warn">Nieznane środowisko danych opcyjnych (' +
        esc(view.tradierEnv) +
        '). Nie zakładaj, że kwotowania są real-time.</p>',
    );
  } else {
    parts.push('<p class="notice ok">Dane opcyjne: Tradier production (real-time).</p>');
  }

  if (!view.usesKv) {
    parts.push(
      '<p class="notice info">KV nie jest podpięte: IV rank będzie niedostępny („brak historii”), ' +
        'a alerty nie mają deduplikacji między przebiegami.</p>',
    );
  }

  if (scan && scan.errors.length > 0) {
    parts.push(
      '<p class="notice warn">Przebieg zakończył się z ' +
        esc(String(scan.errors.length)) +
        ' ' +
        pluralPl(scan.errors.length, 'błędem', 'błędami', 'błędami') +
        ' — szczegóły na dole strony.</p>',
    );
  }

  parts.push('</header>');
  return parts.join('\n');
}

/** Etykieta okna alertu, np. "25–45" — do zdania w nagłówku. */
function alertWindowLabel(scan: ScanResult | undefined): string {
  if (!scan) return '~30';
  const min = scan.config.alertMinDays;
  const max = scan.config.alertMaxDays;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '~30';
  if (min === max) return String(min);
  return min + '–' + max;
}

function renderCards(scan: ScanResult | undefined): string {
  const c = scan?.counts;
  const cards: Array<{ k: string; v: string; hint?: string }> = [
    { k: 'Uniwersum', v: c ? fmtInt(c.universe) : DASH, hint: 'spółek w skanie' },
    { k: 'Z nadchodzącymi wynikami', v: c ? fmtInt(c.withUpcomingEarnings) : DASH },
    { k: 'W oknie alertu', v: c ? fmtInt(c.inAlertWindow) : DASH, hint: scan ? scan.config.alertMinDays + '–' + scan.config.alertMaxDays + ' dni' : undefined },
    { k: 'Przeanalizowane', v: c ? fmtInt(c.analyzed) : DASH, hint: 'z pełnym łańcuchem opcji' },
    { k: 'Kandydaci', v: c ? fmtInt(c.candidates) : DASH, hint: 'przeszli ocenę' },
    { k: 'Alerty wysłane', v: c ? fmtInt(c.alertsSent) : DASH },
    { k: 'Czas skanu', v: scan ? formatDuration(scan.durationMs) : DASH },
  ];

  const out: string[] = ['<section class="cards" aria-label="Podsumowanie skanu">'];
  for (const card of cards) {
    out.push('<div class="card">');
    out.push('<div class="k">' + esc(card.k) + '</div>');
    out.push('<div class="v mono">' + esc(card.v) + '</div>');
    if (card.hint) out.push('<div class="h">' + esc(card.hint) + '</div>');
    out.push('</div>');
  }
  out.push('</section>');
  return out.join('\n');
}

function renderBody(scan: ScanResult, view: ViewMeta): string {
  const out: string[] = [];
  out.push(renderControls(scan, true));
  out.push(renderCandidateTable(scan, view));
  out.push(renderWatchlist(scan));
  out.push(renderErrors(scan));
  return out.join('\n');
}

function renderNoDataState(): string {
  return [
    '<section class="panel">',
    '<div class="empty">',
    '<h2>Brak danych skanu</h2>',
    '<p>Brak danych — poczekaj na pierwszy przebieg cron albo użyj przycisku <strong>Odśwież</strong> ' +
      '(wymaga klucza API, jeśli worker ma włączone <span class="mono">REQUIRE_API_KEY</span>).</p>',
    '<p class="dim">Pierwszy przebieg pobiera kalendarz wyników, łańcuchy opcji i buduje historię IV — ' +
      'przy 200 spółkach w uniwersum potrafi to zająć kilkadziesiąt sekund.</p>',
    '</div>',
    '</section>',
    renderControls(undefined, false),
  ].join('\n');
}

function renderControls(scan: ScanResult | undefined, withFilters: boolean): string {
  const out: string[] = [];
  out.push('<section class="panel controls" aria-label="Filtry i odświeżanie">');

  if (withFilters) {
    out.push('<div class="controls-grid">');

    out.push('<div class="field">');
    out.push('<label for="f-query">Ticker lub nazwa</label>');
    out.push('<input type="search" id="f-query" placeholder="np. NKE" autocomplete="off" spellcheck="false">');
    out.push('</div>');

    out.push('<div class="field">');
    out.push('<label for="f-grade">Grade</label>');
    out.push('<select id="f-grade">');
    out.push('<option value="all">wszystkie</option>');
    out.push('<option value="A">A</option>');
    out.push('<option value="B">B</option>');
    out.push('<option value="C">C</option>');
    out.push('<option value="D">D</option>');
    out.push('</select>');
    out.push('</div>');

    out.push('<div class="field field-wide">');
    out.push('<label for="f-score">Minimalny score: <output id="f-score-value" for="f-score">0</output></label>');
    out.push('<input type="range" id="f-score" min="0" max="100" step="1" value="0">');
    out.push('</div>');

    out.push('<div class="field field-check">');
    out.push('<label class="check"><input type="checkbox" id="f-confirmed"> tylko potwierdzone daty</label>');
    out.push('<label class="check"><input type="checkbox" id="f-optimal"> tylko ze strefą optymalną</label>');
    out.push('</div>');

    out.push('<div class="field field-actions">');
    out.push('<button type="button" class="btn ghost" id="f-reset">Wyczyść filtry</button>');
    out.push('<button type="button" class="btn primary" id="btn-refresh">Odśwież</button>');
    out.push('</div>');

    out.push('</div>');

    const total = scan ? String(scan.candidates.length) : '0';
    out.push('<div class="controls-foot">');
    out.push(
      '<span class="counts">Widoczne: <span class="mono" id="visible-count">' +
        esc(total) +
        ' z ' +
        esc(total) +
        '</span></span>',
    );
    out.push('<span class="status" id="status" role="status" aria-live="polite"></span>');
    out.push('</div>');
  } else {
    out.push('<div class="controls-grid controls-grid-simple">');
    out.push('<div class="field field-actions">');
    out.push('<button type="button" class="btn primary" id="btn-refresh">Odśwież</button>');
    out.push('</div>');
    out.push('</div>');
    out.push('<div class="controls-foot">');
    out.push('<span class="status" id="status" role="status" aria-live="polite"></span>');
    out.push('</div>');
  }

  out.push('<details class="key-box" id="key-box">');
  out.push('<summary>Klucz API (nagłówek <span class="mono">x-api-key</span>)</summary>');
  out.push('<div class="key-body">');
  out.push('<input type="password" id="api-key" placeholder="wklej klucz API" autocomplete="off" spellcheck="false" aria-label="Klucz API">');
  out.push(
    '<p class="dim">Klucz jest trzymany wyłącznie w tej przeglądarce (<span class="mono">localStorage.scanner_api_key</span>) ' +
      'i wysyłany wyłącznie do <span class="mono">/api/scan?refresh=1</span> jako nagłówek <span class="mono">x-api-key</span>. ' +
      'Nigdzie indziej, nigdy w URL-u, nigdy w logach.</p>',
  );
  out.push('</div>');
  out.push('</details>');

  out.push('</section>');
  return out.join('\n');
}

function renderCandidateTable(scan: ScanResult, view: ViewMeta): string {
  const out: string[] = [];
  const count = scan.candidates.length;

  out.push('<section class="panel" aria-label="Kandydaci">');
  out.push('<div class="panel-head">');
  out.push('<h2 class="panel-title">Kandydaci</h2>');
  if (count === 0) {
    out.push('<span class="panel-sub">nic do pokazania w tym przebiegu</span>');
  } else {
    out.push(
      '<span class="panel-sub">' +
        esc(String(count)) +
        ' ' +
        pluralPl(count, 'spółka', 'spółki', 'spółek') +
        ' · kliknij wiersz, żeby rozwinąć rozbicie punktacji</span>',
    );
  }
  out.push('</div>');

  if (count === 0) {
    out.push('<div class="empty">');
    out.push('<h3>W oknie ' + esc(String(scan.config.alertMinDays)) + '–' + esc(String(scan.config.alertMaxDays)) + ' dni nie ma teraz nic sensownego</h3>');
    out.push(
      '<p>Żadna spółka nie przeszła oceny pod long calendar. Poza sezonem wyników to normalne — ' +
        'kalendarz na ekspansję IV potrzebuje publikacji tuż po wygaśnięciu frontu, a takich okien ' +
        'jest w roku kilka na spółkę. Kolejny przebieg cron sprawdzi nowe daty.</p>',
    );
    out.push('</div>');
    out.push('</section>');
    return out.join('\n');
  }

  out.push('<div class="table-wrap">');
  out.push('<table class="grid" id="cand-table">');
  out.push('<thead><tr>');
  out.push(th('Spółka', 'symbol', 'left'));
  out.push(th('Score', 'score', 'num'));
  out.push(th('Wyniki', 'date', 'left'));
  out.push(th('Spot', 'spot', 'num'));
  out.push(th('Nogi (front → back)', undefined, 'left'));
  out.push(th('IV front / back', 'iv', 'num'));
  out.push(th('Term structure', 'slope', 'num'));
  out.push(th('Implied vs hist.', 'move', 'num'));
  out.push(th('IV rank', 'ivrank', 'num'));
  out.push(th('OI / spread ATM', 'oi', 'num'));
  out.push(th('Wejście', 'entry', 'left'));
  out.push(th('Flagi', undefined, 'left'));
  out.push('</tr></thead>');

  out.push('<tbody>');
  for (let i = 0; i < count; i += 1) {
    const candidate = scan.candidates[i];
    if (!candidate) continue;
    out.push(renderCandidateRow(candidate, i, view));
    out.push(renderCandidateDetail(candidate, i));
  }
  out.push('</tbody>');
  out.push('</table>');
  out.push('</div>');

  out.push(
    '<p class="filter-none" id="filter-none" hidden>Żaden kandydat nie spełnia ustawionych filtrów. ' +
      'Wyczyść filtry, żeby wrócić do pełnej listy.</p>',
  );

  out.push('</section>');
  return out.join('\n');
}

function renderCandidateRow(c: CalendarCandidate, index: number, view: ViewMeta): string {
  const front = c.front;
  const back = c.back;
  const minOi = minDefined(front?.atmOpenInterest, back?.atmOpenInterest);
  const worstSpread = maxDefined(front?.atmSpreadPct, back?.atmSpreadPct);
  const flags = c.flags;
  const isOptimal = flags.indexOf('STREFA-OPTYMALNA') >= 0;

  const dataAttrs: string[] = [
    attr('data-idx', String(index)),
    attr('data-symbol', c.symbol),
    attr('data-name', c.name ?? ''),
    attr('data-sector', c.sector ?? ''),
    attr('data-grade', c.grade),
    attr('data-score', dataNum(c.score)),
    attr('data-date', c.earnings.date),
    attr('data-days', dataNum(c.daysToEarnings)),
    attr('data-spot', dataNum(c.spot)),
    attr('data-iv', dataNum(front?.atmIv)),
    attr('data-slope', dataNum(c.termStructureSlope)),
    attr('data-move', dataNum(front?.impliedMovePct)),
    attr('data-ivrank', dataNum(c.ivRank)),
    attr('data-oi', dataNum(minOi)),
    attr('data-entry', c.suggestedEntryDate ?? ''),
    attr('data-confirmed', c.earnings.confirmed ? '1' : '0'),
    attr('data-optimal', isOptimal ? '1' : '0'),
  ];

  const out: string[] = [];
  out.push(
    '<tr class="row" tabindex="0" role="button" aria-expanded="false" aria-controls="detail-' +
      esc(String(index)) +
      '"' +
      dataAttrs.join('') +
      '>',
  );

  /* ── Spółka ─────────────────────────────────────────────────────────── */
  out.push('<td class="c-sym">');
  out.push('<div class="sym mono">' + esc(c.symbol) + '</div>');
  if (c.name) out.push('<div class="sym-name">' + esc(c.name) + '</div>');
  if (c.sector) out.push('<div class="sym-sector">' + esc(c.sector) + '</div>');
  out.push('</td>');

  /* ── Score + grade ──────────────────────────────────────────────────── */
  out.push('<td class="num c-score">');
  out.push(
    '<span class="score g-' +
      esc(c.grade) +
      '" title="Score ' +
      esc(fmtPoints(c.score)) +
      '/100, grade ' +
      esc(c.grade) +
      '"><b>' +
      esc(fmtPoints(c.score)) +
      '</b><i>' +
      esc(c.grade) +
      '</i></span>',
  );
  out.push('</td>');

  /* ── Wyniki ─────────────────────────────────────────────────────────── */
  out.push('<td class="c-earn">');
  out.push('<div class="strong mono">' + esc(fmtDatePl(c.earnings.date)) + '</div>');
  const hasDays = Number.isFinite(c.daysToEarnings);
  const hasTradingDays = Number.isFinite(c.tradingDaysToEarnings);
  out.push(
    '<div class="sub mono">' +
      (hasDays ? 'T-' + esc(fmtInt(c.daysToEarnings)) : '<span class="dim">T-?</span>') +
      (hasTradingDays
        ? '<span class="dim"> · ' + esc(fmtInt(c.tradingDaysToEarnings)) + ' dni ses.</span>'
        : '') +
      '</div>',
  );
  out.push('<div class="tags">');
  if (c.earnings.timing === 'bmo') {
    out.push('<span class="tag tag-bmo" title="przed otwarciem sesji (before market open)">BMO</span>');
  } else if (c.earnings.timing === 'amc') {
    out.push('<span class="tag tag-amc" title="po zamknięciu sesji (after market close)">AMC</span>');
  } else {
    out.push('<span class="tag tag-unknown" title="dostawca nie podał pory publikacji">pora nieznana</span>');
  }
  out.push(
    c.earnings.confirmed
      ? '<span class="tag tag-ok">potwierdzona</span>'
      : '<span class="tag tag-warn">niepotwierdzona</span>',
  );
  out.push('</div>');
  out.push('</td>');

  /* ── Spot ───────────────────────────────────────────────────────────── */
  out.push('<td class="num mono">' + esc(fmtPrice(c.spot)) + '</td>');

  /* ── Nogi ───────────────────────────────────────────────────────────── */
  out.push('<td class="c-legs">');
  if (front) {
    out.push(
      '<div class="leg"><span class="leg-tag">front</span><span class="mono">' +
        esc(fmtDatePl(front.expiration)) +
        '</span><span class="dim mono">' +
        esc(fmtInt(front.dte)) +
        ' DTE</span></div>',
    );
  } else {
    out.push('<div class="leg"><span class="leg-tag">front</span><span class="dim">brak danych</span></div>');
  }
  if (back) {
    out.push(
      '<div class="leg"><span class="leg-tag">back</span><span class="mono">' +
        esc(fmtDatePl(back.expiration)) +
        '</span><span class="dim mono">' +
        esc(fmtInt(back.dte)) +
        ' DTE</span></div>',
    );
  } else {
    out.push('<div class="leg"><span class="leg-tag">back</span><span class="dim">brak danych</span></div>');
  }
  out.push('<div class="leg-note">' + esc(describeFrontGap(front)) + '</div>');
  out.push(
    '<div class="leg-note dim">front IV: ' +
      esc(front ? ivSourceLabel(front.ivSource) : DASH) +
      ' · back IV: ' +
      esc(back ? ivSourceLabel(back.ivSource) : DASH) +
      '</div>',
  );
  out.push('</td>');

  /* ── IV front / back ────────────────────────────────────────────────── */
  out.push('<td class="num">');
  out.push(
    '<span class="mono">' +
      esc(fmtPct(front?.atmIv)) +
      '</span><span class="dim"> / </span><span class="mono">' +
      esc(fmtPct(back?.atmIv)) +
      '</span>',
  );
  if (c.termStructureRatio !== undefined && Number.isFinite(c.termStructureRatio)) {
    out.push('<div class="sub dim mono">ratio ' + esc(c.termStructureRatio.toFixed(3)) + '</div>');
  }
  out.push('</td>');

  /* ── Term structure ─────────────────────────────────────────────────── */
  out.push('<td class="num">');
  out.push('<span class="' + signClass(c.termStructureSlope) + ' mono">' + esc(fmtSignedPp(c.termStructureSlope)) + '</span>');
  out.push('</td>');

  /* ── Implied vs historyczny ruch ────────────────────────────────────── */
  out.push('<td class="num">');
  out.push('<span class="mono">' + esc(fmtPct(front?.impliedMovePct)) + '</span>');
  out.push('<span class="dim"> vs </span>');
  out.push('<span class="mono">' + esc(fmtPct(c.avgHistoricalMovePct)) + '</span>');
  out.push('<div class="sub ' + moveRelationClass(c) + '">' + esc(moveRelationLabel(c)) + '</div>');
  out.push('</td>');

  /* ── IV rank ────────────────────────────────────────────────────────── */
  out.push('<td class="num">');
  if (c.ivRank !== undefined && Number.isFinite(c.ivRank)) {
    out.push('<span class="mono">' + esc(fmtInt(c.ivRank)) + '</span>');
    out.push('<div class="bar-mini" title="IV rank ' + esc(fmtInt(c.ivRank)) + '/100"><span class="' + rankClass(c.ivRank) + '" style="width:' + esc(String(clampPct(c.ivRank))) + '%"></span></div>');
  } else {
    out.push('<span class="dim">brak historii</span>');
  }
  out.push('</td>');

  /* ── Płynność ───────────────────────────────────────────────────────── */
  out.push('<td class="num">');
  if (minOi !== undefined) {
    out.push('<span class="mono" title="min(front, back) open interest na strike ATM">' + esc(fmtInt(minOi)) + '</span>');
  } else {
    out.push('<span class="dim">' + DASH + '</span>');
  }
  out.push('<div class="sub mono' + spreadToneClass(worstSpread) + '">' + esc(fmtPct(worstSpread, 1)) + ' <span class="dim">spread</span></div>');
  out.push('</td>');

  /* ── Sugerowane wejście ─────────────────────────────────────────────── */
  out.push('<td class="c-entry">');
  if (c.suggestedEntryDate) {
    out.push('<div class="mono">' + esc(fmtDatePl(c.suggestedEntryDate)) + '</div>');
    const delta = daysBetween(view.asOf, c.suggestedEntryDate);
    if (delta !== undefined) {
      out.push('<div class="sub dim mono">' + esc(describeEntryDelta(delta)) + '</div>');
    }
  } else {
    out.push('<span class="dim">' + DASH + '</span>');
  }
  out.push('</td>');

  /* ── Flagi ──────────────────────────────────────────────────────────── */
  out.push('<td class="c-flags">');
  if (flags.length === 0) {
    out.push('<span class="dim">brak flag</span>');
  } else {
    for (const flag of flags) {
      out.push(chip(flag, flagTone(flag)));
    }
  }
  if (c.warnings.length > 0) {
    out.push(
      '<span class="warn-pill" title="' +
        esc(c.warnings.join(' | ')) +
        '">' +
        esc(String(c.warnings.length)) +
        ' ' +
        esc(pluralPl(c.warnings.length, 'ostrzeżenie', 'ostrzeżenia', 'ostrzeżeń')) +
        '</span>',
    );
  }
  out.push('</td>');

  out.push('</tr>');
  return out.join('\n');
}

function renderCandidateDetail(c: CalendarCandidate, index: number): string {
  const out: string[] = [];
  out.push('<tr class="detail" id="detail-' + esc(String(index)) + '" data-for="' + esc(String(index)) + '" hidden>');
  out.push('<td colspan="12">');
  out.push('<div class="detail-grid">');

  /* ── kolumna 1: punktacja ───────────────────────────────────────────── */
  out.push('<div class="detail-col">');
  out.push('<h4>Rozbicie punktacji</h4>');
  if (c.components.length === 0) {
    out.push('<p class="dim">Brak rozbicia punktacji w danych skanu.</p>');
  } else {
    for (const component of c.components) {
      out.push(renderComponent(component));
    }
  }
  out.push('</div>');

  /* ── kolumna 2: interpretacja ───────────────────────────────────────── */
  out.push('<div class="detail-col">');

  out.push('<h4>Co to znaczy</h4>');
  const meanings = explainFlags(c.flags);
  if (meanings.length === 0) {
    out.push(
      '<p class="dim">Brak wyróżniających flag — ocena wynika wyłącznie z rozbicia punktacji obok. ' +
        'Sprawdź układ nóg i płynność przed decyzją.</p>',
    );
  } else {
    out.push('<ul class="meaning">');
    for (const m of meanings) {
      out.push('<li>' + esc(m) + '</li>');
    }
    out.push('</ul>');
  }

  if (c.warnings.length > 0) {
    out.push('<h4 class="warn-head">Ostrzeżenia</h4>');
    out.push('<div class="warn-box">');
    for (const warning of c.warnings) {
      out.push('<div class="warn-item">' + esc(warning) + '</div>');
    }
    out.push('</div>');
  }

  out.push('<h4>Szczegóły nóg i zdarzenia</h4>');
  out.push(renderLegsTable(c));

  out.push('</div>');
  out.push('</div>');
  out.push('</td>');
  out.push('</tr>');
  return out.join('\n');
}

function renderComponent(component: ScoreComponent): string {
  const max = component.maxPoints;
  const ratio = max > 0 ? clampPct((component.points / max) * 100) : 0;
  const out: string[] = [];
  out.push('<div class="comp">');
  out.push('<div class="comp-head">');
  out.push('<span class="comp-label">' + esc(component.label) + '</span>');
  out.push(
    '<span class="comp-pts mono">' + esc(fmtPoints(component.points)) + '<span class="dim"> / ' + esc(fmtPoints(max)) + '</span></span>',
  );
  out.push('</div>');
  out.push('<div class="bar"><span class="' + barTone(ratio) + '" style="width:' + esc(String(ratio)) + '%"></span></div>');
  if (component.note) out.push('<p class="comp-note">' + esc(component.note) + '</p>');
  out.push('</div>');
  return out.join('\n');
}

function renderLegsTable(c: CalendarCandidate): string {
  const front = c.front;
  const back = c.back;
  const rows: Array<[string, string, string]> = [
    ['Wygaśnięcie', fmtDatePl(front?.expiration), fmtDatePl(back?.expiration)],
    ['DTE', fmtInt(front?.dte), fmtInt(back?.dte)],
    ['Dni od wygaśnięcia do wyników', fmtInt(front?.daysToEarnings), fmtInt(back?.daysToEarnings)],
    ['IV ATM', fmtPct(front?.atmIv), fmtPct(back?.atmIv)],
    ['Straddle mid', fmtPrice(front?.straddleMid), fmtPrice(back?.straddleMid)],
    ['Implied move', fmtPct(front?.impliedMovePct), fmtPct(back?.impliedMovePct)],
    ['OI ATM', fmtInt(front?.atmOpenInterest), fmtInt(back?.atmOpenInterest)],
    ['Spread ATM (% mid)', fmtPct(front?.atmSpreadPct, 1), fmtPct(back?.atmSpreadPct, 1)],
    ['Strike w łańcuchu', fmtInt(front?.strikeCount), fmtInt(back?.strikeCount)],
    ['Źródło IV', front ? ivSourceLabel(front.ivSource) : DASH, back ? ivSourceLabel(back.ivSource) : DASH],
  ];

  const out: string[] = [];
  out.push('<table class="mini">');
  out.push('<thead><tr><th></th><th class="num">front</th><th class="num">back</th></tr></thead>');
  out.push('<tbody>');
  for (const row of rows) {
    out.push(
      '<tr><td class="mini-k">' +
        esc(row[0]) +
        '</td><td class="num mono">' +
        esc(row[1]) +
        '</td><td class="num mono">' +
        esc(row[2]) +
        '</td></tr>',
    );
  }
  out.push('</tbody>');
  out.push('</table>');

  out.push('<ul class="facts">');
  out.push(
    '<li>' +
      (c.earningsInsideBackOnly
        ? '<span class="pos">Wyniki wyłącznie w życiu dłuższej nogi</span> — front wygasa przed publikacją, gap obsługuje back.'
        : '<span class="neg">Wyniki nachodzą na krótką nogę</span> — nosisz ekspozycję na gap w dniu publikacji.') +
      '</li>',
  );
  out.push('<li>' + esc(describeFrontGap(front)) + '</li>');
  out.push(
    '<li>Term structure: <span class="mono">' +
      esc(fmtSignedPp(c.termStructureSlope)) +
      '</span>' +
      (c.termStructureRatio !== undefined && Number.isFinite(c.termStructureRatio)
        ? ' · ratio <span class="mono">' + esc(c.termStructureRatio.toFixed(3)) + '</span>'
        : '') +
      '</li>',
  );
  const eps = c.earnings.epsEstimate;
  const revenue = c.earnings.revenueEstimate;
  const estimates: string[] = [];
  if (eps !== undefined && Number.isFinite(eps)) estimates.push('EPS ' + fmtPrice(eps));
  if (revenue !== undefined && Number.isFinite(revenue)) estimates.push('przychody ' + fmtInt(revenue));
  if (estimates.length > 0) {
    out.push('<li>Konsensus: <span class="mono">' + esc(estimates.join(' · ')) + '</span></li>');
  }
  out.push(
    '<li>Koszt struktury (straddle mid): <span class="mono">' +
      esc(fmtPrice(front?.straddleMid)) +
      '</span> front vs <span class="mono">' +
      esc(fmtPrice(back?.straddleMid)) +
      '</span> back</li>',
  );
  out.push('</ul>');

  return out.join('\n');
}

function renderWatchlist(scan: ScanResult): string {
  if (scan.watchlistOnly.length === 0) return '';
  const out: string[] = [];
  out.push('<section class="panel" aria-label="Tylko obserwacja">');
  out.push('<div class="panel-head">');
  out.push('<h2 class="panel-title">Tylko obserwacja</h2>');
  out.push(
    '<span class="panel-sub">' +
      esc(String(scan.watchlistOnly.length)) +
      ' ' +
      pluralPl(scan.watchlistOnly.length, 'spółka', 'spółki', 'spółek') +
      ' w oknie alertu bez pełnej analizy opcyjnej</span>',
  );
  out.push('</div>');
  out.push('<div class="table-wrap short">');
  out.push('<table class="grid grid-watch">');
  out.push('<thead><tr><th>Spółka</th><th>Data wyników</th><th class="num">T-x</th><th>Powód</th></tr></thead>');
  out.push('<tbody>');
  for (const item of scan.watchlistOnly) {
    out.push('<tr>');
    out.push('<td class="mono strong">' + esc(item.symbol) + '</td>');
    out.push('<td class="mono">' + esc(fmtDatePl(item.earningsDate)) + '</td>');
    out.push('<td class="num mono">T-' + esc(fmtInt(item.daysToEarnings)) + '</td>');
    out.push('<td class="wrap-cell">' + esc(item.reason) + '</td>');
    out.push('</tr>');
  }
  out.push('</tbody>');
  out.push('</table>');
  out.push('</div>');
  out.push('</section>');
  return out.join('\n');
}

function renderErrors(scan: ScanResult): string {
  if (scan.errors.length === 0) return '';
  const out: string[] = [];
  out.push('<section class="panel" aria-label="Błędy przebiegu">');
  out.push('<div class="panel-head">');
  out.push('<h2 class="panel-title">Błędy przebiegu</h2>');
  out.push('<span class="panel-sub">' + esc(String(scan.errors.length)) + ' do sprawdzenia</span>');
  out.push('</div>');
  out.push('<div class="warn-box">');
  for (const error of scan.errors) {
    out.push('<div class="warn-item">' + esc(error) + '</div>');
  }
  out.push('</div>');
  out.push('</section>');
  return out.join('\n');
}

function renderFooter(view: ViewMeta, scan: ScanResult | undefined): string {
  const out: string[] = [];
  out.push('<footer class="foot">');
  out.push('<div class="raw">');
  out.push('<button type="button" class="btn ghost" id="btn-raw">Pokaż surowy JSON skanu</button>');
  out.push('<pre class="raw-pre" id="raw-json" hidden></pre>');
  out.push('</div>');
  out.push(
    '<p class="foot-note"><strong>Narzędzie analityczne, nie rekomendacja inwestycyjna.</strong> ' +
      'Ten skaner niczego nie doradza i nie gwarantuje wyniku — pokazuje układ danych, a decyzję i ryzyko ' +
      'ponosisz Ty. Opcje to instrument z dźwignią; long calendar spread może stracić całą wpłaconą premię.</p>',
  );
  out.push(
    '<p class="foot-note">Dane opcyjne: ' +
      esc(view.optionsProvider) +
      ' (' +
      esc(view.tradierEnv) +
      ')' +
      (view.delayed ? ' — <strong>opóźnione o 15 minut</strong>, nie real-time.' : ' — real-time.') +
      ' Dane o wynikach: ' +
      esc(view.earningsProvider) +
      '. Historia IV i deduplikacja alertów: ' +
      (view.usesKv ? 'KV aktywne.' : 'KV nieaktywne.') +
      '</p>',
  );
  out.push(
    '<p class="foot-note dim">Skan: ' +
      esc(view.asOf || DASH) +
      ' · wygenerowano ' +
      esc(formatIsoUtc(view.generatedAt)) +
      ' · wersja ' +
      esc(view.version) +
      (scan ? ' · czas przebiegu ' + esc(formatDuration(scan.durationMs)) : '') +
      '</p>',
  );
  out.push('</footer>');
  return out.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 *  OPISY SŁOWNE (flagi, nogi, relacje)
 * ──────────────────────────────────────────────────────────────────────────── */

const FLAG_MEANINGS: Record<string, string> = {
  'STREFA-OPTYMALNA':
    'Wyniki wypadają w strefie optymalnej (3–21 dni po wygaśnięciu frontu): zbierasz theta i narastanie IV krótkiej nogi, a sam gap obsługuje długa noga.',
  'WYNIKI-W-FRONCIE':
    'Wyniki wypadają PRZED wygaśnięciem frontu — nosisz krótką ekspozycję na gap w dniu publikacji. Klasyczny pre-earnings calendar: zarabia na ramp-upie IV, ale wymaga zarządzania przed wynikami.',
  KONTANGO:
    'Term structure w kontango (back wyraźnie droższy od frontu) — rynek jeszcze nie wycenił zdarzenia w krótkiej nodze, więc vega jest relatywnie tania.',
  'IV-NISKO':
    'IV niska względem własnej historii spółki (IV rank ≤ 25) — kupowanie zmienności jest tanie, ale przy niskiej absolutnej IV ruch bywa cienki.',
  'TANIA-OPCJONALNOSC':
    'Rynek wycenia mniejszy ruch niż typowy historyczny ruch po wynikach — opcjonalność jest tania względem tego, co spółka realnie robiła.',
  PLYNNY:
    'Open interest ATM wysoki — strukturę zbudujesz i zamkniesz po godziwej cenie, ryzyko poślizgu mniejsze.',
  'GOTOWY-DO-ANALIZY':
    'Score ≥ 70 przy potwierdzonej dacie publikacji — kandydat gotowy do ręcznej weryfikacji łańcucha i wejścia.',
};

function explainFlags(flags: string[]): string[] {
  const out: string[] = [];
  for (const flag of flags) {
    const meaning = FLAG_MEANINGS[flag];
    if (meaning) out.push(meaning);
  }
  return out;
}

function flagTone(flag: string): string {
  switch (flag) {
    case 'STREFA-OPTYMALNA':
    case 'TANIA-OPCJONALNOSC':
      return 'ok';
    case 'GOTOWY-DO-ANALIZY':
      return 'ok-strong';
    case 'KONTANGO':
    case 'IV-NISKO':
      return 'info';
    case 'WYNIKI-W-FRONCIE':
      return 'warn';
    default:
      return 'muted';
  }
}

function describeFrontGap(front: IvPoint | undefined): string {
  if (!front) return 'brak danych opcyjnych dla frontu';
  const d = front.daysToEarnings;
  if (!Number.isFinite(d)) return 'brak danych o odległości wyników od frontu';
  if (d === 0) return 'wyniki w dniu wygaśnięcia frontu (±0 dni)';
  if (d > 0) return 'wyniki +' + fmtInt(d) + ' dni od frontu (po jego wygaśnięciu)';
  return 'wyniki ' + fmtInt(d) + ' dni od frontu (przed jego wygaśnięciem)';
}

function describeEntryDelta(delta: number): string {
  if (delta === 0) return 'dziś';
  if (delta === 1) return 'za 1 dzień';
  if (delta > 1) return 'za ' + fmtInt(delta) + ' dni';
  if (delta === -1) return '1 dzień temu';
  return fmtInt(Math.abs(delta)) + ' dni temu';
}

function moveRelationLabel(c: CalendarCandidate): string {
  const implied = c.front?.impliedMovePct;
  const hist = c.avgHistoricalMovePct;
  if (implied === undefined || !Number.isFinite(implied)) return 'brak implied move';
  if (hist === undefined || !Number.isFinite(hist) || hist <= 0) return 'brak historii ruchu';
  const gapPp = (implied - hist) * 100;
  if (Math.abs(gapPp) < 0.05) return 'zgodnie z historią';
  if (gapPp < 0) return 'taniej o ' + Math.abs(gapPp).toFixed(1) + ' pp';
  return 'drożej o ' + gapPp.toFixed(1) + ' pp';
}

function moveRelationClass(c: CalendarCandidate): string {
  const implied = c.front?.impliedMovePct;
  const hist = c.avgHistoricalMovePct;
  if (implied === undefined || !Number.isFinite(implied)) return 'dim';
  if (hist === undefined || !Number.isFinite(hist) || hist <= 0) return 'dim';
  const gap = implied - hist;
  if (Math.abs(gap) < 0.0005) return 'dim';
  return gap < 0 ? 'pos' : 'neg';
}

function ivSourceLabel(source: IvPoint['ivSource']): string {
  return source === 'provider' ? 'od dostawcy' : 'policzona z cen';
}

/* ────────────────────────────────────────────────────────────────────────────
 *  FORMATOWANIE
 * ──────────────────────────────────────────────────────────────────────────── */

const DASH = '—';

function fmtInt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  return String(Math.round(value));
}

function fmtPoints(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  return value.toFixed(2);
}

/** Ułamek → procent, np. 0.382 → "38.2%" */
function fmtPct(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  return (value * 100).toFixed(digits) + '%';
}

/** Ułamek → punkty procentowe ze znakiem, np. -0.051 → "-5.1 pp" */
function fmtSignedPp(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return DASH;
  const pp = value * 100;
  const sign = pp > 0 ? '+' : pp < 0 ? '-' : '';
  return sign + Math.abs(pp).toFixed(digits) + ' pp';
}

function fmtDatePl(iso: string | undefined): string {
  if (!iso) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return m[3] + '.' + m[2] + '.' + m[1];
}

function formatIsoUtc(iso: string | undefined): string {
  if (!iso) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ' UTC';
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return Math.round(ms) + ' ms';
  const seconds = ms / 1000;
  if (seconds < 60) return seconds.toFixed(1) + ' s';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return minutes + ' min ' + (rest < 10 ? '0' : '') + rest + ' s';
}

function pluralPl(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function parseIsoDate(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  return Date.UTC(year, month - 1, day);
}

function daysBetween(fromIso: string, toIso: string): number | undefined {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (from === undefined || to === undefined) return undefined;
  return Math.round((to - from) / 86_400_000);
}

/* ────────────────────────────────────────────────────────────────────────────
 *  ESCAPING
 * ──────────────────────────────────────────────────────────────────────────── */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape'uje każdą wartość pochodzącą z danych, zanim trafi do HTML/atrybutu. */
function esc(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function attr(name: string, value: string): string {
  return ' ' + name + '="' + esc(value) + '"';
}

/** JSON bezpieczny do osadzenia w `<script>`: `<` na `\u003c` blokuje domknięcie taga. */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** JSON.stringify, które nigdy nie rzuca (cykle, BigInt) — zwraca undefined gdy się nie da. */
function safeJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  NORMALIZACJA DANYCH (scan: unknown → ScanResult | undefined)
 * ──────────────────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `meta.scan` bywa jedynym nośnikiem wyniku skanu — czytamy go defensywnie. */
function readMetaScan(meta: DashboardMeta): unknown {
  const raw: unknown = meta;
  return isRecord(raw) ? raw['scan'] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeScan(input: unknown): ScanResult | undefined {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(raw)) return undefined;

  const configRaw = isRecord(raw['config']) ? raw['config'] : {};
  const countsRaw = isRecord(raw['counts']) ? raw['counts'] : {};

  const candidates: CalendarCandidate[] = [];
  for (const item of asArray(raw['candidates'])) {
    const candidate = normalizeCandidate(item);
    if (candidate) candidates.push(candidate);
  }

  const watchlistOnly: ScanResult['watchlistOnly'] = [];
  for (const item of asArray(raw['watchlistOnly'])) {
    if (!isRecord(item)) continue;
    const symbol = asString(item['symbol']);
    if (!symbol) continue;
    watchlistOnly.push({
      symbol,
      earningsDate: asString(item['earningsDate']) ?? '',
      daysToEarnings: asNumber(item['daysToEarnings']) ?? 0,
      reason: asString(item['reason']) ?? 'brak powodu w danych skanu',
    });
  }

  const errors: string[] = [];
  for (const item of asArray(raw['errors'])) {
    if (typeof item === 'string' && item.length > 0) errors.push(item);
    else if (isRecord(item)) {
      const message = asString(item['message']) ?? safeJson(item);
      if (message) errors.push(message);
    }
  }

  return {
    generatedAt: asString(raw['generatedAt']) ?? '',
    asOf: asString(raw['asOf']) ?? '',
    config: {
      alertMinDays: asNumber(configRaw['alertMinDays']) ?? 25,
      alertMaxDays: asNumber(configRaw['alertMaxDays']) ?? 45,
      optionsProvider: asString(configRaw['optionsProvider']) ?? 'nieznany',
      earningsProvider: asString(configRaw['earningsProvider']) ?? 'nieznany',
      tradierEnv: asString(configRaw['tradierEnv']) ?? 'nieznane',
    },
    counts: {
      universe: asNumber(countsRaw['universe']) ?? 0,
      withUpcomingEarnings: asNumber(countsRaw['withUpcomingEarnings']) ?? 0,
      inAlertWindow: asNumber(countsRaw['inAlertWindow']) ?? 0,
      analyzed: asNumber(countsRaw['analyzed']) ?? 0,
      candidates: asNumber(countsRaw['candidates']) ?? candidates.length,
      alertsSent: asNumber(countsRaw['alertsSent']) ?? 0,
    },
    candidates,
    watchlistOnly,
    errors,
    durationMs: asNumber(raw['durationMs']) ?? 0,
  };
}

function normalizeCandidate(input: unknown): CalendarCandidate | undefined {
  if (!isRecord(input)) return undefined;
  const symbol = asString(input['symbol']);
  if (!symbol) return undefined;

  const earningsRaw = isRecord(input['earnings']) ? input['earnings'] : {};
  const timingRaw = earningsRaw['timing'];
  const timing: EarningsTiming = timingRaw === 'bmo' || timingRaw === 'amc' ? timingRaw : 'unknown';

  const earnings: EarningsEvent = {
    symbol: asString(earningsRaw['symbol']) ?? symbol,
    date: asString(earningsRaw['date']) ?? '',
    timing,
    confirmed: earningsRaw['confirmed'] === true,
    epsEstimate: asNumber(earningsRaw['epsEstimate']),
    revenueEstimate: asNumber(earningsRaw['revenueEstimate']),
  };

  const score = asNumber(input['score']);
  const gradeRaw = input['grade'];
  const grade: CalendarCandidate['grade'] =
    gradeRaw === 'A' || gradeRaw === 'B' || gradeRaw === 'C' || gradeRaw === 'D'
      ? gradeRaw
      : gradeFromScore(score);

  const termStructureRatio = asNumber(input['termStructureRatio']);

  return {
    symbol,
    name: asString(input['name']),
    sector: asString(input['sector']),
    spot: asNumber(input['spot']) ?? Number.NaN,
    earnings,
    daysToEarnings: asNumber(input['daysToEarnings']) ?? Number.NaN,
    tradingDaysToEarnings: asNumber(input['tradingDaysToEarnings']) ?? Number.NaN,
    earningsInsideBackOnly: input['earningsInsideBackOnly'] === true,
    front: normalizeIvPoint(input['front']),
    back: normalizeIvPoint(input['back']),
    termStructureSlope: asNumber(input['termStructureSlope']),
    termStructureRatio,
    ivRank: asNumber(input['ivRank']),
    avgHistoricalMovePct: asNumber(input['avgHistoricalMovePct']),
    score: score ?? 0,
    grade,
    components: normalizeComponents(input['components']),
    flags: normalizeStringArray(input['flags']),
    suggestedEntryDate: asString(input['suggestedEntryDate']),
    warnings: normalizeStringArray(input['warnings']),
  };
}

function normalizeIvPoint(input: unknown): IvPoint | undefined {
  if (!isRecord(input)) return undefined;
  const expiration = asString(input['expiration']);
  if (!expiration) return undefined;
  return {
    expiration,
    dte: asNumber(input['dte']) ?? Number.NaN,
    daysToEarnings: asNumber(input['daysToEarnings']) ?? Number.NaN,
    atmIv: asNumber(input['atmIv']) ?? Number.NaN,
    ivSource: input['ivSource'] === 'provider' ? 'provider' : 'computed',
    straddleMid: asNumber(input['straddleMid']) ?? Number.NaN,
    impliedMovePct: asNumber(input['impliedMovePct']) ?? Number.NaN,
    atmOpenInterest: asNumber(input['atmOpenInterest']) ?? Number.NaN,
    atmSpreadPct: asNumber(input['atmSpreadPct']) ?? Number.NaN,
    strikeCount: asNumber(input['strikeCount']) ?? Number.NaN,
  };
}

function normalizeComponents(input: unknown): ScoreComponent[] {
  const out: ScoreComponent[] = [];
  for (const raw of asArray(input)) {
    if (!isRecord(raw)) continue;
    const key = asString(raw['key']) ?? '';
    const label = asString(raw['label']) ?? key;
    if (!label) continue;
    out.push({
      key,
      label,
      points: asNumber(raw['points']) ?? 0,
      maxPoints: asNumber(raw['maxPoints']) ?? 0,
      note: asString(raw['note']) ?? '',
    });
  }
  return out;
}

function normalizeStringArray(input: unknown): string[] {
  const out: string[] = [];
  for (const raw of asArray(input)) {
    if (typeof raw === 'string') {
      if (raw.length > 0) out.push(raw);
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out.push(String(raw));
    }
  }
  return out;
}

function gradeFromScore(score: number | undefined): CalendarCandidate['grade'] {
  if (score === undefined) return 'D';
  if (score >= 78) return 'A';
  if (score >= 63) return 'B';
  if (score >= 48) return 'C';
  return 'D';
}

/* ────────────────────────────────────────────────────────────────────────────
 *  META
 * ──────────────────────────────────────────────────────────────────────────── */

interface ViewMeta {
  asOf: string;
  generatedAt: string;
  optionsProvider: string;
  earningsProvider: string;
  tradierEnv: string;
  usesKv: boolean;
  version: string;
  /** Sandbox = dane opcyjne opóźnione 15 min (nie real-time) */
  delayed: boolean;
  /** Środowisko inne niż sandbox/production — nie zakładamy real-time */
  unknownEnv: boolean;
}

function buildViewMeta(meta: DashboardMeta, scan: ScanResult | undefined): ViewMeta {
  // `meta` przychodzi z workera (JS), więc czytamy je defensywnie — brak pola nie może wywalić strony.
  const raw: unknown = meta;
  const m: Record<string, unknown> = isRecord(raw) ? raw : {};
  const tradierEnv = asString(m['tradierEnv']) ?? scan?.config.tradierEnv ?? 'nieznane';
  const env = tradierEnv.toLowerCase();
  return {
    asOf: asString(m['asOf']) ?? scan?.asOf ?? '',
    generatedAt: asString(m['generatedAt']) ?? scan?.generatedAt ?? '',
    optionsProvider: asString(m['optionsProvider']) ?? scan?.config.optionsProvider ?? 'nieznany',
    earningsProvider: asString(m['earningsProvider']) ?? scan?.config.earningsProvider ?? 'nieznany',
    tradierEnv,
    usesKv: m['usesKv'] === true,
    version: asString(m['version']) ?? '?',
    delayed: env === 'sandbox',
    unknownEnv: env !== 'sandbox' && env !== 'production',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 *  DROBIAZGI WIDOKU
 * ──────────────────────────────────────────────────────────────────────────── */

function th(label: string, sort: string | undefined, cls: string): string {
  const classes = ['th-' + cls];
  if (sort) classes.push('sortable');
  if (sort === 'score') classes.push('sorted');
  const attrs =
    (sort ? ' data-sort="' + esc(sort) + '"' : '') +
    (sort === 'score' ? ' aria-sort="descending"' : sort ? ' aria-sort="none"' : '');
  const arrow = sort ? '<span class="arrow" aria-hidden="true">' + (sort === 'score' ? '↓' : '') + '</span>' : '';
  const title = sort ? ' title="Kliknij, żeby sortować"' : '';
  return '<th class="' + classes.join(' ') + '"' + attrs + title + '>' + esc(label) + arrow + '</th>';
}

function chip(label: string, tone: string): string {
  return '<span class="chip chip-' + esc(tone) + '">' + esc(label) + '</span>';
}

function signClass(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'neu';
  if (value > 0) return 'pos';
  if (value < 0) return 'neg';
  return 'neu';
}

function spreadClass(spread: number | undefined): string {
  if (spread === undefined || !Number.isFinite(spread)) return 'dim';
  if (spread <= 0.03) return 'pos';
  if (spread >= 0.08) return 'neg';
  return '';
}

/** To samo co spreadClass, ale zwraca gotowy fragment atrybutu class (bez podwójnej spacji). */
function spreadToneClass(spread: number | undefined): string {
  const tone = spreadClass(spread);
  return tone ? ' ' + tone : '';
}

function rankClass(rank: number): string {
  if (rank <= 30) return 'bar-ok';
  if (rank <= 70) return 'bar-mid';
  return 'bar-hot';
}

function barTone(ratio: number): string {
  if (ratio >= 80) return 'bar-ok';
  if (ratio >= 45) return 'bar-mid';
  return 'bar-low';
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function dataNum(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? String(value) : '';
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  const values = [a, b].filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  const values = [a, b].filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

/* ────────────────────────────────────────────────────────────────────────────
 *  CSS (inline, bez zewnętrznych fontów i arkuszy)
 * ──────────────────────────────────────────────────────────────────────────── */

const STYLES = `
:root{
  --bg:#0f1115; --panel:#161a22; --panel-2:#1b212b; --panel-3:#212a36;
  --line:#262e3b; --line-2:#1e2530;
  --text:#e6eaf2; --text-2:#aeb7c6; --muted:#818b9c; --dim:#63707f;
  --accent:#5b8def;
  --green:#3ddc97; --red:#ff6b7a; --yellow:#e9c46a; --gray:#98a2b3;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
h1,h2,h3,h4{margin:0;font-weight:600}
p{margin:0 0 8px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.sub{font-size:11.5px;color:var(--text-2)}
.strong{font-weight:600}
.pos{color:var(--green)}
.neg{color:var(--red)}
.neu{color:var(--text-2)}
.wrap{max-width:1560px;margin:0 auto;padding:18px 16px 56px}

/* ── nagłówek ─────────────────────────────────────────────────────────── */
.top{background:linear-gradient(180deg,#171d27,#12161d);border:1px solid var(--line);
  border-radius:12px;padding:16px 18px 14px;margin-bottom:12px}
.top-grid{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;align-items:flex-start}
.brand h1{font-size:19px;letter-spacing:-.01em}
.brand .sub{margin:6px 0 0;max-width:70ch}
.stamp{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--text-2);
  background:#131820;border:1px solid var(--line-2);border-radius:8px;padding:8px 10px;min-width:210px}
.stamp-row{display:flex;justify-content:space-between;gap:14px}
.stamp-k{color:var(--dim)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.chip{display:inline-block;padding:2px 7px;border-radius:999px;border:1px solid var(--line);
  background:#1d2430;color:var(--text-2);font-size:10.5px;font-family:var(--mono);
  letter-spacing:.02em;white-space:nowrap}
.chip-ok{color:var(--green);border-color:rgba(61,220,151,.35);background:rgba(61,220,151,.08)}
.chip-ok-strong{color:#0f1115;background:var(--green);border-color:var(--green);font-weight:700}
.chip-warn{color:var(--yellow);border-color:rgba(233,196,106,.4);background:rgba(233,196,106,.08)}
.chip-info{color:#7fb2ff;border-color:rgba(91,141,239,.4);background:rgba(91,141,239,.08)}
.chip-muted{color:var(--muted)}
.notice{margin:12px 0 0;padding:9px 11px;border-radius:8px;font-size:12.5px;border:1px solid var(--line);
  background:#141a23;color:var(--text-2)}
.notice strong{color:var(--text)}
.notice.warn{border-color:rgba(233,196,106,.4);background:rgba(233,196,106,.07);color:#f0dfae}
.notice.warn strong{color:var(--yellow)}
.notice.info{border-color:rgba(91,141,239,.35);background:rgba(91,141,239,.07);color:#c3d5f5}
.notice.ok{border-color:rgba(61,220,151,.3);background:rgba(61,220,151,.06);color:#bdf0d8}

/* ── karty podsumowania ───────────────────────────────────────────────── */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.card .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.card .v{font-size:22px;line-height:1.2;margin-top:4px;font-weight:600}
.card .h{font-size:10.5px;color:var(--dim);margin-top:2px}

/* ── panele ───────────────────────────────────────────────────────────── */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;
  margin-bottom:12px}
.panel-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline;margin-bottom:10px}
.panel-title{font-size:14px;letter-spacing:.01em}
.panel-sub{font-size:11.5px;color:var(--dim)}

/* ── filtry ───────────────────────────────────────────────────────────── */
.controls-grid{display:grid;grid-template-columns:minmax(180px,1.2fr) 140px minmax(200px,1.4fr) minmax(210px,1fr) auto;
  gap:10px 14px;align-items:end}
.controls-grid-simple{grid-template-columns:1fr;justify-items:end}
.field{display:flex;flex-direction:column;gap:5px;min-width:0}
.field label{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.field-check{gap:7px}
.check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text-2);
  text-transform:none;letter-spacing:0}
.field-actions{flex-direction:row;gap:8px;justify-content:flex-end}
input[type=search],input[type=password],select{background:#11161e;border:1px solid var(--line);
  color:var(--text);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;width:100%}
input[type=search]:focus,input[type=password]:focus,select:focus{outline:none;border-color:var(--accent)}
input[type=range]{width:100%;accent-color:var(--accent);background:transparent}
input[type=checkbox]{accent-color:var(--accent);width:14px;height:14px}
.btn{background:#1d2430;border:1px solid var(--line);color:var(--text);border-radius:8px;
  padding:8px 14px;font-size:12.5px;font-family:inherit;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:#37425a;background:#232c3a}
.btn:disabled{opacity:.6;cursor:progress}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#0d1117;font-weight:600}
.btn.primary:hover{background:#6d9bf5;border-color:#6d9bf5}
.btn.ghost{background:transparent}
.controls-foot{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:12px;
  padding-top:10px;border-top:1px solid var(--line-2)}
.counts{font-size:12px;color:var(--text-2)}
.status{font-size:12px;color:var(--text-2)}
.status.err{color:var(--red)}
.status.ok{color:var(--green)}
.status.info{color:#7fb2ff}
.key-box{margin-top:10px;font-size:12px;color:var(--text-2)}
.key-box summary{cursor:pointer;color:var(--dim);font-size:11.5px}
.key-box summary:hover{color:var(--text-2)}
.key-body{display:flex;flex-direction:column;gap:6px;margin-top:9px;max-width:560px}
.key-body .dim,.key-box .dim{font-size:11px;line-height:1.45}

/* ── tabela ───────────────────────────────────────────────────────────── */
.table-wrap{overflow:auto;max-height:72vh;border:1px solid var(--line);border-radius:10px;
  background:var(--panel-2);-webkit-overflow-scrolling:touch}
.table-wrap.short{max-height:340px}
table.grid{width:100%;min-width:1380px;border-collapse:separate;border-spacing:0;font-size:12.5px}
table.grid.grid-watch{min-width:720px}
table.grid th{position:sticky;top:0;z-index:3;background:var(--panel-3);color:var(--text-2);
  text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
table.grid th.th-num{text-align:right}
table.grid th.sortable{cursor:pointer;user-select:none}
table.grid th.sortable:hover{color:var(--text);background:#26303e}
table.grid th.sorted{color:var(--text)}
table.grid th .arrow{display:inline-block;width:10px;margin-left:5px;color:var(--accent);font-size:11px}
table.grid td{padding:9px 10px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.grid tbody tr.row{cursor:pointer}
table.grid tbody tr.row:hover{background:#1a2130}
table.grid tbody tr.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
table.grid tbody tr.row[aria-expanded=true]{background:#1a2130}
table.grid tbody tr.row[aria-expanded=true] td{border-bottom-color:transparent}
tr[hidden]{display:none!important}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.c-sym{min-width:150px}
.sym{font-size:14.5px;font-weight:700;letter-spacing:.02em}
.sym-name{font-size:11px;color:var(--text-2);max-width:190px}
.sym-sector{font-size:10px;color:var(--dim);margin-top:2px}
.c-score{width:86px}
.score{display:inline-flex;align-items:center;gap:8px;padding:3px 8px;border-radius:8px;
  border:1px solid var(--line);background:#1d2430;color:var(--text-2)}
.score b{font-size:15px;line-height:1.15}
.score i{font-style:normal;font-size:11px;font-weight:700;padding-left:7px;border-left:1px solid rgba(255,255,255,.14)}
.score.g-A{color:var(--green);background:rgba(61,220,151,.1);border-color:rgba(61,220,151,.38)}
.score.g-B{color:#6fa8ff;background:rgba(91,141,239,.1);border-color:rgba(91,141,239,.38)}
.score.g-C{color:var(--yellow);background:rgba(233,196,106,.1);border-color:rgba(233,196,106,.32)}
.score.g-D{color:var(--gray);background:rgba(152,162,179,.08);border-color:rgba(152,162,179,.3)}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.tag{font-size:9.5px;font-family:var(--mono);letter-spacing:.03em;padding:1px 5px;border-radius:4px;
  border:1px solid var(--line);color:var(--text-2);background:#1c2330;white-space:nowrap}
.tag-bmo{border-color:rgba(91,141,239,.4);color:#8fbaff}
.tag-amc{border-color:rgba(147,112,219,.45);color:#b79bff}
.tag-unknown{border-color:rgba(233,196,106,.35);color:var(--yellow)}
.tag-ok{border-color:rgba(61,220,151,.35);color:var(--green)}
.tag-warn{border-color:rgba(255,107,122,.4);color:var(--red)}
.c-legs{min-width:250px}
.leg{display:flex;gap:8px;align-items:baseline;font-size:11.5px}
.leg-tag{display:inline-block;width:38px;color:var(--dim);font-size:9.5px;text-transform:uppercase;
  letter-spacing:.05em}
.leg-note{font-size:10.5px;color:var(--text-2);margin-top:3px}
.c-entry{min-width:110px}
.c-flags{min-width:190px;max-width:300px}
.c-flags .chip{margin:0 4px 4px 0}
.wrap-cell{white-space:normal;min-width:280px;color:var(--text-2)}
.warn-pill{display:inline-block;font-size:10px;font-family:var(--mono);padding:2px 6px;
  border-radius:999px;border:1px solid rgba(255,107,122,.45);color:var(--red);
  background:rgba(255,107,122,.08);white-space:nowrap}
.bar-mini{height:4px;width:52px;margin:4px 0 0 auto;background:#232b38;border-radius:99px;overflow:hidden}
.bar-mini>span{display:block;height:100%}
.bar-ok{background:var(--green)}
.bar-mid{background:var(--yellow)}
.bar-hot{background:var(--red)}
.bar-low{background:#ff8f6b}
.filter-none{margin:10px 0 0;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
  background:#141a23;font-size:12.5px;color:var(--text-2)}

/* ── rozwinięty wiersz ────────────────────────────────────────────────── */
tr.detail>td{background:#12171f;padding:0;border-bottom:1px solid var(--line)}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;padding:14px 16px 16px}
.detail-col h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
  margin:0 0 9px}
.detail-col h4:not(:first-child){margin-top:16px}
.detail-col h4.warn-head{color:var(--red)}
.comp{margin-bottom:11px}
.comp-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.comp-label{font-size:12px;color:var(--text)}
.comp-pts{font-size:11.5px;color:var(--text-2)}
.bar{height:6px;border-radius:99px;background:#232b38;overflow:hidden;margin:5px 0 6px}
.bar>span{display:block;height:100%}
.comp-note{margin:0;font-size:11.5px;color:var(--text-2);line-height:1.5}
.meaning{margin:0;padding-left:16px;font-size:12px;color:var(--text-2)}
.meaning li{margin-bottom:5px}
.warn-box{border:1px solid rgba(255,107,122,.32);background:rgba(255,107,122,.06);border-radius:8px;
  padding:8px 10px}
.warn-item{font-size:12px;color:#ffc9cf;margin-bottom:5px}
.warn-item:last-child{margin-bottom:0}
table.mini{width:100%;border-collapse:collapse;font-size:11.5px}
table.mini th{text-align:right;font-weight:600;font-size:10px;text-transform:uppercase;
  letter-spacing:.05em;color:var(--dim);padding:0 0 5px;border-bottom:1px solid var(--line-2)}
table.mini th:first-child{text-align:left}
table.mini td{padding:4px 0;border-bottom:1px solid var(--line-2)}
.mini-k{color:var(--dim)}
.facts{margin:10px 0 0;padding-left:16px;font-size:11.5px;color:var(--text-2)}
.facts li{margin-bottom:4px}

/* ── stany puste ──────────────────────────────────────────────────────── */
.empty{padding:22px 6px;text-align:center;color:var(--text-2)}
.empty h2,.empty h3{font-size:15px;color:var(--text);margin-bottom:8px}
.empty p{max-width:78ch;margin:0 auto 8px;font-size:12.5px}

/* ── stopka ───────────────────────────────────────────────────────────── */
.foot{padding:14px 2px 0;border-top:1px solid var(--line);margin-top:6px}
.foot-note{font-size:11.5px;color:var(--text-2);max-width:110ch;margin-bottom:6px}
.raw{margin-bottom:10px}
.raw-pre{margin:10px 0 0;padding:11px;background:#0d1117;border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--text-2);max-height:420px;overflow:auto}

/* ── responsywność ────────────────────────────────────────────────────── */
@media (max-width:1100px){
  .controls-grid{grid-template-columns:1fr 1fr;align-items:end}
  .field-wide{grid-column:1 / -1}
  .field-actions{grid-column:1 / -1}
  .detail-grid{grid-template-columns:1fr}
}
@media (max-width:760px){
  .wrap{padding:12px 10px 40px}
  .cards{grid-template-columns:1fr 1fr}
  .top-grid{flex-direction:column}
  .stamp{width:100%}
  .table-wrap{max-height:64vh}
  table.grid{min-width:1180px}
}
@media (max-width:560px){
  .cards{grid-template-columns:1fr}
  .controls-grid{grid-template-columns:1fr}
  .brand h1{font-size:17px}
  .card .v{font-size:19px}
}
`;

/* ────────────────────────────────────────────────────────────────────────────
 *  SKRYPT KLIENCKI (bez frameworków, bez szablonów — ES2020)
 * ──────────────────────────────────────────────────────────────────────────── */

const CLIENT_SCRIPT = `
(function () {
  'use strict';

  var KEY_STORAGE = 'scanner_api_key';

  var table = document.getElementById('cand-table');
  var refreshBtn = document.getElementById('btn-refresh');
  var statusEl = document.getElementById('status');
  var keyBox = document.getElementById('key-box');
  var keyInput = document.getElementById('api-key');
  var countEl = document.getElementById('visible-count');
  var noneEl = document.getElementById('filter-none');
  var qEl = document.getElementById('f-query');
  var gradeEl = document.getElementById('f-grade');
  var scoreEl = document.getElementById('f-score');
  var scoreOut = document.getElementById('f-score-value');
  var confEl = document.getElementById('f-confirmed');
  var optEl = document.getElementById('f-optimal');
  var resetBtn = document.getElementById('f-reset');

  /* ── komunikaty ───────────────────────────────────────────────────── */
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = kind ? 'status ' + kind : 'status';
  }

  /* ── klucz API: wyłącznie localStorage tej przeglądarki ───────────── */
  function readStoredKey() {
    try { return window.localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function storeKey(value) {
    try {
      if (value) { window.localStorage.setItem(KEY_STORAGE, value); }
      else { window.localStorage.removeItem(KEY_STORAGE); }
    } catch (e) { /* tryb prywatny / brak dostępu — klucz po prostu nie przetrwa odświeżenia */ }
  }
  if (keyInput) {
    var storedKey = readStoredKey();
    if (storedKey) { keyInput.value = storedKey; }
    keyInput.addEventListener('change', function () {
      var value = keyInput.value.trim();
      storeKey(value);
      /* Nigdy nie wypisujemy wartości klucza. */
      setStatus(value ? 'Klucz API zapisany w tej przeglądarce.' : 'Klucz API usunięty z tej przeglądarki.', 'info');
    });
  }
  function askForKey(message) {
    if (keyBox) { keyBox.open = true; }
    setStatus(message, 'err');
    if (keyInput) { keyInput.focus(); }
  }

  /* ── odświeżanie skanu ────────────────────────────────────────────── */
  function setBusy(busy) {
    if (!refreshBtn) return;
    refreshBtn.disabled = busy;
    refreshBtn.textContent = busy ? 'Odświeżanie…' : 'Odśwież';
    refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function replaceDocument(html) {
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      window.location.reload();
    }
  }
  function requestHeaders() {
    var headers = { 'accept': 'text/html, application/json;q=0.9, */*;q=0.8' };
    var key = keyInput ? keyInput.value.trim() : '';
    if (key) { headers['x-api-key'] = key; } /* jedyne miejsce, w które trafia klucz */
    return headers;
  }
  function loadFreshDashboard() {
    return fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then(function (page) {
      var type = (page.headers.get('content-type') || '').toLowerCase();
      if (page.ok && type.indexOf('text/html') !== -1) {
        return page.text().then(replaceDocument);
      }
      setStatus('Skan odświeżony. Odśwież stronę (F5), żeby zobaczyć nowe dane.', 'ok');
      return null;
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      setBusy(true);
      setStatus('Pobieram świeże dane ze skanera… to może potrwać kilkadziesiąt sekund.', 'info');
      fetch('/api/scan?refresh=1', { headers: requestHeaders(), cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) {
          if (response.status === 401 || response.status === 403) {
            askForKey('Skaner wymaga klucza API (nagłówek x-api-key). Wklej klucz poniżej i kliknij Odśwież ponownie.');
            return null;
          }
          if (!response.ok) {
            setStatus('Nie udało się odświeżyć skanu (HTTP ' + response.status + '). Spróbuj ponownie później.', 'err');
            return null;
          }
          var type = (response.headers.get('content-type') || '').toLowerCase();
          if (type.indexOf('text/html') !== -1) {
            return response.text().then(replaceDocument);
          }
          return loadFreshDashboard();
        })
        .catch(function () {
          setStatus('Błąd sieci: nie udało się połączyć z serwerem skanera. Sprawdź połączenie i spróbuj ponownie.', 'err');
        })
        .then(function () { setBusy(false); });
    });
  }

  /* ── tabela: filtry, sortowanie, rozwinięcia ──────────────────────── */
  if (!table || !table.tBodies || table.tBodies.length === 0) { return; }
  var tbody = table.tBodies[0];
  var entries = [];
  var detailsByIndex = {};
  var detailNodes = tbody.querySelectorAll('tr.detail');
  var i;
  for (i = 0; i < detailNodes.length; i += 1) {
    detailsByIndex[detailNodes[i].getAttribute('data-for') || ''] = detailNodes[i];
  }
  var rowNodes = tbody.querySelectorAll('tr.row');
  for (i = 0; i < rowNodes.length; i += 1) {
    entries.push({
      row: rowNodes[i],
      detail: detailsByIndex[rowNodes[i].getAttribute('data-idx') || ''] || null
    });
  }

  var state = { q: '', grade: 'all', minScore: 0, confirmed: false, optimal: false, sort: 'score', dir: -1 };
  var headers = table.querySelectorAll('th[data-sort]');

  function ds(row, key) {
    var value = row.getAttribute('data-' + key);
    return value === null ? '' : value;
  }
  function numOf(row, key) {
    var value = parseFloat(ds(row, key));
    return isFinite(value) ? value : null;
  }
  function matches(row) {
    if (state.grade !== 'all' && ds(row, 'grade') !== state.grade) { return false; }
    if (state.confirmed && ds(row, 'confirmed') !== '1') { return false; }
    if (state.optimal && ds(row, 'optimal') !== '1') { return false; }
    if (state.minScore > 0) {
      var score = numOf(row, 'score');
      if (score === null || score < state.minScore) { return false; }
    }
    if (state.q) {
      var haystack = (ds(row, 'symbol') + ' ' + ds(row, 'name') + ' ' + ds(row, 'sector')).toLowerCase();
      if (haystack.indexOf(state.q) === -1) { return false; }
    }
    return true;
  }
  function tieBreak(a, b) {
    var as = numOf(a.row, 'score');
    var bs = numOf(b.row, 'score');
    if (as === null) { as = -1; }
    if (bs === null) { bs = -1; }
    if (as !== bs) { return bs - as; }
    var ax = ds(a.row, 'symbol');
    var bx = ds(b.row, 'symbol');
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  }
  function compare(a, b) {
    var key = state.sort;
    var av;
    var bv;
    var aMissing = false;
    var bMissing = false;
    if (key === 'symbol') {
      av = ds(a.row, 'symbol').toLowerCase();
      bv = ds(b.row, 'symbol').toLowerCase();
    } else if (key === 'date') {
      av = ds(a.row, 'date');
      bv = ds(b.row, 'date');
      aMissing = !av;
      bMissing = !bv;
    } else if (key === 'entry') {
      av = ds(a.row, 'entry');
      bv = ds(b.row, 'entry');
      aMissing = !av;
      bMissing = !bv;
    } else {
      var x = numOf(a.row, key);
      var y = numOf(b.row, key);
      aMissing = x === null;
      bMissing = y === null;
      av = aMissing ? 0 : x;
      bv = bMissing ? 0 : y;
    }
    if (aMissing || bMissing) {
      if (aMissing && bMissing) { return tieBreak(a, b); }
      return aMissing ? 1 : -1; /* braki danych zawsze na końcu listy */
    }
    if (av < bv) { return -1 * state.dir; }
    if (av > bv) { return 1 * state.dir; }
    return tieBreak(a, b);
  }
  function paintHeaders() {
    for (var h = 0; h < headers.length; h += 1) {
      var node = headers[h];
      var key = node.getAttribute('data-sort');
      var active = key === state.sort;
      node.className = node.className.replace(/\\s*sorted/g, '') + (active ? ' sorted' : '');
      node.setAttribute('aria-sort', active ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
      var arrow = node.querySelector('.arrow');
      if (arrow) { arrow.textContent = active ? (state.dir === 1 ? '↑' : '↓') : ''; }
    }
  }
  function apply() {
    var visible = 0;
    var e;
    for (e = 0; e < entries.length; e += 1) {
      var entry = entries[e];
      var show = matches(entry.row);
      entry.row.hidden = !show;
      if (show) {
        visible += 1;
      } else if (entry.detail) {
        entry.detail.hidden = true;
        entry.row.setAttribute('aria-expanded', 'false');
      }
    }
    entries.sort(compare);
    for (e = 0; e < entries.length; e += 1) {
      tbody.appendChild(entries[e].row);
      if (entries[e].detail) { tbody.appendChild(entries[e].detail); }
    }
    if (countEl) { countEl.textContent = visible + ' z ' + entries.length; }
    if (noneEl) { noneEl.hidden = !(visible === 0 && entries.length > 0); }
  }
  function toggleDetail(row) {
    var detail = null;
    for (var e = 0; e < entries.length; e += 1) {
      if (entries[e].row === row) { detail = entries[e].detail; break; }
    }
    if (!detail) { return; }
    var willOpen = detail.hidden;
    detail.hidden = !willOpen;
    row.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  table.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) { return; }
    var row = target.closest('tr.row');
    if (row && row.parentNode === tbody) { toggleDetail(row); }
  });
  table.addEventListener('keydown', function (event) {
    var key = event.key;
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') { return; }
    var target = event.target;
    if (!target || !target.closest) { return; }
    var row = target.closest('tr.row');
    if (row && row.parentNode === tbody) {
      event.preventDefault();
      toggleDetail(row);
    }
  });
  for (i = 0; i < headers.length; i += 1) {
    headers[i].addEventListener('click', function () {
      var key = this.getAttribute('data-sort');
      if (key === state.sort) {
        state.dir = -state.dir;
      } else {
        state.sort = key;
        state.dir = (key === 'symbol' || key === 'date' || key === 'entry') ? 1 : -1;
      }
      paintHeaders();
      apply();
    });
  }

  function onFilterChange() {
    state.q = qEl ? qEl.value.trim().toLowerCase() : '';
    state.grade = gradeEl ? gradeEl.value : 'all';
    state.minScore = scoreEl ? (parseFloat(scoreEl.value) || 0) : 0;
    state.confirmed = !!(confEl && confEl.checked);
    state.optimal = !!(optEl && optEl.checked);
    if (scoreOut) { scoreOut.textContent = String(state.minScore); }
    apply();
  }
  var filterNodes = [qEl, gradeEl, scoreEl, confEl, optEl];
  for (i = 0; i < filterNodes.length; i += 1) {
    if (!filterNodes[i]) { continue; }
    filterNodes[i].addEventListener('input', onFilterChange);
    filterNodes[i].addEventListener('change', onFilterChange);
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (qEl) { qEl.value = ''; }
      if (gradeEl) { gradeEl.value = 'all'; }
      if (scoreEl) { scoreEl.value = '0'; }
      if (confEl) { confEl.checked = false; }
      if (optEl) { optEl.checked = false; }
      state.sort = 'score';
      state.dir = -1;
      paintHeaders();
      onFilterChange();
      setStatus('Filtry wyczyszczone.', 'info');
    });
  }

  /* ── surowy JSON skanu (osadzony w dokumencie) ────────────────────── */
  var rawBtn = document.getElementById('btn-raw');
  var rawPre = document.getElementById('raw-json');
  var rawData = document.getElementById('scan-data');
  if (rawBtn && rawPre) {
    rawBtn.addEventListener('click', function () {
      if (!rawPre.hidden) {
        rawPre.hidden = true;
        rawBtn.textContent = 'Pokaż surowy JSON skanu';
        return;
      }
      var text = 'Brak danych skanu.';
      if (rawData) {
        try {
          text = JSON.stringify(JSON.parse(rawData.textContent || 'null'), null, 2);
        } catch (e) {
          text = 'Nie udało się sparsować osadzonego JSON-a skanu.';
        }
      }
      if (text.length > 200000) { text = text.slice(0, 200000) + '\\n… (obcięte)'; }
      rawPre.textContent = text;
      rawPre.hidden = false;
      rawBtn.textContent = 'Ukryj surowy JSON skanu';
    });
  }

  paintHeaders();
  apply();
})();
`;
