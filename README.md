# Skaner wyników — kalendarze na ekspansję IV

Znajduje duże spółki z giełdy US **~30 dni przed publikacją wyników** i ocenia, czy nadają się
pod **long calendar spread** rozgrywany na wzroście zmienności implikowanej (IV).
Działa jako Cloudflare Worker z cronem, wysyła alerty i wystawia dashboard.

---

## 1. Co to właściwie robi

Dwa razy dziennie (po zamknięciu i przed otwarciem sesji US) skaner:

1. Pobiera kalendarz wyników dla całego rynku US.
2. Przecina go z uniwersum **200 największych spółek US** (+ opcjonalnie 38 najbardziej
   płynnych ETF-ów — patrz `INCLUDE_ETFS`).
3. Wybiera spółki, które raportują **za 25–45 dni** (czyli alert wpada ~30 dni przed).
4. Dla każdej z nich pobiera łańcuchy opcji i **liczy IV samodzielnie** (Black-Scholes
   + solver zmienności — nie zależy od greków dostawcy).
5. Dobiera nogi kalendarza: **front wygasa tuż przed wynikami**, back — z zapasem po nich.
6. Ocenia układ w skali 0–100 i wysyła alert, gdy ocena jest sensowna.

### Struktura, którą skaner typuje

```
        wchodzisz          zamykasz          WYNIKI
            │                  │                │
   ─────────┼──────────────────┼────────────────┼──────────►  czas
            │                  │                │
         front ────────────────┘                │      (krótka noga, wygasa
            │                                   │       PRZED publikacją)
         back ──────────────────────────────────┴──────►  (długa noga, obejmuje event)
```

**Wejście przed wynikami, zamknięcie przed publikacją.** Zysk pochodzi z tego, że:

- premia eventowa napływa do **krótkiego** wygaśnięcia najmocniej, więc term structure
  się wypłaszcza/odwraca,
- Ty jesteś **long back / short front**, czyli trzymasz dłuższą nogę, która zyskuje na
  wzroście zmienności, podczas gdy krótsza — którą sprzedałeś — szybciej traci na rzecz czasu,
- zamykasz pozycję **przed publikacją**, więc nie bierzesz na siebie gapu.

Dlatego skaner premiuje układy, w których **front wygasa 1–10 dni przed wynikami**
(`STREFA-DOCELOWA`), a karze te, w których wyniki siedzą w krótkiej nodze
(`WYNIKI-W-FRONCIE` — bo wtedy musisz być zdyscyplinowany z wyjściem).

---

## 2. Szybki start (15 minut)

### Krok 1 — klucze API (oba darmowe)

| Co | Gdzie | Po co |
|---|---|---|
| Finnhub | https://finnhub.io/register | kalendarz wyników (darmowy plan: 60 zapytań/min) |
| Tradier | https://developer.tradier.com/ | łańcuchy opcji (darmowy sandbox) |
| Telegram | napisz do `@BotFather` → `/newbot` | alerty na telefon |
| Resend | https://resend.com | alerty e-mail (opcjonalnie) |

> **Tradier sandbox a greki:** darmowy sandbox **nie zwraca greków ani IV** — te pola
> dostarcza ORATS tylko na koncie brokerskim. Skaner radzi sobie z tym, licząc IV
> samodzielnie z cen opcji. Danymi z sandboxa są **opóźnione 15 minut** — dla planowania
> pozycji na 30 dni naprzód to bez znaczenia.

Aby poznać swój `TELEGRAM_CHAT_ID`: napisz cokolwiek do swojego bota, potem otwórz
`https://api.telegram.org/bot<TWOJ_TOKEN>/getUpdates` i poszukaj `"chat":{"id":...}`.

### Krok 2 — instalacja

```bash
cd earnings-iv-scanner
npm install
```

### Krok 3 — test lokalny BEZ chmury (zalecane)

Utwórz plik `.dev.vars` (jest w `.gitignore`, więc nie trafi do repo):

```ini
FINNHUB_API_KEY=twoj_klucz_finnhub
TRADIER_API_KEY=twoj_klucz_tradier
```

Uruchom skan na żywo:

