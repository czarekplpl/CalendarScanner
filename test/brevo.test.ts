/**
 * Testy adaptera wysyłki e-maila przez Brevo API v3 (+ wyboru dostawcy w alertach).
 *
 * DLACZEGO TO JEST WAŻNE: wysyłka e-maila to jedyny fragment, którego błąd jest
 * cichy — cron kończy się sukcesem, a Ty dowiadujesz się o braku alertów wtedy,
 * gdy potrzebowałeś ich najbardziej. Do tego Brevo ma dwa rodzaje kluczy (SMTP
 * i API v3) wyglądające podobnie, a API odpowiada na niewłaściwy klucz mylącym
 * `401 Key not found`. Te testy pilnują, żeby:
 *   1. żądanie miało dokładnie ten kształt, którego wymaga API v3 (i HTTP 201
 *      był traktowany jako sukces — nie 200),
 *   2. klucz SMTP kończył się komunikatem wprost mówiącym, po jaki klucz iść,
 *   3. błąd API niósł kod HTTP i kod błędu Brevo,
 *   4. nadawca w formacie "Nazwa <adres@domena>" był rozdzielany, a zły format
 *      dawał czytelny błąd zamiast HTTP 400 z API.
 *
 * Sieci nie dotykamy: globalny `fetch` jest podmieniany na czas testu (wzorzec
 * `withCalls` z `test/adapters.test.ts`, rozszerzony o przechwycenie nagłówków,
 * bo to w nagłówku `api-key` siedzi klucz).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEmailAddress, sendBrevoEmail } from '../src/adapters/brevo.ts';
import { dispatchAlerts } from '../src/alerts/index.ts';
import worker from '../src/index.ts';
import type { CalendarCandidate, Env, ScanResult } from '../src/types.ts';

const API_URL = 'https://api.brevo.com/v3/smtp/email';

// ─────────────────────────────────────────────────────────────────────────────
// Atrapa fetch — przechwytuje URL, metodę, nagłówki i body każdego żądania
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function withCalls<T>(
  handler: (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: CapturedCall[]; error?: unknown }> {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: headersToObject(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    });
    const { status, body } = await handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return run()
    .then((result) => ({ result, calls }))
    .catch((error: unknown) => ({ result: undefined as T, calls, error }))
    .finally(() => {
      globalThis.fetch = original;
    });
}

/** Wyciąga komunikat błędu z wyniku `withCalls` — testy czytają treść, nie typ wyjątku. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Odpowiedź sukcesu API v3: HTTP 201 (nie 200!) z messageId. */
function brevoOk(messageId = 'abc-123@p1'): { status: number; body: unknown } {
  return { status: 201, body: { messageId } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kształt żądania i rozpoznanie sukcesu
// ─────────────────────────────────────────────────────────────────────────────

test('brevo: wysyła poprawne body i nagłówek api-key', async () => {
  const { result, calls, error } = await withCalls(
    () => brevoOk('msg-1'),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { name: 'Skaner', email: 'scanner@twojadomena.pl' },
        to: { email: 'ja@example.com' },
        subject: 'Temat',
        html: '<p>treść</p>',
      }),
  );

  assert.equal(error, undefined, errorMessage(error));
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, API_URL, 'endpoint API v3');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['api-key'], 'xkeysib-test', 'klucz jedzie w nagłówku api-key (nie Bearer)');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['Accept'], 'application/json');
  assert.deepEqual(call.body.sender, { name: 'Skaner', email: 'scanner@twojadomena.pl' });
  assert.deepEqual(call.body.to, [{ email: 'ja@example.com' }]);
  assert.equal(call.body.subject, 'Temat');
  assert.equal(call.body.htmlContent, '<p>treść</p>');
  assert.equal(result.messageId, 'msg-1');
});

test('brevo: HTTP 201 (nie 200) jest sukcesem i zwraca messageId', async () => {
  const ok = await withCalls(
    () => brevoOk('msg-201'),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
        text: 'x',
      }),
  );
  assert.equal(ok.error, undefined, '201 musi być traktowane jako sukces');
  assert.equal(ok.result.messageId, 'msg-201');

  // Kontrola: 200 z tym samym body NIE jest obsługiwanym kodem sukcesu —
  // gdyby ktoś zmienił warunek na `res.ok`, ten test padnie.
  const wrongCode = await withCalls(
    () => ({ status: 200, body: { messageId: 'msg-200' } }),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );
  assert.ok(wrongCode.error, 'odpowiedź inna niż 201 nie może być cicho uznana za sukces');
  assert.match(errorMessage(wrongCode.error), /HTTP 200/);
});

