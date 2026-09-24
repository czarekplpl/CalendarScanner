-- =============================================================================
-- SCHEMAT D1 (SQLite) — dane do backtestu
-- =============================================================================
--
-- Zastosowanie:
--   npx wrangler d1 execute earnings-iv-scanner --local  --file=./schema.sql
--   npx wrangler d1 execute earnings-iv-scanner --remote --file=./schema.sql
--
-- Dlaczego D1, a nie samo KV + CSV (patrz też docs/DATA_SCHEMA.md):
--   KV trzyma migawki jako JSON i nadaje się na bufor, ale nie na analizę —
--   każde zapytanie wymagałoby pobrania i sparsowania całości.
--   D1 daje SQL, indeksy i 5 GB na darmowym planie (5 mln odczytów/dzień).
--   Zużycie przy 200 spółkach: ~100 wierszy dziennie = 0,1% dziennego limitu zapisów.
--
-- Zasada: wiersz opisuje STAN WIEDZY W DNIU SKANU. Nie aktualizujemy go później,
-- bo backtest musi widzieć dokładnie to, co widział system. Wyjątkiem są kolumny
-- `outcome_*`, które dotyczą przyszłości i są dopisywane, gdy wyniki się odbędą.

-- ── Kandydaci: jedna linia na spółkę w oknie alertu, na dzień skanu ───────────
CREATE TABLE IF NOT EXISTS scan_candidates (
  -- Klucz główny: ten sam dzień + spółka + cykl wyników = jeden wiersz.
  -- Dzięki temu ponowny przebieg tego samego dnia nadpisuje, a nie duplikuje.
  as_of                     TEXT    NOT NULL,
  symbol                    TEXT    NOT NULL,
  earnings_date             TEXT    NOT NULL,

  schema_version            INTEGER NOT NULL DEFAULT 1,
  name                      TEXT,
  sector                    TEXT,

  -- czas i zdarzenie
  days_to_earnings          INTEGER,
  trading_days_to_earnings  INTEGER,
  earnings_confirmed        INTEGER,   -- 0/1
  earnings_timing           TEXT,      -- bmo | amc | unknown

  -- sygnał
  score                     INTEGER,
  grade                     TEXT,
  flags                     TEXT,      -- rozdzielone ';'
  suggested_entry_date      TEXT,
  spot                      REAL,

  -- krótka noga
  front_expiration          TEXT,
  front_dte                 INTEGER,
  front_iv                  REAL,
  front_iv_source           TEXT,      -- provider | computed | model
  front_implied_move        REAL,
  front_oi                  INTEGER,
  front_spread_pct          REAL,
  front_pricing_source      TEXT,      -- mid | last | last-poza-widelkami | brak-rynku

  -- długa noga
  back_expiration           TEXT,
  back_dte                  INTEGER,
  back_iv                   REAL,
  back_iv_source            TEXT,

  -- relacje między nogami
  term_structure_slope      REAL,      -- back_iv - front_iv (teza strategii)
  days_front_to_earnings    INTEGER,   -- >0: front przed wynikami (strefa docelowa)

  -- kontekst zmienności
  iv_rank                   REAL,
  iv_rank_source            TEXT,      -- provider | history
  implied_vs_historical     REAL,      -- <1 = tania opcjonalność
  avg_historical_move       REAL,

  -- składowe oceny (żeby dało się przeliczyć ocenę na nowych wagach offline)
  points_timing             REAL,
  points_term_structure     REAL,
  points_cheapness          REAL,
  points_liquidity          REAL,
  points_iv_rank            REAL,
  warnings_count            INTEGER,

  -- proweniencja
  options_provider          TEXT,
  options_env               TEXT,
  scanner_version           TEXT,
  recorded_at               TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (as_of, symbol, earnings_date)
);

-- Indeksy pod zapytania z docs/DATA_SCHEMA.md §6.
-- Bez nich każde grupowanie skanuje całą tabelę (D1 liczy wiersze odczytane!).
CREATE INDEX IF NOT EXISTS idx_cand_symbol_date   ON scan_candidates (symbol, earnings_date);
CREATE INDEX IF NOT EXISTS idx_cand_asof          ON scan_candidates (as_of);
CREATE INDEX IF NOT EXISTS idx_cand_grade         ON scan_candidates (grade, as_of);

-- ── Spółki w oknie alertu, dla których NIE było danych opcyjnych ──────────────
-- Ważne dla rzetelności backtestu: pozwala zmierzyć, ile okazji odsialiśmy
-- z powodu braku płynności, a nie z powodu braku sygnału.
CREATE TABLE IF NOT EXISTS scan_watchlist (
  as_of             TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  earnings_date     TEXT NOT NULL,
  days_to_earnings  INTEGER,
  reason            TEXT,
  PRIMARY KEY (as_of, symbol, earnings_date)
);

CREATE INDEX IF NOT EXISTS idx_watch_symbol ON scan_watchlist (symbol, earnings_date);

-- ── Wyniki: dopisywane PO fakcie, gdy wyniki się odbyły ──────────────────────
-- To jedyne kolumny w tym schemacie, które opisują przyszłość — dlatego żyją
-- w osobnej tabeli. Powiązanie z scan_candidates przez (symbol, earnings_date),
-- a nie przez as_of, bo ten sam cykl wyników obserwujemy przez wiele dni.
CREATE TABLE IF NOT EXISTS outcomes (
  symbol                 TEXT NOT NULL,
  earnings_date          TEXT NOT NULL,

  realized_move_pct      REAL,     -- faktyczna reakcja kursu (ułamek)
  realized_move_source   TEXT,     -- skąd wzięty ruch

  exit_date              TEXT,
  spot_at_exit           REAL,
  front_iv_at_exit       REAL,
  back_iv_at_exit        REAL,

  calendar_pnl_estimate  REAL,     -- SZACUNEK modelem BS, nie realny fill
  pnl_method             TEXT,     -- bs_repricing
  recorded_at            TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (symbol, earnings_date)
);

-- ── Dziennik przebiegów: diagnostyka i wykrywanie luk w danych ───────────────
CREATE TABLE IF NOT EXISTS scan_runs (
  as_of             TEXT NOT NULL,
  run_at            TEXT NOT NULL,
  candidates        INTEGER,
  analyzed          INTEGER,
  in_alert_window   INTEGER,
  alerts_sent       INTEGER,
  duration_ms       INTEGER,
  errors_count      INTEGER,
  scanner_version   TEXT,
  PRIMARY KEY (as_of, run_at)
);