```bash
npm run scan:local                       # tabela w terminalu
npm run scan:local -- --html --json      # + dashboard i JSON w test-output/
npm run scan:local -- --symbols=NVDA,MU  # debug konkretnych spółek
npm run scan:local -- --include-etfs     # dolicz ETF-y
```

Jeśli widzisz tabelę z ocenami i nogami kalendarza — klucze działają i logika czyta rynek.
**Dopiero teraz** sens wdrożenie do chmury.

### Krok 4 — deploy na Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create STATE
```

Wklej `id` z outputu do `wrangler.toml` (odkomentuj sekcję `[[kv_namespaces]]`).

Sekrety:

```bash
npx wrangler secret put FINNHUB_API_KEY
npx wrangler secret put TRADIER_API_KEY
npx wrangler secret put API_KEY              # dowolny długi losowy ciąg — chroni /api/*
npx wrangler secret put TELEGRAM_BOT_TOKEN   # opcjonalnie
npx wrangler secret put TELEGRAM_CHAT_ID     # opcjonalnie
npx wrangler secret put RESEND_API_KEY       # opcjonalnie
```

Deploy:

```bash
npx wrangler deploy
```

Adresy po wdrożeniu:

| Trasa | Opis |
|---|---|
| `https://earnings-iv-scanner.<twoj-subdomain>.workers.dev/` | dashboard (publiczny) |
| `/api/scan` | ostatni wynik JSON (wymaga `x-api-key`) |
| `/api/scan?refresh=1` | wymusza nowy skan (wymaga klucza, trwa 2–4 min) |
| `/api/health` | diagnostyka konfiguracji — **od tego zacznij po deployu** |
| `POST /scan?alerts=1` | ręczny skan + wysyłka alertów |

Sprawdź:

```bash
curl https://twoj-worker.workers.dev/api/health
```

`missing` musi być puste. Cron wystartuje sam o 11:10 i 21:10 UTC w dni robocze.

### Krok 5 — Cloudflare Access (opcjonalnie, ale zalecane)

Dashboard jest publiczny (nie zawiera sekretów), ale pokazuje Twoje wyniki. Jeśli chcesz go
zamknąć — w panelu Cloudflare: **Zero Trust → Access → Applications** i dodaj aplikację dla
`earnings-iv-scanner.<subdomain>.workers.dev` z regułą na swój e-mail.

---

## 3. Jak czytać wynik

Każdy kandydat ma ocenę 0–100 rozbitą na pięć składowych. Rozwinięcie wiersza w dashboardzie
pokazuje pełne uzasadnienie każdej z nich.

| Składowa | Waga | Za co odpowiada |
|---|---|---|
| Umiejscowienie wyników | 34 | gdzie wyniki wypadają względem nóg — **najważniejsze** |
| Nachylenie term structure | 22 | czy front jest tańszy niż back (teza strategii) |
| Taniość opcjonalności | 16 | implied move vs. historyczny ruch po wynikach + poziom IV |
| Płynność kalendarza | 18 | open interest ATM i spread bid-ask |
| IV rank | 10 | percentyl własnej IV z historii zbieranej przez skaner |

### Flagi

| Flaga | Znaczenie |
|---|---|
| `STREFA-DOCELOWA` | front wygasa 1–10 dni przed wynikami — układ, którego szukamy |
| `FRONT-NA-WYNIKACH` | front wygasa w dniach wyników (±3 dni) — pin risk |
| `WYNIKI-W-FRONCIE` | krótka noga zawiera zdarzenie — **musisz** zamknąć przed publikacją |
| `KONTANGO` | back IV wyraźnie wyższa od front — jest miejsce na ekspansję |
| `TANIA-OPCJONALNOSC` | rynek wycenia mniejszy ruch niż typowy historyczny |
| `IV-NISKO` | IV niska względem własnej historii spółki |
| `PLYNNY` | OI ATM co najmniej 3× próg — struktura wykonalna |
| `GOTOWY-DO-ANALIZY` | ocena ≥ 70 i data wyników potwierdzona |

### Twarde ograniczenie oceny

Jeśli w układzie występuje **którykolwiek** z problemów krytycznych, ocena jest ścinana do 40 —
żadna kombinacja plusów nie wypromuje układu, którego nie należy brać:

- front wygasa głęboko po wynikach **przy niepotwierdzonej dacie**,
- open interest ATM poniżej progu (`MIN_OPEN_INTEREST`),
- term structure silnie odwrócona (premia już zrealizowana),
- spread bid-ask ATM powyżej 15%.

### Ocena literowa

| Ocena | Próg | Co robić |
|---|---|---|
| A | ≥ 78 | pełna analiza, warto sprawdzić łańcuch ręcznie |
| B | ≥ 63 | na krótką listę |
| C | ≥ 48 | obserwuj, może się poprawić za kilka dni |
| D | < 48 | odpuść |

### Czego skaner NIE robi

- **Nie sprawdza, czy strike ma sens fundamentalnie** — nie wie o dywidendach, splittach,
  planowanych przejęciach ani o tym, że spółka właśnie ostrzegła o wynikach.
- **Nie zarządza pozycją** — sugerowana data wejścia to punkt startowy, nie sygnał.
- **Nie uwzględnia earnings whisper** ani oczekiwań analityków.
- **Implied move** liczony z cen opcji w sandboxie jest opóźniony 15 minut.
- **Historyczny ruch po wynikach** z Finnhuba to proxy (niespodzianka na EPS), nie realny
  ruch kursu. Skaner oznacza to jako przybliżenie i nie opiera na tym kluczowej decyzji.

---

## 4. Konfiguracja

Wszystko w `[vars]` w `wrangler.toml`. Zmiana wymaga `npx wrangler deploy`.

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `ALERT_MIN_DAYS` / `ALERT_MAX_DAYS` | `25` / `45` | okno alertu — dni do wyników |
| `MAX_DEEP_ANALYSIS` | `40` | ile spółek analizować głęboko (chroni limity API) |
| `MIN_OPEN_INTEREST` | `100` | minimalny OI ATM, by uznać strukturę za wykonalną |
| `INCLUDE_ETFS` | `false` | dolicz 38 płynnych ETF-ów (patrz ostrzeżenie niżej) |
| `TRADIER_ENV` | `sandbox` | `production` = konto brokerskie (real-time + greki ORATS) |
| `ALERT_CHANNELS` | `dashboard,telegram,email` | kanały alertów |
| `REQUIRE_API_KEY` | `true` | czy `/api/*` wymaga nagłówka `x-api-key` |
| `MAX_ALERTS_PER_RUN` | `25` | bezpiecznik na liczbę alertów w jednym przebiegu |

> **`INCLUDE_ETFS` — czytaj przed włączeniem.** ETF nie ma wyników spółki. Kalendarz zwróci
> dla niego datę dystrybucji, nie raportu. Włączaj tylko wtedy, gdy świadomie chcesz patrzeć
> na term structure ETF-ów wokół wyników ich największych składników lub posiedzenia Fed —
> każdy taki kandydat dostaje ostrzeżenie w wyniku.

### Deduplikacja alertów

Jeden alert na spółkę i cykl wyników na dany próg:

- `T30` — pierwsze wejście w okno (~30 dni przed),
- `T14` — przypomnienie, gdy okno wejścia się zbliża,
- `SCORE80` — eskalacja, gdy ocena przebije 80.

Cron chodzi 2× dziennie, więc bez tego dostałbyś ten sam komunikat kilkadziesiąt razy.

---

## 5. Koszty i limity

| Zasób | Limit darmowy | Zużycie skanera |
|---|---|---|
| Cloudflare Workers | 100 000 żądań/dzień, cron w cenie | 2 przebiegi dziennie |
| Cloudflare KV | 100 000 odczytów, 1 000 zapisów/dzień | ~2 zapisy na spółkę + 2 na przebieg (rejestr alertów zapisywany raz, nie per alert) |
| Finnhub | 60 zapytań/min | 2–3 zapytania (kalendarz + historia) |
| Tradier (sandbox) | 60 zapytań/min | ~5 zapytań na analizowaną spółkę |
| Resend | 100 maili/dzień | 1 na alert |

Dla 40 analizowanych spółek przebieg zużywa ~200 zapytań do Tradiera. Limiter w kodzie
rozciąga to na ~3–4 minuty, żeby nie przekroczyć 60/min. **Cron Cloudflare ma limit czasu
wykonania** — przy `MAX_DEEP_ANALYSIS` powyżej ~60 spółek rozważ podział na dwa przebiegi.