test('brevo: textContent jest brany z parametru, a bez niego wyprowadzany z HTML', async () => {
  const explicit = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>ignorowane</p>',
        text: 'wersja tekstowa',
      }),
  );
  assert.equal(explicit.calls[0]!.body.textContent, 'wersja tekstowa');

  const derived = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>Linia 1</p><p>Linia 2 &amp; więcej</p>',
      }),
  );
  const text = derived.calls[0]!.body.textContent as string;
  assert.match(text, /Linia 1/);
  assert.match(text, /Linia 2 & więcej/, 'encje wracają do znaków');
  assert.ok(!text.includes('<p>'), 'znaczniki HTML nie mogą trafić do wersji tekstowej');
});

test('brevo: name pojawia się w żądaniu tylko wtedy, gdy jest podane', async () => {
  const { calls } = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { name: 'Ja', email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );
  const body = calls[0]!.body;
  assert.deepEqual(body.sender, { email: 'a@b.pl' }, 'brak nazwy => samo email (bez name: undefined)');
  assert.deepEqual(body.to, [{ email: 'c@d.pl', name: 'Ja' }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Klucz SMTP vs klucz API v3 — najczęstsza pomyłka przy konfiguracji Brevo
// ─────────────────────────────────────────────────────────────────────────────

test('brevo: klucz SMTP (xsmtpsib-) daje błąd mówiący o kluczu API v3 — bez ruchu sieciowego', async () => {
  const { calls, error } = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: 'xsmtpsib-0123456789abcdef-fedcba9876543210',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );

  assert.ok(error, 'klucz SMTP nie może być wysłany do API');
  const msg = errorMessage(error);
  assert.match(msg, /SMTP/i);
  assert.match(msg, /API v3/i);
  assert.match(msg, /app\.brevo\.com\/settings\/keys\/api/, 'podpowiedź, gdzie wziąć właściwy klucz');
  assert.match(msg, /xkeysib-/, 'mówi, jak wygląda poprawny klucz');
  assert.equal(calls.length, 0, 'przy jawnie złym kluczu nie ma po co ruszać sieci');
});

test('brevo: HTTP 401 unauthorized => błąd niesie kod HTTP i kod błędu Brevo', async () => {
  const { error } = await withCalls(
    () => ({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } }),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );

  const msg = errorMessage(error);
  assert.match(msg, /Brevo HTTP 401/);
  assert.match(msg, /unauthorized/, 'kod błędu Brevo musi być widoczny w logu crona');
  assert.match(msg, /Key not found/, 'komunikat dostawcy też, bo bywa jedyną wskazówką');
  assert.match(msg, /API Keys|klucz SMTP/, '401 to najczęściej klucz z niewłaściwej zakładki');
});

test('brevo: HTTP 400 => błąd zawiera kod i komunikat Brevo', async () => {
  const { error } = await withCalls(
    () => ({ status: 400, body: { code: 'invalid_parameter', message: 'sender email is not valid' } }),
    () =>
      sendBrevoEmail({
        apiKey: 'xkeysib-test',
        from: { email: 'zle' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );

  const msg = errorMessage(error);
  assert.match(msg, /Brevo HTTP 400/);
  assert.match(msg, /invalid_parameter/);
  assert.match(msg, /sender email is not valid/);
});

test('brevo: brak (albo pusty) klucza API => czytelny błąd z nazwą zmiennej', async () => {
  const missing = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: '',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );
  assert.match(errorMessage(missing.error), /BREVO_API_KEY/);
  assert.equal(missing.calls.length, 0);

  const blank = await withCalls(
    () => brevoOk(),
    () =>
      sendBrevoEmail({
        apiKey: '   ',
        from: { email: 'a@b.pl' },
        to: { email: 'c@d.pl' },
        subject: 'S',
        html: '<p>x</p>',
      }),
  );
  assert.match(errorMessage(blank.error), /BREVO_API_KEY/, 'same spacje to też brak klucza');
});

// ─────────────────────────────────────────────────────────────────────────────
// Parsowanie nadawcy / odbiorcy
// ─────────────────────────────────────────────────────────────────────────────

test('parseEmailAddress: "Skaner <a@b.pl>" => nazwa i adres rozdzielone', () => {
  assert.deepEqual(parseEmailAddress('Skaner <a@b.pl>'), { name: 'Skaner', email: 'a@b.pl' });
  assert.deepEqual(parseEmailAddress('  Skaner Alertów  < a@b.pl >  '), {
    name: 'Skaner Alertów',
    email: 'a@b.pl',
  });
  // Nazwa może zawierać spacje i przecinki (np. "Nazwa, Inc.") — bierzemy wszystko przed '<'.
  assert.deepEqual(parseEmailAddress('Nazwa, Inc. <a@b.pl>'), { name: 'Nazwa, Inc.', email: 'a@b.pl' });
});

test('parseEmailAddress: sam adres => tylko email (bez pola name)', () => {
  assert.deepEqual(parseEmailAddress('a@b.pl'), { email: 'a@b.pl' });
  assert.deepEqual(parseEmailAddress('  a@b.pl  '), { email: 'a@b.pl' });
  // Puste nawiasy ostre nie mogą udawać nazwy.
  assert.deepEqual(parseEmailAddress('<a@b.pl>'), { email: 'a@b.pl' });
});

test('parseEmailAddress: zły format => czytelny błąd po polsku', () => {
  const cases = ['skaner', 'scanner@twojadomena.pl <bez-adresu>', 'Skaner <brakmalpy>', 'Skaner skaner@twojadomena.pl'];
  for (const raw of cases) {
    assert.throws(
      () => parseEmailAddress(raw),
      (err: unknown) => {
        const msg = errorMessage(err);
        return (
          /E-mail:/.test(msg) &&
          /ALERT_EMAIL_FROM/.test(msg) &&
          /@/.test(msg) &&
          /Nazwa <adres@domena>/.test(msg)
        );
      },
      `format "${raw}" musi dać czytelny błąd`,
    );
  }
  // Sam brak adresu (pusty string) to inny przypadek brzegowy, ale komunikat
  // nadal musi wskazywać zmienną.
  assert.throws(() => parseEmailAddress('   '), /ALERT_EMAIL_FROM/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Limit czasu
// ─────────────────────────────────────────────────────────────────────────────

test('brevo: przekroczony limit czasu daje błąd z wartością limitu', { timeout: 5000 }, async () => {
  const original = globalThis.fetch;
  // fetch, który respektuje sygnał i „wisi” dłużej niż limit — jak zawieszone API.
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        sendBrevoEmail({
          apiKey: 'xkeysib-test',
          from: { email: 'a@b.pl' },
          to: { email: 'c@d.pl' },
          subject: 'S',
          html: '<p>x</p>',
          timeoutMs: 50,
        }),
      (err: unknown) => {
        const msg = errorMessage(err);
        assert.match(msg, /limit czasu/i);
        assert.match(msg, /50 ms/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wybór dostawcy w alertach (EMAIL_PROVIDER) — spięcie z realną wysyłką alertu
// ─────────────────────────────────────────────────────────────────────────────

function candidate(overrides: Partial<CalendarCandidate> = {}): CalendarCandidate {
  return {
    symbol: 'NKE',
    spot: 74.31,
    earnings: { symbol: 'NKE', date: '2026-10-20', timing: 'amc', confirmed: true },
    daysToEarnings: 26,
    tradingDaysToEarnings: 18,
    earningsInsideBackOnly: true,
    score: 82,
    grade: 'A',
    components: [],
    flags: [],
    warnings: [],
    ...overrides,
  };
}

function scanWith(candidates: CalendarCandidate[]): ScanResult {
  return {
    generatedAt: '2026-09-24T21:10:04.512Z',
    asOf: '2026-09-24',
    config: { alertMinDays: 25, alertMaxDays: 45, optionsProvider: 'tradier', earningsProvider: 'finnhub', tradierEnv: 'sandbox' },
    counts: { universe: 200, withUpcomingEarnings: 37, inAlertWindow: 11, analyzed: 11, candidates: candidates.length, alertsSent: 0 },
    candidates,
    watchlistOnly: [],
    errors: [],
    durationMs: 1000,
  };
}

function emailEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALERT_CHANNELS: 'email',
    ALERT_EMAIL_TO: 'Ja <ja@example.com>',
    ALERT_EMAIL_FROM: 'Skaner <scanner@twojadomena.pl>',
    BREVO_API_KEY: 'xkeysib-test',
    ...overrides,
  };
}

test('dispatchAlerts: z BREVO_API_KEY wysyła przez Brevo z rozdzielonym nadawcą i odbiorcą', async () => {
  const { result, calls, error } = await withCalls(
    () => brevoOk('alert-1'),
    () => dispatchAlerts(emailEnv(), scanWith([candidate()])) as unknown as Promise<{ sent: number; errors: string[] }>,
  );

  assert.equal(error, undefined, errorMessage(error));
  const dispatch = result as { sent: number; errors: string[] };
  assert.deepEqual(dispatch.errors, []);
  assert.equal(dispatch.sent, 1);
  assert.equal(calls.length, 1, 'tylko jeden e-mail, bez ruchu do Resend');
  const call = calls[0]!;
  assert.equal(call.url, API_URL);
  assert.equal(call.headers['api-key'], 'xkeysib-test');
  assert.deepEqual(call.body.sender, { name: 'Skaner', email: 'scanner@twojadomena.pl' });
  assert.deepEqual(call.body.to, [{ email: 'ja@example.com', name: 'Ja' }]);
  assert.equal(call.body.subject, '[A 82] NKE — wyniki 2026-10-20 (T-26)');
  // Treść alertu idzie w tej samej postaci, co dotąd do Resenda: HTML wariantu
  // Telegrama z aescapowanymi znakami (`alerts/index.ts` robi to celowo).
  const html = call.body.htmlContent as string;
  assert.match(html, /NKE/);
  assert.match(html, /2026-10-20/);
  assert.match(call.body.textContent as string, /NKE/, 'wersja tekstowa nie może być pusta');
});

test('dispatchAlerts: EMAIL_PROVIDER=resend wysyła przez Resend (Brevo zostaje nieużyte)', async () => {
  const { result, calls } = await withCalls(
    () => ({ status: 200, body: { id: 'email-1' } }),
    () =>
      dispatchAlerts(
        emailEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' }),
        scanWith([candidate()]),
      ) as unknown as Promise<{ sent: number; errors: string[] }>,
  );

  assert.equal((result as { sent: number }).sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /api\.resend\.com\/emails/);
  assert.equal((calls[0]!.headers.Authorization ?? '') as string, 'Bearer re_test');
});

test('dispatchAlerts: EMAIL_PROVIDER=brevo bez BREVO_API_KEY => błąd mówi KTÓREGO klucza brakuje', async () => {
  const { result, calls } = await withCalls(
    () => brevoOk(),
    () =>
      dispatchAlerts(
        emailEnv({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: undefined, RESEND_API_KEY: 're_test' }),
        scanWith([candidate()]),
      ) as unknown as Promise<{ sent: number; errors: string[] }>,
  );

  const dispatch = result as { sent: number; errors: string[] };
  assert.equal(calls.length, 0, 'brak klucza = żadnego ruchu sieciowego');
  assert.equal(dispatch.sent, 0, 'bez wysyłki nie ma czego zapisywać w rejestrze');
  assert.equal(dispatch.errors.length, 1);
  assert.match(dispatch.errors[0]!, /BREVO_API_KEY/);
  assert.match(dispatch.errors[0]!, /app\.brevo\.com\/settings\/keys\/api/);
});

test('dispatchAlerts: EMAIL_PROVIDER bez wartości => Brevo, a przy samym RESEND_API_KEY zejście na Resend', async () => {
  // Domyślny dostawca to Brevo — bez EMAIL_PROVIDER i z kluczem Brevo jedziemy Brevo.
  const byDefault = await withCalls(
    () => brevoOk(),
    () => dispatchAlerts(emailEnv(), scanWith([candidate()])) as unknown as Promise<{ sent: number }>,
  );
  assert.equal((byDefault.result as { sent: number }).sent, 1);
  assert.equal(byDefault.calls[0]!.url, API_URL);

  // Stara konfiguracja (tylko RESEND_API_KEY) musi działać dalej: skoro dostawcę
  // wybrano domyślnie, a brak mu klucza, schodzimy na Resend zamiast nic nie wysłać.
  const legacy = await withCalls(
    () => ({ status: 200, body: { id: 'legacy-1' } }),
    () =>
      dispatchAlerts(
        emailEnv({ BREVO_API_KEY: undefined, RESEND_API_KEY: 're_test' }),
        scanWith([candidate()]),
      ) as unknown as Promise<{ sent: number; errors: string[] }>,
  );
  assert.deepEqual((legacy.result as { errors: string[] }).errors, []);
  assert.equal((legacy.result as { sent: number }).sent, 1);
  assert.match(legacy.calls[0]!.url, /api\.resend\.com\/emails/);
  assert.equal(legacy.calls[0]!.body.from, 'Skaner <scanner@twojadomena.pl>', 'Resend przyjmuje nadawcę jako string');
});

test('dispatchAlerts: nieznany EMAIL_PROVIDER => błąd, nie cichy wybór dostawcy', async () => {
  const { result, calls } = await withCalls(
    () => brevoOk(),
    () =>
      dispatchAlerts(emailEnv({ EMAIL_PROVIDER: 'sendgrid' }), scanWith([candidate()])) as unknown as Promise<{
        sent: number;
        errors: string[];
      }>,
  );

  const dispatch = result as { sent: number; errors: string[] };
  assert.equal(dispatch.sent, 0);
  assert.equal(calls.length, 0);
  assert.match(dispatch.errors[0]!, /EMAIL_PROVIDER/);
  assert.match(dispatch.errors[0]!, /sendgrid/);
});

test('dispatchAlerts: klucz SMTP w BREVO_API_KEY ląduje w błędzie alertu z podpowiedzią', async () => {
  const { result, calls } = await withCalls(
    () => brevoOk(),
    () =>
      dispatchAlerts(
        emailEnv({ BREVO_API_KEY: 'xsmtpsib-abc-123' }),
        scanWith([candidate()]),
      ) as unknown as Promise<{ errors: string[] }>,
  );

  const dispatch = result as { errors: string[] };
  assert.equal(calls.length, 0);
  assert.equal(dispatch.errors.length, 1);
  assert.match(dispatch.errors[0]!, /SMTP/);
  assert.match(dispatch.errors[0]!, /API v3/);
  assert.match(dispatch.errors[0]!, /xkeysib-|API Keys/);
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/health — diagnostyka musi wskazywać klucz TEGO dostawcy, który jest wybrany
// ─────────────────────────────────────────────────────────────────────────────

async function healthMissing(env: Env): Promise<string[]> {
  const res = await worker.fetch(
    new Request('https://scanner.example.com/api/health'),
    env,
    {} as ExecutionContext,
  );
  const data = (await res.json()) as { missing: string[] };
  return data.missing;
}

/** Env kompletny poza kluczem e-mail — żeby `missing` zawierało wyłącznie sprawę e-maila. */
function healthEnv(overrides: Partial<Env> = {}): Env {
  return {
    FINNHUB_API_KEY: 'k',
    TRADIER_API_KEY: 'k',
    ALERT_CHANNELS: 'email',
    ALERT_EMAIL_TO: 'ja@example.com',
    ALERT_EMAIL_FROM: 'scanner@twojadomena.pl',
    ...overrides,
  };
}

test('health: bez EMAIL_PROVIDER wskazuje Brevo jako pierwszego dostawcę', async () => {
  const missing = await healthMissing(healthEnv());
  assert.equal(missing.length, 1, `oczekiwano jednego braku, jest: ${missing.join('; ')}`);
  const msg = missing[0]!;
  assert.match(msg, /BREVO_API_KEY/);
  assert.match(msg, /nie SMTP/, 'diagnostyka ma ostrzegać przed kluczem SMTP');
  // Resend zostaje wymieniony tylko jako alternatywa — Brevo musi być nazwane pierwsze.
  assert.ok(
    msg.indexOf('BREVO_API_KEY') < msg.indexOf('RESEND_API_KEY'),
    `Brevo ma być domyślnym dostawcą, a komunikat mówi: ${msg}`,
  );
});

test('health: z BREVO_API_KEY nie zgłasza braków; z EMAIL_PROVIDER=resend pyta o RESEND_API_KEY', async () => {
  assert.deepEqual(await healthMissing(healthEnv({ BREVO_API_KEY: 'xkeysib-test' })), []);

  const resend = await healthMissing(healthEnv({ EMAIL_PROVIDER: 'resend' }));
  assert.deepEqual(resend, ['RESEND_API_KEY']);

  // Jawny wybór Brevo bez klucza Brevo to brak, nawet gdy leży obok klucz Resenda
  // (świadomy wybór dostawcy nie podlega cichemu zejściu na innego).
  const explicitBrevo = await healthMissing(healthEnv({ EMAIL_PROVIDER: 'brevo', RESEND_API_KEY: 're_test' }));
  assert.match(explicitBrevo[0]!, /BREVO_API_KEY/);
});
