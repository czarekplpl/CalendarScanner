/**
 * ALERTY: Telegram + e-mail (Resend) + rejestr deduplikacji.
 *
 * Zasada: JEDEN alert na spółkę i cykl wyników na dany próg. Progi:
 *   T30     — spółka weszła w okno ~30 dni przed wynikami (pierwsze powiadomienie)
 *   T14     — okno wejścia się zbliża (front ma sensowny czas życia)
 *   SCORE80 — układ wyjątkowo dobry, warto spojrzeć niezależnie od dnia
 *
 * Dzięki temu cron 2x dziennie nie zamienia kanału w śmietnik, ale gdy układ
 * się poprawia, dostajesz eskalację.
 */

import {
  alertKey,
  alertTier,
  alreadyAlerted,
  loadAlertRegistry,
  markAlertedBatch,
} from '../core/history.ts';
import type { AlertRecord, CalendarCandidate, Env, ScanResult } from '../types.ts';

export interface AlertDispatchResult {
  sent: number;
  skipped: number;
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
    lines.push(
      '<hr><i>Narzędzie analityczne, nie rekomendacja inwestycyjna. ' +
        'Dane opcyjne z sandboxa są opóźnione 15 minut.</i>',
    );
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#e6e6e6;background:#0f1115;padding:16px">${lines.join('<br>')}</div>`;
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

async function sendEmail(env: Env, subject: string, html: string): Promise<void> {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  const from = env.ALERT_EMAIL_FROM;
  if (!key) throw new Error('E-mail: brak RESEND_API_KEY');
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
 * Rozsyła alerty dla wyniku skanu. Zwraca statystyki wysyłki.
 * Wywoływane tylko z crona (i z /scan, gdy body zawiera ?alerts=1).
 */
export async function dispatchAlerts(env: Env, scan: ScanResult): Promise<AlertDispatchResult> {
  const out: AlertDispatchResult = { sent: 0, skipped: 0, channels: [], errors: [] };

  const channels = (env.ALERT_CHANNELS ?? 'dashboard')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  out.channels = channels;

  const wantsTelegram = channels.includes('telegram');
  const wantsEmail = channels.includes('email');
  if (!wantsTelegram && !wantsEmail) return out;

  const maxAlerts = num(env, 'MAX_ALERTS_PER_RUN', 25);
  const registry = await loadAlertRegistry(env);
  const sentAt = new Date().toISOString();
  // Rekordy zbieramy w pamięci i zapisujemy do KV JEDEN raz na końcu.
  // Rejestr to jeden klucz JSON, więc zapis per alert mnożyłby ruch (N zapisów
  // pełnego JSON-a) i zjadał dzienny limit zapisów KV.
  const pending: AlertRecord[] = [];
  let count = 0;

  for (const candidate of scan.candidates) {
    if (count >= maxAlerts) break;

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
    const text = formatAlertHtml(candidate, 'telegram');
    const body = isEscalation ? `<i>Eskalacja — układ się poprawił.</i>\n${text}` : text;

    const deliveredTo: string[] = [];
    if (wantsTelegram) {
      try {
        await sendTelegram(env, body);
        deliveredTo.push('telegram');
      } catch (err) {
        out.errors.push(`${candidate.symbol} telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (wantsEmail) {
      try {
        await sendEmail(env, alertSubject(candidate), escapeTg(body));
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