---

## 6. Struktura projektu

```
src/
  index.ts                  Worker: routing, cron, autoryzacja
  types.ts                  typy współdzielone
  core/
    scan.ts                 orkiestracja skanu (kalendarz → uniwersum → ocena)
    scoring.ts              ocena kalendarza — CAŁA logika decyzyjna + uzasadnienia
    blackscholes.ts         BS, solver IV (kryterium stopu w przestrzeni IV), greki
    market.ts               kalendarz sesji US, święta, dni sesyjne
    history.ts              historia IV (IV rank) i deduplikacja alertów w KV
    http.ts                 fetch z retry, limiter, cache KV, mapa z limitem
  adapters/
    finnhub.ts              kalendarz wyników + historia niespodzianek
    tradier.ts              łańcuchy opcji + wybór nóg kalendarza
  alerts/index.ts           Telegram, e-mail (Resend), treść alertów
  ui/dashboard.ts           dashboard HTML (samodzielny, zero CDN)
  data/
    universe-snapshot.ts    200 spółek (snapshot wrzesień 2026)
    etf-universe.ts         38 płynnych ETF-ów
scripts/scan-local.ts       lokalny skan bez Cloudflare
test/                       testy (72 przypadki)
  blackscholes.test.ts      matematyka: BS, parytet, solver IV, kalendarz sesji
  scoring.test.ts           progi oceny i wybór nóg kalendarza
  adapters.test.ts          parsowanie odpowiedzi Finnhub/Tradier
  alerts.test.ts            wysyłka, deduplikacja, zachowanie przy awariach
  pipeline.test.ts          END-TO-END: prawdziwy handler crona na zamockowanej sieci
  fixtures/                 przykładowy wynik skanu (kontrakt dla dashboardu)
```

---

## 7. Testy

```bash
npm test           # 72 testy: matematyka, kalendarz, scoring, wybór nóg, parsowanie API,
                   #          wysyłka alertów i pełny przepływ end-to-end
npm run typecheck  # TypeScript strict — przechodzi bez błędów
npx wrangler deploy --dry-run   # sprawdza, że bundel się buduje, bez wdrażania
```

### Test end-to-end (`pipeline.test.ts`)

Najważniejszy test w projekcie: uruchamia **prawdziwy handler `scheduled`** z `src/index.ts`
i przechodzi całą drogę — od kalendarza wyników, przez przecięcie z uniwersum, wybór nóg,
odczyt IV z cen opcji, ocenę, aż po wysłany alert i rejestr w KV. Podmienione są tylko dwie
rzeczy: warstwa sieciowa (globalny `fetch`) i KV.

Ceny opcji w tym teście **nie są atrapą** — powstają z Black-Scholesa dla zadanej zmienności,
więc solver IV w produkcji ma z czego odtworzyć zmienność. Test sprawdza między innymi, że
odczytana IV frontu i backu zgadza się z zadaną (32% / 40%) oraz że drugi przebieg crona
**nie powtarza** alertu.

### Błędy, które wyłapały testy

Testy nie są kosmetyką — w trakcie budowy wyłapały cztery realne błędy w kodzie produkcyjnym:

1. **Solver IV zbiegał "na cenie", produkując fikcyjną zmienność.** Przy głęboko ITM opcji
   vega jest tak mała, że residual ceny 4e-7 odpowiada błędowi IV ~13 punktów procentowych.
   Rozwiązanie: kryterium stopu w **przestrzeni IV**, nie ceny (`src/core/blackscholes.ts`).
2. **Znak `daysToEarnings`.** Dla backu jest ujemny; warunek `< 7` odrzucał każdy poprawny
   układ nóg.
3. **`find()` brał pierwszy back po wynikach**, a nie ten z wystarczającym zapasem czasu —
   kalendarz powstawał na wygaśnięciu 3 dni po wynikach, gdzie nie ma czego rozgrywać.
