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

## 2. Gdzie to ma działać — GitHub vs Cloudflare

Te dwie rzeczy są często mylone, więc rozdzielmy je jasno:

| | Co tam mieszka | Czy musi działać 24/7 |
|---|---|---|
| **GitHub** | kod źródłowy, historia zmian, testy (CI) | nie — to tylko magazyn i sprawdzanie kodu |
| **Cloudflare** | **działający skaner**, cron, baza stanu (KV), dashboard, alerty | tak — to on budzi się 2× dziennie |

**Twój komputer nie jest potrzebny do niczego po wdrożeniu.** Skaner działa w Cloudflare,
a nie u Ciebie. Lokalnie uruchamiasz tylko dwie rzeczy:

- `npm test` — żeby sprawdzić kod przed wypchnięciem (albo zrobi to GitHub Actions za Ciebie),
- `npm run scan:local` — jednorazowy test na prawdziwych danych, **przed** wdrożeniem.

### Wariant A — wszystko jednym skryptem (zalecany)

Po sklonowaniu repo i wypełnieniu `.dev.vars`:

```bash
./setup-cloudflare.sh
```

Skrypt sam: zaloguje Cię do Cloudflare, utworzy namespace KV, wpisze jego ID do
`wrangler.toml`, wgra sekrety z `.dev.vars` i zrobi deploy. Można go uruchamiać
wielokrotnie — jest idempotentny. Na końcu wypisze adres Twojego Workera.

### Wariant B — bez terminala, przez panel Cloudflare (Git integration)

Jeśli wolisz klikać zamiast wpisywać komendy:

1. Wypchnij kod do repozytorium na GitHubie (instrukcja niżej).
2. Wejdź na **dash.cloudflare.com** → **Workers & Pages** → **Create** → **Connect to Git**.
3. Wskaż swoje repozytorium i gałąź `main`.
4. Cloudflare sam wykryje `wrangler.toml` — nie zmieniaj ustawień builda.
5. **KV:** zakładka **Storage & Databases → KV → Create namespace** o nazwie `STATE`.
   Potem w ustawieniach Workera dodaj binding: zmienna `STATE` → ten namespace.
6. **Sekrety:** zakładka **Settings → Variables and Secrets** i dodaj po jednym:
   `FINNHUB_API_KEY`, `TRADIER_API_KEY`, `API_KEY` (+ opcjonalnie Telegram/Resend).
   Typ: **Secret**.
7. **Deploy.** Od tej pory każdy `git push` na `main` wdraża nową wersję automatycznie.

> **Uwaga o sekretach w obu wariantach:** sekrety trzymaj w JEDNYM miejscu — albo
> w Cloudflare, albo w `.dev.vars` lokalnie. Nie commituj ich nigdy do GitHuba
> (`.gitignore` już to blokuje, a CI dodatkowo sprawdza, czy taki plik nie trafił do repo).

### Wypchnięcie kodu na GitHub (potrzebne w obu wariantach)

Repozytorium git jest już zainicjowane i ma pierwszy commit — brakuje tylko zdalnego adresu:

```bash
# 1. Utwórz PUSTE repozytorium na github.com (bez README i .gitignore)
# 2. Podmień adres poniżej i wypchnij:
git remote add origin https://github.com/TWOJ_LOGIN/earnings-iv-scanner.git
git push -u origin main
```

Po wypchnięciu w zakładce **Actions** na GitHubie zobaczysz, że testy przechodzą
(workflow `.github/workflows/ci.yml` uruchamia `npm test`, typecheck i dry-run build).
To jest Twoja siatka bezpieczeństwa: jeśli coś zepsujesz w kodzie, CI to pokaże,
zanim Cloudflare wdroży zepsutą wersję.

### Którego dostawcy opcji użyć — Tradier czy tastytrade?

