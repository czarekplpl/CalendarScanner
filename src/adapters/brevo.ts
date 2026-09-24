/**
 * ADAPTER: Brevo — wysyłka e-maili przez API v3.
 *
 * Kontrakt adaptera (żeby dało się podmienić dostawcę bez ruszania alertów):
 *   sendBrevoEmail({ apiKey, from, to, subject, html, text?, timeoutMs? }) -> { messageId }
 *   parseEmailAddress('Nazwa <a@b.pl>') -> { name, email }
 *
 * Dokumentacja: https://developers.brevo.com/reference/sendtransacemail
 * Endpoint: POST https://api.brevo.com/v3/smtp/email
 * Nagłówki: `api-key: <KLUCZ>` + Content-Type: application/json
 * Sukces:   HTTP 201 z {"messageId":"<...>"} — uwaga, 201, nie 200.
 * Błąd:     HTTP 400/401/403 z {"code":"...","message":"..."}
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NAJWAŻNIEJSZE ROZRÓŻNIENIE: klucz SMTP != klucz API v3
 * ─────────────────────────────────────────────────────────────────────────────
 * Brevo ma DWA różne rodzaje kluczy i tylko jeden z nich działa z tym endpointem:
 *
 *   SMTP     — ze strony https://app.brevo.com/settings/keys/smtp, wygląda jak
 *              `xsmtpsib-<długi ciąg>-<sufiks>`. Służy do logowania w SMTP
 *              (host smtp-relay.brevo.com, port 587) i NIE jest przyjmowany przez
 *              API v3. API odpowiada wtedy `401 {"message":"Key not found","code":"unauthorized"}`
 *              — komunikat jest mylący, bo sugeruje literówkę w kluczu, a klucz
 *              jest poprawny, tylko z niewłaściwej zakładki. Potwierdzone empirycznie.
 *
 *   API v3   — ze strony https://app.brevo.com/settings/keys/api (zakładka
 *              "API Keys"), zaczyna się od `xkeysib-`. TYLKO ten klucz działa
 *              z POST /v3/smtp/email.
 *
 * Dlatego rozpoznajemy prefiks `xsmtpsib-` jeszcze PRZED wysłaniem żądania i
 * rzucamy błąd, który wprost mówi, którego klucza potrzebujemy. Bez tego jedyne,
 * co widzisz w logach crona, to „HTTP 401 unauthorized” i szukanie błędu
 * w miejscu, w którym go nie ma.
 *
 * Zależności: wyłącznie globalny `fetch` (zgodnie z runtime Cloudflare Workers
 * i z `node --experimental-strip-types` w testach). Zero bibliotek zewnętrznych.
 */

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** Domyślny limit czasu żądania (ms). Cron nie może wisieć na zawieszonym API. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Prefiks klucza SMTP — rozpoznajemy go, żeby dać czytelny komunikat zamiast 401. */
const SMTP_KEY_PREFIX = 'xsmtpsib-';

const API_KEYS_URL = 'https://app.brevo.com/settings/keys/api';

export interface BrevoAddress {
  email: string;
  name?: string;
}

export interface SendBrevoEmailParams {
  apiKey: string;
  from: BrevoAddress;
  to: BrevoAddress;
  subject: string;
  html: string;
  /** Wersja tekstowa — opcjonalna, ale zalecana (klienty bez HTML, filtry spamu). */
  text?: string;
  /** Limit czasu żądania w ms; domyślnie 15 000. */
  timeoutMs?: number;
}

/** Odpowiedź sukcesu API v3 — `messageId` służy do korelacji z logami Brevo. */
interface BrevoSuccessBody {
  messageId?: string;
}

/** Odpowiedź błędu API v3. */
interface BrevoErrorBody {
  code?: string;
  message?: string;
}

/**
 * Zamienia HTML na przybliżoną wersję tekstową.
 *
 * Nie jest to pełny konwerter — chodzi o to, żeby `textContent` nigdy nie był
 * pusty, bo wiadomość bez części tekstowej częściej trafia do spamu. Blokowe
 * znaczniki zamieniamy na znak nowej linii, resztę znaczników usuwamy, a encje
 * zamieniamy z powrotem na znaki. Ten sam zestaw encji, co w `alerts/index.ts`.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parsuje nadawcę z `ALERT_EMAIL_FROM`. Obsługuje dwa formaty:
 *   `Nazwa <adres@domena>`  -> { name: 'Nazwa', email: 'adres@domena' }
 *   `adres@domena`          -> { email: 'adres@domena' }
 *
 * Brevo wymaga `sender.email`, a `sender.name` jest opcjonalne — więc przy złym
 * formacie (brak `@`, pusty nawias, śmieci po `>`) rzucamy błąd zamiast wysyłać
 * żądanie, które i tak wróciłoby jako HTTP 400 bez wskazania przyczyny.
 */
