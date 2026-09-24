# Schemat danych do backtestu

Ten plik jest kontraktem: co zbieramy, po co i czego **nie** da się odtworzyć po fakcie.
Jeśli zmieniasz pola, dopisz nową wersję schematu na dole — nie modyfikuj znaczenia
istniejących kolumn, bo stare wiersze staną się nieczytelne.

---

## 1. Zasada nadrzędna: zamrażamy to, co system wiedział w dniu sygnału

Backtest jest uczciwy tylko wtedy, gdy używa danych dostępnych **w momencie decyzji**.
Dlatego archiwum zapisuje **surowy wynik skanu z danego dnia**, a nie przeliczony
później. Konsekwencje praktyczne:

- Gdy zmienisz wagi w `scoring.ts`, stare wiersze zachowują swoje oceny. Możesz dzięki
  temu porównać, jak stara i nowa wersja oceniłyby ten sam układ (archiwum zawiera
  wszystkie składowe, więc da się przeliczyć ocenę na nowych wagach offline).
- Gdy zmienisz dostawcę opcji, wiersze mają kolumnę `options_provider`, więc widać,
  które dane pochodzą z którego źródła.
- Kolumna `schema_version` pozwala odróżnić wiersze zapisane różnymi wersjami.

## 2. Gdzie trafiają dane

| Warstwa | Co trzyma | Jak długo | Po co |
|---|---|---|---|
| KV `scan:day:YYYY-MM-DD` | pełny wynik skanu z danego dnia | 400 dni | źródło prawdy, przeżyje restart i redeploy |
| KV `scan:index` | lista dni, które mają migawkę | 400 dni | żeby dało się wyeksportować bez zgadywania kluczy |
| `/api/export` | wszystko jako JSON do pobrania | — | ręczny eksport, np. `curl > dane.json` |
| `data/*.csv` w repo GitHub | wiersz na kandydata, dopisywany dziennie | na zawsze | backtest, Excel, pandas, historia w gicie |

Dlaczego trzy warstwy: KV jest szybkie i tanie, ale nie służy do analizy. Git jest
naturalnym miejscem na dane badawcze — ma wersjonowanie, jest darmowy i działa
z pandasem jednym poleceniem. KV jest buforem, który przetrwa awarię GitHuba.

---

## 3. Tabela `candidates.csv` — jedna linia na kandydata

To jest główna tabela do backtestu. Zawiera sygnał plus kontekst potrzebny do
policzenia, czy trade byłby opłacalny.

### Identyfikacja i czas

| Kolumna | Znaczenie |
|---|---|
| `schema_version` | wersja schematu (dziś `1`) |
| `as_of` | data sesyjna, dla której policzono skan (YYYY-MM-DD) |
| `symbol` | ticker |
| `name` | nazwa spółki (może być pusta) |
| `sector` | sektor GICS |
| `earnings_date` | data publikacji wyników |
| `days_to_earnings` | dni kalendarzowe od `as_of` do wyników (T-x) |
| `trading_days_to_earnings` | to samo w dniach sesyjnych |
| `earnings_confirmed` | czy data potwierdzona (`true/false`) — **kluczowe dla filtrów** |
| `earnings_timing` | `bmo` / `amc` / `unknown` |

### Sygnał (to, co system wiedział)

| Kolumna | Znaczenie |
|---|---|
| `score` | ocena 0-100 z dnia sygnału |
| `grade` | A/B/C/D |
| `flags` | flagi rozdzielone `;` (np. `STREFA-DOCELOWA;KONTANGO`) |
| `suggested_entry_date` | sugerowana data wejścia z dnia sygnału |
| `spot` | cena instrumentu bazowego w dniu skanu |

### Nogi kalendarza

| Kolumna | Znaczenie |
|---|---|
| `front_expiration` / `front_dte` | wygaśnięcie i dni do niego (krótka noga) |
| `front_iv` | IV ATM krótkiej nogi (ułamek, np. 0.34) |
| `front_iv_source` | `provider` / `computed` / `model` — **wiarygodność IV** |
| `front_implied_move` | ruch implikowany z ceny straddle (ułamek) |
| `front_oi` | open interest ATM |
| `front_spread_pct` | spread bid-ask ATM jako % mid |
| `back_expiration` / `back_dte` / `back_iv` / `back_iv_source` | to samo dla długiej nogi |
| `term_structure_slope` | `back_iv - front_iv` w ułamku (teza strategii) |
| `days_front_to_earnings` | dni od wygaśnięcia frontu do wyników (**znak ma znaczenie**: `>0` = front przed wynikami) |

### Kontekst zmienności

| Kolumna | Znaczenie |
|---|---|
| `iv_rank` | percentyl własnej IV (od dostawcy albo z historii) |
| `iv_rank_source` | `provider` / `history` / puste |
| `implied_vs_historical` | `implied_move / avg_historical_move` — <1 znaczy tanią opcjonalność |
| `avg_historical_move` | średni historyczny ruch po wynikach (ułamek; **przybliżenie**, patrz §5) |

### Składowe oceny (do przeliczenia na innych wagach)

| Kolumna | Znaczenie |
|---|---|
| `points_timing`, `points_term_structure`, `points_cheapness`, `points_liquidity`, `points_iv_rank` | punkty poszczególnych składowych |
| `warnings_count` | liczba ostrzeżeń |

### Prowieniencja

| Kolumna | Znaczenie |
|---|---|
| `options_provider` | `tradier` / `tastytrade` |
| `options_env` | `sandbox` / `production` |
| `scanner_version` | wersja skanera, która wygenerowała wiersz |

---

## 4. Tabela `outcomes.csv` — co się faktycznie stało