| | Tradier (sandbox) | tastytrade |
|---|---|---|
| Rejestracja | e-mail + hasło, **jeden klucz API** | konto brokerskie + aplikacja OAuth + 2FA |
| Poświadczenia | 1 sekret | 4 (client ID, client secret, refresh token, środowisko) |
| Greki i IV | **nie** — liczymy sami z cen | **tak** |
| IV rank | własna historia, sensowna po ~60 dniach | **wprost z API, od pierwszego dnia** |
| IV per wygaśnięcie | liczymy z cen | **wprost z API** |
| Płynność | open interest ATM | rating płynności (OI niedostępny) |
| Opóźnienie danych | 15 min (sandbox) | zależne od konta |

**Rekomendacja:** jeśli masz konto w tastytrade — użyj tastytrade (`OPTIONS_PROVIDER = "tastytrade"`).
Skaner jest wtedy w pełni funkcjonalny od pierwszego uruchomienia, bo IV rank i term structure
przychodzą z API. Tradier zostaje jako opcja „chcę zacząć w 5 minut, jednym kluczem".

### Poświadczenia tastytrade — krok po kroku

1. Zaloguj się na **my.tastytrade.com**.
2. **Manage → My Profile → API → OAuth Applications → + New OAuth client**.
   - Redirect URI: dowolny pełny adres, np. `https://localhost/callback` (nie jest używany
     przy pracy na własnym koncie, ale jest wymagany).
   - Scopes: **`read`** (skaner tylko czyta dane; `trade` nie jest potrzebny).
3. Skopiuj **Client ID** i **Client Secret**. ⚠️ Secret jest pokazywany **tylko raz** —
   zapisz go od razu. Jeśli zgubisz, użyj **Regenerate**.
4. Przy aplikacji kliknij **Manage → Create Grant** → skopiuj **refresh token**
   (nie wygasa).
5. Uwaga: zakresy `read`/`trade` wymagają włączonego **2FA** na koncie
   (My Profile → Security).
6. Sandbox i produkcja mają **osobne** poświadczenia — nie zadziałają zamiennie.
   Jeśli dostaniesz błąd `401`, sprawdź, czy klucze i `TASTYTRADE_ENV` dotyczą
   tego samego środowiska.

Do `.dev.vars`:

```ini
TASTYTRADE_CLIENT_ID=twoj_client_id
TASTYTRADE_CLIENT_SECRET=twoj_client_secret
TASTYTRADE_REFRESH_TOKEN=twoj_refresh_token
```

I w `wrangler.toml` ustaw `OPTIONS_PROVIDER = "tastytrade"` oraz `TASTYTRADE_ENV`
(`"sandbox"` albo `"production"`).

### Klucz Brevo — musi być klucz API, nie SMTP

Brevo ma **dwa różne** klucze i łatwo je pomylić:

| Klucz | Prefiks | Do czego | Działa z Workera? |
|---|---|---|---|
| SMTP | `xsmtpsib-...` | klient pocztowy, port 587 | **nie** |
| **API v3** | `xkeysib-...` | REST `api.brevo.com/v3/smtp/email` | **tak — ten jest potrzebny** |