export function parseEmailAddress(raw: string): BrevoAddress {
  const value = raw.trim();
  if (!value) throw new Error('E-mail: ALERT_EMAIL_FROM jest pusty — podaj adres nadawcy.');

  const bracketed = /^(.*?)[<]([^>]*)[>]$/.exec(value);
  if (bracketed) {
    const name = (bracketed[1] ?? '').trim();
    const email = (bracketed[2] ?? '').trim();
    if (!email) {
      throw new Error(
        `E-mail: ALERT_EMAIL_FROM ma pusty adres w nawiasach: "${raw.trim()}". ` +
          'Poprawny format to "Nazwa <adres@domena>" albo sam adres.',
      );
    }
    if (!email.includes('@')) {
      throw new Error(
        `E-mail: ALERT_EMAIL_FROM nie zawiera adresu e-mail (brak "@"): "${email}". ` +
          'Poprawny format to "Nazwa <adres@domena>" albo sam adres.',
      );
    }
    return name ? { name, email } : { email };
  }

  if (value.includes('<') || value.includes('>')) {
    throw new Error(
      `E-mail: ALERT_EMAIL_FROM ma niepoprawny format: "${value}". ` +
        'Oczekiwany format to "Nazwa <adres@domena>" albo sam adres (np. scanner@twojadomena.pl).',
    );
  }

  if (!value.includes('@')) {
    throw new Error(
      `E-mail: ALERT_EMAIL_FROM nie jest adresem e-mail (brak "@"): "${value}". ` +
        'Oczekiwany format to "Nazwa <adres@domena>" albo sam adres (np. scanner@twojadomena.pl).',
    );
  }

  // Adres bez nawiasów ostrych, ale ze spacją w środku, to prawie zawsze nazwa
  // sklejona z adresem („Skaner skaner@domena.pl”) — brakuje nawiasów. Brevo
  // odrzuciłoby to jako HTTP 400 „sender email is not valid”, więc lepiej
  // powiedzieć wprost, czego brakuje w ALERT_EMAIL_FROM.
  if (/\s/.test(value)) {
    throw new Error(
      `E-mail: ALERT_EMAIL_FROM zawiera spację, ale nie ma nawiasów ostrych: "${value}". ` +
        'Jeśli chcesz podać nazwę nadawcy, użyj formatu "Nazwa <adres@domena>"; ' +
        'w przeciwnym razie podaj sam adres bez spacji.',
    );
  }

  return { email: value };
}

/** Buduje komunikat błędu z odpowiedzi API — zawsze z kodem HTTP i kodem Brevo. */
function describeApiError(status: number, body: BrevoErrorBody | null, rawText: string): string {
  const code = body?.code;
  const message = body?.message;
  const detail = code && message ? `${code}: ${message}` : message || code || rawText.slice(0, 200);
  return `Brevo HTTP ${status}: ${detail || 'brak treści odpowiedzi'}`;
}

/**
 * Wysyła e-mail przez Brevo API v3. Zwraca `messageId` do korelacji z logami.
 *
 * Rzuca `Error` z czytelnym komunikatem (kod HTTP + kod błędu Brevo) — wywołujący
 * (alerty) zbiera te komunikaty do listy błędów skanu, więc nie mogą być puste.
 */
export async function sendBrevoEmail(params: SendBrevoEmailParams): Promise<{ messageId: string }> {
  const { apiKey, from, to, subject, html, text, timeoutMs } = params;

  const key = apiKey.trim();
  if (!key) {
    throw new Error(
      'E-mail (Brevo): brak BREVO_API_KEY. Ustaw sekret: npx wrangler secret put BREVO_API_KEY ' +
        `(klucz API v3 z ${API_KEYS_URL}).`,
    );
  }

  // Rozpoznanie klucza SMTP PRZED żądaniem — API zwraca dla niego mylące 401
  // „Key not found”, które wygląda jak literówka, a jest błędem rodzaju klucza.
  if (key.startsWith(SMTP_KEY_PREFIX)) {
    throw new Error(
      'E-mail (Brevo): podany klucz to klucz SMTP (prefiks "xsmtpsib-"), a API v3 go nie przyjmuje ' +
        '(odpowiada 401 {"code":"unauthorized","message":"Key not found"}). ' +
        `Potrzebny jest klucz API v3 z zakładki "API Keys": ${API_KEYS_URL} ` +
        '(zaczyna się od "xkeysib-"). Klucz SMTP służy tylko do wysyłki przez SMTP ' +
        '(smtp-relay.brevo.com:587), nie do POST /v3/smtp/email.',
    );
  }

  if (!from.email) {
    throw new Error('E-mail (Brevo): brak adresu nadawcy — uzupełnij ALERT_EMAIL_FROM.');
  }
  if (!to.email) {
    throw new Error('E-mail (Brevo): brak adresu odbiorcy — uzupełnij ALERT_EMAIL_TO.');
  }

  // Brevo przyjmuje oba pola, ale część klientów pokazuje wyłącznie `textContent`
  // — dlatego gdy go nie podano, wyprowadzamy go z HTML-a zamiast wysyłać puste.
  const textContent = text && text.trim() ? text : htmlToText(html);

  const payload = {
    sender: from.name ? { name: from.name, email: from.email } : { email: from.email },
    to: [to.name ? { email: to.email, name: to.name } : { email: to.email }],
    subject,
    htmlContent: html,
    textContent,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.status === 201) {
      const data = (await res.json().catch(() => null)) as BrevoSuccessBody | null;
      // Przy 201 pole messageId jest zawsze obecne; `n/d` zostaje tylko na wypadek
      // zmiany kontraktu po stronie Brevo — brak id nie może wywalić wysłanego alertu.
      return { messageId: data?.messageId ?? 'n/d' };
    }

    const rawText = await res.text().catch(() => '');
    let parsed: BrevoErrorBody | null = null;
    try {
      parsed = JSON.parse(rawText) as BrevoErrorBody;
    } catch {
      parsed = null;
    }

    // 401 przy poprawnym nagłówku `api-key` to prawie zawsze klucz SMTP wklejony
    // z niewłaściwej zakładki — dopisujemy podpowiedź, żeby nie szukać błędu
    // w literówce.
    const hint =
      res.status === 401
        ? ` Sprawdź, czy to klucz API v3 z ${API_KEYS_URL} („API Keys”), a nie klucz SMTP z zakładki „SMTP”.`
        : '';
    throw new Error(describeApiError(res.status, parsed, rawText) + hint);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Brevo: przekroczono limit czasu ${timeoutMs ?? DEFAULT_TIMEOUT_MS} ms (POST ${ENDPOINT}).`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
