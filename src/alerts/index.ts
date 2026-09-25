/**
 * ALERTY: Telegram + e-mail (Brevo API v3, alternatywnie Resend) + rejestr deduplikacji.
 *
 * Zasada: JEDEN alert na spółkę i cykl wyników na dany próg. Progi:
 *   T30     — spółka weszła w okno ~30 dni przed wynikami (pierwsze powiadomienie)
 *   T14     — okno wejścia się zbliża (front ma sensowny czas życia)
 *   SCORE80 — układ wyjątkowo dobry, warto spojrzeć niezależnie od dnia
 *
 * Dzięki temu cron 2x dziennie nie zamienia kanału w śmietnik, ale gdy układ
 * się poprawia, dostajesz eskalację.
 */

import { parseEmailAddress, sendBrevoEmail } from '../adapters/brevo.ts';
import {
  alertKey,
  alertTier,
  alreadyAlerted,
  loadAlertRegistry,
  loadDailyAlertCount,
  markAlertedBatch,
  saveDailyAlertCount,
} from '../core/history.ts';
import type { AlertRecord, CalendarCandidate, Env, ScanResult } from '../types.ts';

/** Dostawca e-maila wybierany zmienną EMAIL_PROVIDER. */
type EmailProvider = 'brevo' | 'resend';

/** Domyślny dostawca e-maila, gdy EMAIL_PROVIDER nie jest ustawione. */
const DEFAULT_EMAIL_PROVIDER: EmailProvider = 'brevo';

export interface AlertDispatchResult {
  sent: number;
  skipped: number;
  /** Pominięte z powodu oceny poniżej MIN_ALERT_SCORE (są w dashboardzie i bazie) */
  belowThreshold: number;
  /** Pominięte, bo dzienny budżet alertów został już wykorzystany */
  dailyLimitReached: number;
  /** Ile alertów wysłano dziś łącznie (wliczając wcześniejsze przebiegi) */
  sentToday: number;
  channels: string[];
  errors: string[];
}

function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return 'n/d';
  return `${(v * 100).toFixed(digits)}%`;
}

