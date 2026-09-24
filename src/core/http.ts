/**
 * Warstwa HTTP: retry z exponential backoff, cache w KV, twarde limity czasu.
 *
 * Limity dostawców, które trzeba respektować:
 *  - Tradier sandbox: 60 żądań/min na token (nagłówki X-Ratelimit-*)
 *  - Finnhub free:    60 żądań/min
 * Dlatego każde żądanie ma retry na 429 i 5xx, a wyniki lądują w KV.
 */

export interface FetchOptions {
  /** Dodatkowe nagłówki */
  headers?: Record<string, string>;
  /** Metoda */
  method?: string;
  /** Ciało (dla POST) */
  body?: string;
  /** Limit czasu w ms (domyślnie 15 s) */
  timeoutMs?: number;
  /** Liczba prób (domyślnie 3) */
  retries?: number;
  /** Etykieta do logów */
  label?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodySnippet?: string;

  constructor(message: string, status: number, url: string, bodySnippet?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET/POST z retry. Zwraca sparsowany JSON albo rzuca HttpError. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
        body: opts.body,
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 600, 8000);
        const text = await res.text().catch(() => '');
        lastError = new HttpError(
          `${opts.label ?? url} -> HTTP ${res.status}`,
          res.status,
          url,
          text.slice(0, 300),
        );
        if (attempt < retries) {
          await sleep(waitMs);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(
          `${opts.label ?? url} -> HTTP ${res.status}`,
          res.status,
          url,
          text.slice(0, 300),
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      // Błąd sieci/timeout — ponawiamy; błąd HTTP 4xx już nie.
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt >= retries) throw err;
      await sleep(Math.min(2 ** attempt * 600, 8000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Prosty limiter: maksymalnie `perMinute` żądań, rozłożonych równomiernie. */
export class RateLimiter {
  private lastCall = 0;
  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** Czeka tyle, ile trzeba, żeby nie przekroczyć limitu. */
  async acquire(): Promise<void> {
    const minGap = 60_000 / this.perMinute;
    const now = Date.now();
    const wait = this.lastCall + minGap - now;
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }
}

/**
 * Uruchamia zadania z ograniczoną równoległością, zachowując kolejność wyników.
 * `stopOnError = false` (domyślnie) sprawia, że błąd jednego elementu nie przerywa
 * całości — wtedy w wyniku pojawia się undefined, a błąd trafia do listy błędów.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<{ results: (R | undefined)[]; errors: string[] }> {
  const results: (R | undefined)[] = new Array(items.length);
  const errors: string[] = [];
  let cursor = 0;

  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index]!;
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        errors.push(`${String(item)}: ${err instanceof Error ? err.message : String(err)}`);
        results[index] = undefined;
      }
    }
  });

  await Promise.all(runners);
  return { results, errors };
}

/** Cache w KV — miękko degraduje, gdy namespace nie jest podpięty. */export class KvCache {
  private readonly kv: KVNamespace | undefined;
  private readonly ttlSeconds: number;

  constructor(kv: KVNamespace | undefined, ttlSeconds: number) {
    this.kv = kv;
    this.ttlSeconds = ttlSeconds;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.kv) return undefined;
    try {
      const raw = await this.kv.get(key, 'json');
      return (raw as T | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlOverride?: number): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(60, ttlOverride ?? this.ttlSeconds),
      });
    } catch {
      /* cache jest opcjonalny — brak KV nie może wywalić skanu */
    }
  }

  /** Koszyk: pobierz z cache albo policz i zapisz. */
  async wrap<T>(key: string, producer: () => Promise<T>, ttlOverride?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    await this.set(key, value, ttlOverride);
    return value;
  }
}