4. **Zapis skanu przed wysyłką alertów.** `ctx.waitUntil(storeScan(...))` wykonywał się
   przed `dispatchAlerts`, więc w KV (i na dashboardzie) `alertsSent` zawsze wynosiło 0,
   mimo wysłanych powiadomień. Do tego błędy wysyłki ginęły w logach crona — teraz są
   zapisywane pod osobnym kluczem i widoczne w `/api/scan`.

Każdy z tych błędów dawał wyniki, które *wyglądały* poprawnie.

### Czego NIE udało się zweryfikować bez kluczy API

- **Kształt odpowiedzi Finnhuba i Tradiera.** Endpointy odpowiadają `401` (a nie `404`),
  więc ścieżki i nagłówki są poprawne, ale zawartości odpowiedzi nie da się zobaczyć bez
  konta. Parsowanie jest oparte na dokumentacji i zabezpieczone testami
  (`test/adapters.test.ts`), które kodują oczekiwany format i sprawdzają, że nieoczekiwany
  kształt **nie wywala skanu** (zwraca pustą listę). Po uzyskaniu kluczy uruchom
  `npm run scan:local` — to pierwszy moment, w którym kontrakt jest sprawdzany na
  prawdziwych danych.
- **Warstwa wizualna dashboardu.** HTML jest zweryfikowany w jsdom (filtry, sortowanie,
  escapowanie, stany brzegowe), ale nie był renderowany w prawdziwej przeglądarce ani
  przez `wrangler dev`, więc układ (sticky nagłówek, przewijanie tabeli na telefonie)
  potwierdza tylko kod CSS, nie realny layout.

---

## 8. Rozwiązywanie problemów

| Objaw | Przyczyna i co zrobić |
|---|---|
| `/api/health` pokazuje `missing` | brakuje sekretów — ustaw je i zrób redeploy |
| Zero kandydatów | normalne poza sezonem wyników (styczeń/kwiecień/lipiec/październik są gęste). Sprawdź `/api/scan` → `counts.inAlertWindow` |
| `withUpcomingEarnings: 0` | uniwersum nie pokrywa się z kalendarzem — sprawdź `/api/universe` |
| Wszyscy kandydaci mają niski OI | sandbox Tradiera ma uboższe dane; rozważ konto brokerskie |
| Alerty nie przychodzą | sprawdź `ALERT_CHANNELS`, potem `npx wrangler tail` i szukaj `[scanner]` |
| Skany trwają za długo | zmniejsz `MAX_DEEP_ANALYSIS` albo zawęź `ALERT_MIN_DAYS`/`ALERT_MAX_DAYS` |
| `curl /api/scan?refresh=1` przerywa się po ~30 s | ręczne odświeżenie jest **synchroniczne** i trwa 2–4 min. Przeglądarka/curl może się poddać, choć Worker dokończy i zapisze wynik w KV. Odśwież stronę po chwili — dane będą już nowe. Normalna praca (cron) nie ma tego problemu, bo działa w tle |
| `npx wrangler` nie startuje | `npm install` w katalogu projektu |

Podgląd na żywo logów:

```bash
npx wrangler tail --format pretty
```

---

## 9. Możliwe rozszerzenia

- **Płatny dostawca opcji** (Polygon, ORATS, Tradier brokerski) — daje realne greki i IV
  śróddzienną. Adaptery są odizolowane w `src/adapters/`, więc podmiana to jedna klasa.
- **Backtest** — historia IV z KV pozwala po roku sprawdzić, czy wysokie oceny przekładały
  się na wyniki.
- **Zamknięcie pętli z brokerem** — Tradier ma API transakcyjne; obecny kod jest celowo
  tylko odczytowy.
- **Kalendarz .ics** — sugerowane daty wejścia jako wydarzenia w Google Calendar.

---

> **Zastrzeżenie.** Narzędzie analityczne i edukacyjne. Nie stanowi rekomendacji
> inwestycyjnej ani porady inwestycyjnej w rozumieniu ustawy o obrocie instrumentami
> finansowymi. Handel opcjami wiąże się z ryzykiem utraty całości lub części środków,
> a w przypadku instrumentów z dźwignią — również kwot przewyższających wpłatę. Wyniki
> osiągnięte w przeszłości nie gwarantują wyników w przyszłości. Decyzje inwestycyjne
> podejmujesz samodzielnie i na własne ryzyko.