function pp(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return 'n/d';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(digits)} pp`;
}

function timingLabel(timing: string): string {
  if (timing === 'bmo') return 'przed otwarciem (BMO)';
  if (timing === 'amc') return 'po zamknięciu (AMC)';
  return 'godzina nieznana';
}

/** Skrót alertu w jednej linii — do tytułu e-maila i pierwszej linii Telegrama. */
export function alertSubject(c: CalendarCandidate): string {
  return `[${c.grade} ${c.score}] ${c.symbol} — wyniki ${c.earnings.date} (T-${c.daysToEarnings})`;
}

/**
 * Treść alertu w HTML — wspólna dla Telegrama (obsługuje <b>, <i>, <code>)
 * i e-maila (pełny HTML). Dla Telegrama wywołujemy z variant='telegram'.
 */
export function formatAlertHtml(c: CalendarCandidate, variant: 'telegram' | 'email' = 'telegram'): string {
  const front = c.front;
  const back = c.back;
  const lines: string[] = [];

  const head = `<b>${alertSubject(c)}</b>`;
  lines.push(head);

  const confirmed = c.earnings.confirmed
    ? ''
    : ' <i>(data niepotwierdzona — może się przesunąć)</i>';
  lines.push(
    `Wyniki: <b>${c.earnings.date}</b> ${timingLabel(c.earnings.timing)}${confirmed} — ` +
      `T-${c.daysToEarnings} dni kalendarzowych / T-${c.tradingDaysToEarnings} sesji`,
  );

  if (front && back) {
    const inside = c.earningsInsideBackOnly
      ? 'wyniki PO wygaśnięciu frontu (bez krótkiej ekspozycji na gap)'
      : 'wyniki WEWNĄTRZ życia frontu (krótka noga łapie zdarzenie)';
    lines.push(
      `Nogi: front <code>${front.expiration}</code> (${front.dte} dni, IV ${pct(front.atmIv)}) → ` +
        `back <code>${back.expiration}</code> (${back.dte} dni, IV ${pct(back.atmIv)})`,
    );
    lines.push(`Układ: ${inside}`);
    lines.push(
      `Term structure: ${pp(c.termStructureSlope)} | Implied move frontu: ${pct(front.impliedMovePct)}` +
        (c.avgHistoricalMovePct ? ` vs. historyczny ${pct(c.avgHistoricalMovePct)}` : ''),
    );
    lines.push(
      `IV rank: ${c.ivRank === undefined ? 'brak historii (zbieram)' : `${c.ivRank}%`} | ` +
        `OI ATM: ${Math.min(front.atmOpenInterest, back.atmOpenInterest)} | ` +
        `spread ATM: ${pct(Math.max(front.atmSpreadPct, back.atmSpreadPct))}`,
    );
  }

  lines.push(`Spot: ${c.spot.toFixed(2)} | Sugerowane wejście: ${c.suggestedEntryDate ?? 'n/d'}`);

  if (c.flags.length > 0) lines.push(`Flagi: <code>${c.flags.join(' ')}</code>`);

  if (c.components.length > 0) {
    lines.push('<b>Punktacja:</b>');
    for (const comp of c.components) {
      lines.push(`• ${comp.label}: ${comp.points}/${comp.maxPoints}`);
    }
  }

  if (c.warnings.length > 0) {
    lines.push('<b>Uwaga:</b>');
    for (const w of c.warnings) lines.push(`• ${w}`);
  }

  if (variant === 'email') {
    // Stopka MUSI mówić prawdę o źródłach danych. Ustalone empirycznie:
    //  - IV, term structure, IV rank: tastytrade, AKTUALIZOWANE INTRADAY
    //    (pole implied-volatility-updated-at pokazuje kilka minut wstecz w trakcie
    //    sesji; przed otwarciem jest jeszcze z poprzedniego dnia — dlatego raport
    //    wysyłamy PO otwarciu, żeby zawierał najświeższy odczyt).
    //  - KURSY AKCJI: Finnhub.
    //  - CENY OPCJI (bid/ask): niedostępne na używanym koncie — implied move jest
    //    liczone modelem, a spreadu nie znamy. To jedyna realna luka.
    lines.push(
      '<hr style="border:none;border-top:1px solid #d0d7de;margin:16px 0">' +
        '<span style="color:#57606a;font-size:12px">' +
        'Narzędzie analityczne, nie rekomendacja inwestycyjna. ' +
        'Zmienność implikowana i term structure: tastytrade (odczyt intraday). ' +
        'Kursy: Finnhub. Ceny opcji (bid/ask) nie są dostępne w tym źródle — ' +
        'implied move jest szacowany modelowo, więc przed wejściem zweryfikuj ' +
        'spread i realną cenę struktury u swojego brokera.' +
        '</span>',
    );
    // Jasny motyw: ciemne tło bywa obcinane przez klientów pocztowych i źle
    // wygląda w większości skrzynek. Białe tło z ciemnym tekstem czyta się
    // naturalnie i nie zależy od ustawień klienta.
    return (
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
      'font-size:14px;line-height:1.65;color:#1f2328;background:#ffffff;padding:20px;max-width:760px">' +
      lines.join('<br>') +
      '</div>'
    );
  }
  return lines.join('\n');
}

/** Wersja czysto tekstowa (fallback dla e-maila i logów). */
export function formatAlertText(c: CalendarCandidate): string {
  return formatAlertHtml(c, 'telegram')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&');
}

/** Escape dla Telegram HTML — dane spółek mogą zawierać &, <, >. */
function escapeTg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram: brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** Wysyłka przez Resend — zostaje jako alternatywa dla Brevo (EMAIL_PROVIDER=resend). */
async function sendViaResend(env: Env, subject: string, html: string): Promise<void> {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  const from = env.ALERT_EMAIL_FROM;
  if (!key) {
    throw new Error(
      'E-mail (Resend): brak RESEND_API_KEY. Ustaw sekret: npx wrangler secret put RESEND_API_KEY ' +
        '(klucz z https://resend.com/api-keys).',
    );
  }
  if (!to || !from) throw new Error('E-mail: brak ALERT_EMAIL_TO lub ALERT_EMAIL_FROM');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Wysyłka przez Brevo API v3. Cała obsługa błędów (kod HTTP, kod błędu Brevo,
 * rozpoznanie klucza SMTP) siedzi w adapterze `adapters/brevo.ts`.
 *
 * Uwaga: Brevo wymaga OSOBNYCH pól `name` i `email`, więc nadawcę w formacie
 * "Nazwa <adres@domena>" trzeba rozdzielić — robi to `parseEmailAddress`.
 * Zły format zgłaszamy od razu i wprost, bo wysłanie takiego stringa jako
 * `sender.email` wróciłoby z API jako HTTP 400 bez wskazania przyczyny.
 */
async function sendViaBrevo(env: Env, subject: string, html: string): Promise<void> {
  const key = env.BREVO_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  const from = env.ALERT_EMAIL_FROM;
  if (!key) {
    throw new Error(
      'E-mail (Brevo): brak BREVO_API_KEY. Ustaw sekret: npx wrangler secret put BREVO_API_KEY ' +
        '— potrzebny jest klucz API v3 z https://app.brevo.com/settings/keys/api (zakładka "API Keys"), ' +
        'a NIE klucz SMTP z zakładki "SMTP".',
    );
  }
  if (!to) throw new Error('E-mail: brak ALERT_EMAIL_TO');
  if (!from) throw new Error('E-mail: brak ALERT_EMAIL_FROM');

  await sendBrevoEmail({
    apiKey: key,
    from: parseEmailAddress(from),
    to: parseEmailAddress(to),
    subject,
    html,
  });
}

/**
 * Wybiera dostawcę i wysyła e-mail.
 *
 * EMAIL_PROVIDER: "brevo" (domyślnie) albo "resend". Wartość nieznana kończy się
 * błędem, a nie cichym wybraniem dostawcy — literówka w nazwie dostawcy nie może
 * wyglądać jak awaria sieci.
 *
 * Wyjątek od reguły: gdy wprost wskazanego dostawcę wybrano DOMYŚLNIE, a brakuje
 * mu klucza, schodzimy na drugiego dostawcę, jeśli ten ma klucz. Dzięki temu
 * istniejąca konfiguracja z samym RESEND_API_KEY działa dalej, mimo że domyślnym
 * dostawcą jest teraz Brevo. Świadomy wybór (EMAIL_PROVIDER ustawione wprost)
 * nie podlega temu zejściu — wtedy brak klucza to błąd, nie niespodzianka.
 */
async function sendEmail(env: Env, subject: string, html: string): Promise<void> {
  const requested = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const explicit = requested !== '';
  if (explicit && requested !== 'brevo' && requested !== 'resend') {
    throw new Error(
      `E-mail: nieznany EMAIL_PROVIDER "${requested}" — dozwolone wartości to "brevo" albo "resend".`,
    );
  }
  const provider: EmailProvider = explicit ? (requested as EmailProvider) : DEFAULT_EMAIL_PROVIDER;

  if (provider === 'brevo') {
    if (!env.BREVO_API_KEY && !explicit && env.RESEND_API_KEY) {
      return sendViaResend(env, subject, html);
    }
    return sendViaBrevo(env, subject, html);
  }

  if (!env.RESEND_API_KEY && !explicit && env.BREVO_API_KEY) {
    return sendViaBrevo(env, subject, html);
  }
  return sendViaResend(env, subject, html);
}

/**
 * Rozsyła alerty dla wyniku skanu. Zwraca statystyki wysyłki.
 * Wywoływane tylko z crona (i z /scan, gdy body zawiera ?alerts=1).
 */
export async function dispatchAlerts(env: Env, scan: ScanResult): Promise<AlertDispatchResult> {
  const out: AlertDispatchResult = {
    sent: 0,
    skipped: 0,
    belowThreshold: 0,
    dailyLimitReached: 0,
    sentToday: 0,
    channels: [],
    errors: [],
  };

  const channels = (env.ALERT_CHANNELS ?? 'dashboard')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  out.channels = channels;

  const wantsTelegram = channels.includes('telegram');
  const wantsEmail = channels.includes('email');
  if (!wantsTelegram && !wantsEmail) return out;

  const maxAlerts = num(env, 'MAX_ALERTS_PER_RUN', 4);
  // Próg oceny: poniżej niego NIE wysyłamy alertu, ale kandydat zostaje w danych.
  // Domyślnie 60 — patrz uzasadnienie w wrangler.toml. Wartość 0 wyłącza próg.
  const minScore = num(env, 'MIN_ALERT_SCORE', 60);

  // ── DZIENNY BUDŻET ─────────────────────────────────────────────────────────
  // Limit na przebieg nie wystarcza: cron + ręczne uruchomienie dałyby 2x więcej
  // wiadomości. Licznik dzienny trzyma twardy budżet niezależnie od liczby skanów.
  const dailyLimit = num(env, 'MAX_ALERTS_PER_DAY', 4);
  const alreadySentToday = await loadDailyAlertCount(env, scan.asOf);
  const remainingToday = Math.max(0, dailyLimit - alreadySentToday);
  const budget = Math.min(maxAlerts, remainingToday);

  // Kandydaci są posortowani malejąco po ocenie (core/scan.ts), więc pierwsze
  // pozycje to NAJLEPSZE firmy. Bierzemy dokładnie tyle, ile wynosi budżet.
  // Gdy budżet wyczerpany, reszta liczy się jako dailyLimitReached — są widoczne
  // w dashboardzie i zapisane w bazie, tylko nie lecą powiadomieniem.
  const doWyslania = scan.candidates.filter((c) => c.score >= minScore).slice(0, budget);
  const ponadBudzet = scan.candidates.filter((c) => c.score >= minScore).length - doWyslania.length;
  const registry = await loadAlertRegistry(env);
  const sentAt = new Date().toISOString();
  // Rekordy zbieramy w pamięci i zapisujemy do KV JEDEN raz na końcu.
  // Rejestr to jeden klucz JSON, więc zapis per alert mnożyłby ruch (N zapisów
  // pełnego JSON-a) i zjadał dzienny limit zapisów KV.
  const pending: AlertRecord[] = [];
  let count = 0;

  // Liczymy kandydatów poniżej progu (dla raportu) — wysyłamy tylko `doWyslania`.
  out.belowThreshold = scan.candidates.filter((c) => c.score < minScore).length;
  out.dailyLimitReached = ponadBudzet;

  for (const candidate of doWyslania) {
    const tier = alertTier(candidate.daysToEarnings, candidate.score);
    const key = alertKey(candidate.symbol, candidate.earnings.date, tier);

    if (alreadyAlerted(registry, key)) {
      out.skipped++;
      continue;
    }

    const isEscalation = alreadyAlerted(
      registry,
      alertKey(candidate.symbol, candidate.earnings.date, 'T30'),
    );

    // Treść budujemy OSOBNO dla każdego kanału — to nie jest duplikacja, a konieczność:
    //  - Telegram: HTML w wąskim podzbiorze (<b>, <i>, <code>) i ze znakami & < >
    //    zamienionymi na encje, bo inaczej nazwa spółki z "&" rozwaliłaby wiadomość.
    //  - E-mail: pełny HTML (akapity, <hr>, kolory) i treść NIE escapowana, bo
    //    escapowanie pokazałoby użytkownikowi dosłowne znaczniki zamiast formatowania.
    const escalationNote = isEscalation ? '<i>Eskalacja — układ się poprawił.</i>\n' : '';
    const telegramBody = escalationNote + formatAlertHtml(candidate, 'telegram');
    const emailHtml = formatAlertHtml(candidate, 'email');
    const emailBody = isEscalation
      ? `<p><b>Eskalacja — układ się poprawił.</b></p>${emailHtml}`
      : emailHtml;

    const deliveredTo: string[] = [];
    if (wantsTelegram) {
      try {
        await sendTelegram(env, telegramBody);
        deliveredTo.push('telegram');
      } catch (err) {
        out.errors.push(`${candidate.symbol} telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (wantsEmail) {
      try {
        await sendEmail(env, alertSubject(candidate), emailBody);
        deliveredTo.push('email');
      } catch (err) {
        out.errors.push(`${candidate.symbol} email: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Jeśli żaden kanał nie przyjął wiadomości, NIE oznaczamy alertu jako wysłanego
    // — inaczej przy awarii Telegrama stracilibyśmy powiadomienie na stałe.
    if (deliveredTo.length === 0) continue;

    pending.push({
      key,
      symbol: candidate.symbol,
      earningsDate: candidate.earnings.date,
      score: candidate.score,
      sentAt,
      channels: deliveredTo,
    });
    out.sent++;
    count++;
  }

  await markAlertedBatch(env, registry, pending);

  // Aktualizacja licznika dziennego — jeden zapis KV na przebieg.
  out.sentToday = alreadySentToday + out.sent;
  if (out.sent > 0) {
    await saveDailyAlertCount(env, scan.asOf, out.sentToday);
  }

  scan.counts.alertsSent = out.sent;
  return out;
}

/** Alert zbiorczy: jedno podsumowanie zamiast N wiadomości (przydatne przy wielu kandydatach). */
export function formatDigest(scan: ScanResult): string {
  const lines = [
    `<b>Skaner wyników — ${scan.asOf}</b>`,
    `Uniwersum: ${scan.counts.universe} | w oknie alertu: ${scan.counts.inAlertWindow} | ` +
      `przeanalizowane: ${scan.counts.analyzed} | kandydaci: ${scan.counts.candidates}`,
    '',
  ];
  if (scan.candidates.length === 0) {
    lines.push('Brak kandydatów w oknie alertu.');
  } else {
    for (const c of scan.candidates.slice(0, 15)) {
      lines.push(
        `[${c.grade} ${c.score}] <b>${c.symbol}</b> — T-${c.daysToEarnings} do wyników ${c.earnings.date}` +
          (c.front ? `, front ${c.front.expiration} / back ${c.back?.expiration ?? 'n/d'}` : ''),
      );
    }
  }
  if (scan.errors.length > 0) {
    lines.push('', `<b>Błędy:</b> ${scan.errors.length}`);
    for (const e of scan.errors.slice(0, 5)) lines.push(`• ${e}`);
  }
  return lines.join('\n');
}