Klucz API v3 wygenerujesz na [app.brevo.com/settings/keys/api](https://app.brevo.com/settings/keys/api)
(zakładka **API Keys**, nie SMTP). Skaner wykrywa klucz SMTP i zgłasza to czytelnym
błędem, zamiast kończyć się tajemniczym `401`.

Nadawca (`ALERT_EMAIL_FROM`) musi być **zweryfikowany** u dostawcy
(Brevo: Senders → Add a sender). Format `"Skaner <adres@domena>"` jest obsługiwany.

### Czego potrzebuję od Ciebie, żeby to dokończyć

Nie mam dostępu do Twoich kont, więc te cztery rzeczy musisz zrobić sam (zajmuje ~15 minut):

| # | Czego potrzebuję | Gdzie | Wymagane? |
|---|---|---|---|
| 1 | Adres repozytorium GitHub | github.com (utwórz puste repo) | tak |
| 2 | Konto Cloudflare | dash.cloudflare.com (darmowe) | tak |
| 3 | Klucz Finnhub | finnhub.io/register | tak |
| 4 | Klucz Tradier | developer.tradier.com | tak |
| 5 | Bot Telegram (`@BotFather`) + chat ID | Telegram | opcjonalnie |
| 6 | Klucz Resend + własna domena | resend.com | opcjonalnie |

**Nie potrzebuję niczego więcej** — żadnych haseł ani tokenów dostępowych. Jeśli chcesz,
mogę za Ciebie przygotować commity, poprawki kodu i konfigurację; Ty wykonujesz tylko
kroki wymagające logowania do swoich kont.

---

## 3. Szybki start (15 minut)

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

Utwórz plik `.dev.vars` (jest w `.gitignore`, więc nie trafi do repo — użyje go
zarówno test lokalny, jak i `setup-cloudflare.sh` przy wgrywaniu sekretów):

```ini
# Wymagane
FINNHUB_API_KEY=twoj_klucz_finnhub
TRADIER_API_KEY=twoj_klucz_tradier
API_KEY=dowolny_dlugi_losowy_ciag

# Opcjonalne — tylko dla kanałów, które chcesz mieć
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-1001234567890

# E-mail: dostawcę wybiera EMAIL_PROVIDER ("brevo" albo "resend"; domyślnie brevo).
# Brevo wymaga klucza API v3 (xkeysib-...), NIE klucza SMTP (xsmtpsib-...) — patrz tabela wyżej.
EMAIL_PROVIDER=brevo
BREVO_API_KEY=xkeysib-xxxxxxxx
# Resend zostaje jako alternatywa (EMAIL_PROVIDER=resend):
RESEND_API_KEY=re_xxxxxxxx
```

Losowy `API_KEY` wygenerujesz tak (chroni on endpointy `/api/*` przed obcymi):

```bash
head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40
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

Najprościej: jeden skrypt, który robi wszystko (logowanie, KV, sekrety, deploy):

```bash
./setup-cloudflare.sh
```

Wariant ręczny, jeśli wolisz mieć kontrolę nad każdym krokiem:

```bash
npx wrangler login
npx wrangler kv namespace create STATE     # wklej id do wrangler.toml
npx wrangler secret bulk .dev.vars         # wgrywa wszystkie sekrety z pliku
npx wrangler deploy
```

Pełny opis — w tym wariant bez terminala, przez panel Cloudflare — jest w sekcji 2 wyżej.

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

## 4. Jak czytać wynik

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

## 5. Konfiguracja

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

## 6. Koszty i limity

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

## 7. Struktura projektu

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
test/                       testy (109 przypadków)
  blackscholes.test.ts      matematyka: BS, parytet, solver IV, kalendarz sesji
  scoring.test.ts           progi oceny i wybór nóg kalendarza
  adapters.test.ts          parsowanie odpowiedzi Finnhub/Tradier
  tastytrade.test.ts        OAuth, cache tokenu, metryki IV, wybór źródła IV
  brevo.test.ts             wysyłka e-mail, walidacja nadawcy, wykrycie klucza SMTP
  alerts.test.ts            wysyłka, deduplikacja, zachowanie przy awariach
  pipeline.test.ts          END-TO-END: prawdziwy handler crona na zamockowanej sieci
  fixtures/                 przykładowy wynik skanu (kontrakt dla dashboardu)
```

---

## 8. Testy

```bash
npm test           # 109 testów: matematyka, kalendarz, scoring, wybór nóg, parsowanie API,
                   #           wysyłka alertów, adaptery (tradier/tastytrade/brevo) i pełny przepływ end-to-end
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

## 9. Rozwiązywanie problemów

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

## 10. Możliwe rozszerzenia

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