Sygnał bez wyniku nie da się zbacktestować. Ta tabela jest uzupełniana **później**,
gdy wyniki już się odbyły.

| Kolumna | Znaczenie |
|---|---|
| `symbol`, `earnings_date` | klucz łączący z `candidates.csv` |
| `realized_move_pct` | faktyczna zmiana kursu w reakcji na wyniki (ułamek) |
| `realized_move_source` | skąd wzięty ruch (np. `eodhd`, `polygon`, `yahoo`) |
| `front_iv_at_exit` | IV frontu w dniu wyjścia (do policzenia P&L kalendarza) |
| `back_iv_at_exit` | IV backu w dniu wyjścia |
| `spot_at_exit` | kurs w dniu wyjścia |
| `exit_date` | data wyjścia (typowo 1-2 dni przed publikacją) |
| `calendar_pnl_estimate` | **szacunek** P&L kalendarza wyceniony modelem BS na danych wejściowych i wyjściowych |
| `pnl_method` | `bs_repricing` — jak policzono; puste = nie policzono |

> **Uczciwe ograniczenie:** `calendar_pnl_estimate` to **model**, nie realny fill.
> Nie uwzględnia spreadu bid-ask przy wejściu i wyjściu, ani tego, że IV per strike
> zmienia się nieliniowo. Do decyzji o strategii nadaje się jako filtr („czy sygnał
> w ogóle rokuje"), a nie jako dowód zysku. Realną weryfikacją są transakcje na
> koncie, nie backtest.

---

## 5. Czego NIE da się odtworzyć po fakcie — i dlatego to zbieramy

To najważniejsza sekcja tego pliku. Poniższe rzeczy są **nieodwracalne**: jeśli nie
zapiszesz ich w dniu skanu, nie odtworzysz ich nigdy, bo dostawcy nie sprzedają
historii term structure w darmowych planach, a darmowe API nie mają archiwum.

1. **Term structure w dniu sygnału.** IV frontu i backu dla konkretnych wygaśnięć to
   wartość chwilowa. Za miesiąc nie kupisz jej z darmowego źródła.
2. **IV rank z dnia sygnału.** Nawet mając historię IV, nie odtworzysz, co dokładnie
   widział system (inne okno, inna metoda).
3. **Implied move i spread bid-ask.** Zmieniają się codziennie.
4. **Open interest / rating płynności.** Zmienia się codziennie.
5. **Data publikacji wyników z dnia sygnału.** Spółki przesuwają daty; kluczowe jest,
   co system *wtedy* uważał za datę, bo na tym opierał układ nóg.
6. **Ocena i flagi z dnia sygnału.** Bez nich nie odróżnisz „system dał A i miał rację"
   od „system dał A, ale po zmianie wag dałby D".

### Aproksymacje, które trzeba znać

- `avg_historical_move` z Finnhuba to **niespodzianka na EPS**, nie realny ruch kursu.
  Ruch kursu bywa większy niż sama niespodzianka. Skaner oznacza to jako przybliżenie
  i nie opiera na tym kluczowej decyzji. Jeśli chcesz dokładne wartości, trzeba
  dostawcy z historią cen (EODHD, Polygon) — do dopięcia później, bo danych
  historycznych kursów **nie trzeba zbierać na bieżąco** (są dostępne wstecz).
- `front_iv` z `front_iv_source = model` to IV indeksu spółki, **nie** IV tego
  wygaśnięcia. Do analizy filtruj `where front_iv_source = 'provider' or 'computed'`.

### Co wolno odtworzyć później (nie trzeba archiwizować)

- historyczne kursy akcji (potrzebne do `realized_move_pct`) — dostępne wstecz,
- historyczne daty wyników — dostępne wstecz,
- historyczne poziomy indeksów.

Dlatego `realized_move_pct` zbierzemy później, dokładniej, z dostawcy cen.

---

## 6. Przykładowe zapytania (po zebraniu danych)

```sql
-- Czy sygnał klasy A faktycznie poprzedzał duże ruchy?
SELECT grade, COUNT(*) AS n,
       ROUND(AVG(o.realized_move_pct) * 100, 2) AS avg_move_pct
FROM candidates c
JOIN outcomes o USING (symbol, earnings_date)
WHERE c.schema_version = 1 AND c.earnings_confirmed
GROUP BY grade ORDER BY grade;

-- Czy "tania opcjonalność" (implied < historyczny) przekładała się na wynik?
SELECT CASE WHEN c.implied_vs_historical < 0.85 THEN 'tania'
            WHEN c.implied_vs_historical > 1.15 THEN 'droga'
            ELSE 'neutralna' END AS bucket,
       COUNT(*) AS n, ROUND(AVG(o.realized_move_pct) * 100, 2) AS avg_move_pct
FROM candidates c JOIN outcomes o USING (symbol, earnings_date)
WHERE c.implied_vs_historical IS NOT NULL
GROUP BY bucket;

-- Czy dodatnie nachylenie term structure pomagało?
SELECT CASE WHEN c.term_structure_slope > 0.02 THEN 'kontango'
            WHEN c.term_structure_slope < -0.02 THEN 'odwrocona'
            ELSE 'plaska' END AS krzywa,
       COUNT(*) AS n, ROUND(AVG(o.calendar_pnl_estimate), 3) AS avg_pnl
FROM candidates c JOIN outcomes o USING (symbol, earnings_date)
GROUP BY krzywa ORDER BY avg_pnl DESC;
```

---

## 7. Historia wersji schematu

| Wersja | Data | Zmiana |
|---|---|---|
| `1` | 2026-09-24 | Wersja pierwotna: sygnał + nogi + kontekst IV + składowe oceny + proweniencja |
