#!/usr/bin/env python3
"""
WERYFIKACJA STRUKTURY KALENDARZA U BROKERA (Interactive Brokers)
==============================================================

PO CO TEN SKRYPT
Skaner działa w Cloudflare na darmowych źródłach: zna zmienność implikowaną,
term structure i IV rank (tastytrade), ale NIE MA CEN OPCJI — endpoint
/market-data zwraca 403 na używanym koncie. Skutki:
  - implied move jest liczony modelem (0,8 * S * IV * sqrt(T)), nie z rynku,
  - spread bid-ask opcji jest nieznany, więc ocena płynności opiera się
    na ratingu dostawcy, nie na realnych widełkach.

Ten skrypt domyka tę lukę: łączy się z Twoim IB Gateway (konto z realnymi
danymi) i sprawdza KONKRETNĄ strukturę, którą zaproponował skaner.

JAK UŻYĆ
  1. Uruchom IB Gateway (lub TWS) i zaloguj się.
     W Configuration -> API -> Settings:
       - zaznacz "Enable ActiveX and Socket Clients"
       - odznacz "Read-Only API" (potrzebujemy tylko odczytu, ale IB wymaga
         tego do zapytań o kontrakty w niektórych wersjach)
       - zapamiętaj Port (IB Gateway: 4001 dla live, 4002 dla paper)
  2. Uruchom:
       python3 scripts/verify_ibkr.py NFLX
     albo z konkretnym portem / kluczem API:
       python3 scripts/verify_ibkr.py NFLX --port 4002
       python3 scripts/verify_ibkr.py NFLX --api-key TWOJ_KLUCZ

WYMAGANIA
  pip install ib_insync requests
  (ib_insync masz już zainstalowany — sprawdzone)

UWAGA O UPRAWNIENIACH
  Kontrakt opcyjny wymaga subskrypcji danych dla odpowiedniej giełdy.
  Jeśli IB zwróci błąd 354 ("Requested market data is not subscribed"),
  dokup subskrypcję opcji US w panelu IBKR.

CZEGO SKRYPT NIE ROBI
  Nie składa żadnych zleceń. Jest wyłącznie odczytowy.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# Konfiguracja
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_WORKER = "https://earnings-iv-scanner.wesleyoptions.workers.dev"
ROOT = Path(__file__).resolve().parent.parent
DEV_VARS = ROOT / ".dev.vars"
LOCAL_SCAN = ROOT / "test-output" / "scan.json"

# Typowe interwały siatki strike'ów — używane, gdy w kandydacie nie ma strike'u.
STRIKE_STEPS = [1.0, 2.5, 5.0, 10.0, 25.0]


def czytaj_dev_vars() -> dict[str, str]:
    """Wczytuje .dev.vars (format KEY=value)."""
    out: dict[str, str] = {}
    if not DEV_VARS.exists():
        return out
    for line in DEV_VARS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def pobierz_kandydata(symbol: str, api_key: str | None, base_url: str) -> dict[str, Any]:
    """
    Pobiera kandydata z Workera. Kolejność źródeł:
      1. Worker /api/candidate/{symbol} — dane najświeższe, z ostatniego skanu,
      2. lokalny test-output/scan.json — gdy Worker nieosiągalny lub brak klucza.
    """
    symbol = symbol.upper()

    if api_key:
        import requests

        url = f"{base_url.rstrip('/')}/api/candidate/{symbol}"
        try:
            resp = requests.get(url, headers={"x-api-key": api_key}, timeout=20)
            if resp.status_code == 200:
                data = resp.json()
                print(f"   źródło: Worker ({url})")
                return data
            if resp.status_code == 404:
                raise SystemExit(
                    f"BŁĄD: {resp.json().get('error', 'spółki nie ma w skanie')}\n"
                    f"       Szczegóły: {json.dumps(resp.json(), ensure_ascii=False)[:300]}"
                )
            print(f"   Worker zwrócił HTTP {resp.status_code} — próbuję lokalnego pliku")
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"   Worker nieosiągalny ({exc.__class__.__name__}) — próbuję lokalnego pliku")

    if LOCAL_SCAN.exists():
        scan = json.loads(LOCAL_SCAN.read_text(encoding="utf-8"))
        kandydat = next(
            (c for c in scan.get("candidates", []) if c.get("symbol", "").upper() == symbol), None
        )
        if kandydat:
            print(f"   źródło: lokalny plik ({LOCAL_SCAN})")
            return {"candidate": kandydat, "asOf": scan.get("asOf")}

    raise SystemExit(
        f"BŁĄD: nie znalazłem kandydata '{symbol}'.\n"
        f"       - Worker: podaj --api-key (klucz z .dev.vars, pole API_KEY)\n"
        f"       - albo uruchom wcześniej: npm run scan:local -- --json\n"
        f"       Listę kandydatów pokaże: npm run scan:local"
    )


def wybierz_strike(spot: float, podany: float | None) -> float:
    """Strike z kandydata albo najbliższy typowy interwał siatki."""
    if podany and podany > 0:
        return float(podany)
    for step in STRIKE_STEPS:
        if spot / step < 400:  # sensowna liczba strike'ów w łańcuchu
            return round(spot / step) * step
    return round(spot)


# ─────────────────────────────────────────────────────────────────────────────
# Black-Scholes do porównania IV (ten sam wzór co w skanerze)
# ─────────────────────────────────────────────────────────────────────────────








def dni_do(dzien: str) -> int:
    try:
        return (date.fromisoformat(dzien) - date.today()).days
    except Exception:  # noqa: BLE001
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# IBKR
# ─────────────────────────────────────────────────────────────────────────────


def polacz_z_ib(host: str, port: int, client_id: int):
    try:
        from ib_insync import IB
    except ImportError:
        raise SystemExit(
            "BŁĄD: brak biblioteki ib_insync.\n"
            "       Zainstaluj: pip install ib_insync"
        ) from None

    ib = IB()
    print(f"   łączę z TWS/IB Gateway {host}:{port} (clientId={client_id})...")
    try:
        ib.connect(host, port, clientId=client_id, timeout=15, readonly=True)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"BŁĄD: nie mogę połączyć się z TWS/IB Gateway ({exc.__class__.__name__}: {exc}).\n"
            "       Sprawdź:\n"
            "         1. czy TWS (lub IB Gateway) jest uruchomiony i zalogowany,\n"
            "         2. Configuration -> API -> Settings -> ZAZNACZONE 'Enable ActiveX and Socket Clients'\n"
            "            (sam wpis portu nie wystarcza — bez tego checkboxa TWS nie otwiera gniazda),\n"
            "         3. właściwy port (opcja --port):\n"
            "              TWS:     7496 = live, 7497 = paper  (może być zmieniony w konfiguracji),\n"
            "              Gateway: 4001 = live, 4002 = paper,\n"
            "         4. czy port jest otwarty: nc -z -v 127.0.0.1 <port>"
        ) from None
    print(f"   połączono. Konto: {ib.managedAccounts()}")
    return ib


def pobierz_kontrakt(ib, symbol: str, wygasniecie: str, strike: float, prawo: str):
    """Znajduje kontrakt opcyjny, dopasowując najbliższy dostępny strike."""
    from ib_insync import Option, Stock

    # Najpierw instrument bazowy — potrzebujemy kursu i pewności, że symbol istnieje.
    akcja = Stock(symbol, "SMART", "USD")
    ib.qualifyContracts(akcja)
    ticker_akcji = ib.reqMktData(akcja, "", False, False)
    ib.sleep(2)

    spot = None
    for pole in ("last", "close", "marketPrice"):
        wartosc = getattr(ticker_akcji, pole, None)
        if isinstance(wartosc, (int, float)) and wartosc > 0:
            spot = float(wartosc)
            break

    # IB wymaga formatu YYYYMMDD
    wyg_ib = wygasniecie.replace("-", "")

    # Szukamy dokładnego strike'u; jeśli go nie ma, bierzemy najbliższy z łańcucha.
    lancuch = ib.reqSecDefOptParams(symbol, "", akcja.secType, akcja.conId)
    if not lancuch:
        raise SystemExit(f"BŁĄD: IB nie zwrócił łańcucha opcji dla {symbol} (brak subskrypcji?).")

    parametry = lancuch[0]
    dostepne_wyg = sorted(parametry.expirations)
    # Wygaśnięcia w IB są w formacie YYYYMMDD
    if wyg_ib not in dostepne_wyg:
        bliskie = [w for w in dostepne_wyg if w >= wyg_ib][:1]
        if not bliskie:
            raise SystemExit(
                f"BŁĄD: IB nie ma wygaśnięcia {wyg_ib} dla {symbol}.\n"
                f"       Najbliższe dostępne: {', '.join(dostepne_wyg[:8])}"
            )
        print(f"   UWAGA: brak wygaśnięcia {wyg_ib}, używam najbliższego: {bliskie[0]}")
        wyg_ib = bliskie[0]

    dostepne_strike = sorted(parametry.strikes)
    if strike not in dostepne_strike:
        najblizszy = min(dostepne_strike, key=lambda k: abs(k - strike))
        print(f"   UWAGA: brak strike {strike}, używam najbliższego: {najblizszy}")
        strike = najblizszy

    kontrakt = Option(symbol, wyg_ib, strike, prawo, "SMART")
    ib.qualifyContracts(kontrakt)
    return kontrakt, spot, akcja


def pobierz_notowanie(ib, kontrakt) -> dict[str, Any]:
    """Pobiera bid/ask/last/greki dla kontraktu opcyjnego."""
    ticker = ib.reqMktData(kontrakt, "100,101", False, False)  # 100=OptionComputation, 101=OI
    ib.sleep(3)

    def liczba(*pola):
        for p in pola:
            v = getattr(ticker, p, None)
            if isinstance(v, (int, float)) and v > 0:
                return float(v)
        return None

    bid = liczba("bid")
    ask = liczba("ask")
    last = liczba("last", "close")
    mid = (bid + ask) / 2 if bid and ask else None

    # `last` bywa POZA widełkami bid/ask — to normalne (transakcja po agresywnej
    # cenie, a rynek zdążył się przesunąć). Dla opcji to często WIARYGODNIEJSZA
    # cena niż środek szerokiego spreadu, bo jest faktem, a nie ofertą.
    # Dlatego podajemy obie i oznaczamy, gdzie leży last.
    if last and bid and ask:
        pozycja_last = "w widełkach" if bid <= last <= ask else ("powyżej ask" if last > ask else "poniżej bid")
    elif last:
        pozycja_last = "brak jednej strony rynku"
    else:
        pozycja_last = "brak transakcji"

    return {
        "bid": bid,
        "ask": ask,
        "last": last,
        "mid": mid,
        "spread_pct": ((ask - bid) / mid) if (bid and ask and mid) else None,
        "open_interest": liczba("callOpenInterest", "putOpenInterest"),
        "volume": liczba("volume"),
        "iv_ib": getattr(getattr(ticker, "modelGreeks", None), "impliedVol", None),
        "last_position": pozycja_last,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Raport
# ─────────────────────────────────────────────────────────────────────────────


def fmt(v: float | None, jednostka: str = "", miejsca: int = 2) -> str:
    if v is None:
        return "n/d"
    if jednostka == "%":
        return f"{v * 100:.{miejsca}f}%"
    if jednostka == "pp":
        return f"{v * 100:+.{miejsca}f}pp"
    return f"{v:.{miejsca}f}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Weryfikuje strukturę kalendarza u brokera IBKR (realne ceny opcji).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("symbol", help="ticker spółki z alertu, np. NFLX")
    parser.add_argument("--host", default="127.0.0.1", help="host IB Gateway (domyślnie 127.0.0.1)")
    parser.add_argument("--port", type=int, default=4001,
                        help="port API: TWS 7496/7497, IB Gateway 4001/4002 (domyślnie 4001)")
    parser.add_argument("--client-id", type=int, default=77, help="clientId (dowolny wolny)")
    parser.add_argument("--api-key", help="klucz API Workera (pole API_KEY w .dev.vars)")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="adres Workera")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    dev = czytaj_dev_vars()
    api_key = args.api_key or dev.get("API_KEY")

    print(f"\n{'═' * 78}")
    print(f"  WERYFIKACJA U BROKERA: {symbol}")
    print(f"{'═' * 78}\n")

    print("1. Dane z alertu (skaner)")
    dane = pobierz_kandydata(symbol, api_key, args.worker)
    c = dane["candidate"]
    front_scan = c.get("front") or {}
    back_scan = c.get("back") or {}
    spot_scan = c.get("spot")

    print(f"   ocena: {c.get('grade')} {c.get('score')}/100")
    print(f"   wyniki: {c.get('earnings', {}).get('date')} ({c.get('earnings', {}).get('timing', '?')})")
    print(f"   nogi: front {front_scan.get('expiration')} / back {back_scan.get('expiration')}")
    print(f"   skaner podaje IV: front {fmt(front_scan.get('atmIv'), '%')} / back {fmt(back_scan.get('atmIv'), '%')}")
    print(f"   nachylenie: {fmt(c.get('termStructureSlope'), 'pp')}")

    if not front_scan.get("expiration") or not back_scan.get("expiration"):
        raise SystemExit("BŁĄD: kandydat nie ma kompletu nóg — nie ma czego weryfikować.")

    print("\n2. Połączenie z IBKR")
    ib = polacz_z_ib(args.host, args.port, args.client_id)

    try:
        print("\n3. Notowania od brokera")
        wyniki: dict[str, dict[str, Any]] = {}
        for nazwa, leg in (("front", front_scan), ("back", back_scan)):
            strike = wybierz_strike(spot_scan or 0, leg.get("atmStrike"))
            print(f"\n   {nazwa}: {leg.get('expiration')} strike {strike} CALL")
            kontrakt, spot_ib, _ = pobierz_kontrakt(
                ib, symbol, leg.get("expiration"), strike, "C"
            )
            if nazwa == "front" and spot_ib:
                print(f"   kurs od IB: {spot_ib:.2f}  (skaner miał {fmt(spot_scan)})")
            q = pobierz_notowanie(ib, kontrakt)
            wyniki[nazwa] = q
            print(f"      bid {fmt(q['bid'])} / ask {fmt(q['ask'])}  →  mid {fmt(q['mid'])}   last {fmt(q['last'])}  ({q['last_position']})")
            print(f"      spread: {fmt(q['spread_pct'], '%', 1)}   OI: {q['open_interest'] or 'n/d'}   wolumen: {q['volume'] or 'n/d'}")
            if q["iv_ib"]:
                print(f"      IV od IB: {q['iv_ib'] * 100:.1f}%")

        print(f"\n{'─' * 78}")
        print("4. CZY STRUKTURA JEST WYKONALNA")
        print(f"{'─' * 78}\n")

        # UWAGA: NIE liczymy tu IV sami i nie porównujemy jej z tastytrade.
        # Powód: tastytrade podaje IV policzoną swoją metodyką (z dywidendą i ceną
        # forward), a skaner bierze ją WPROST — nie liczy niczego sam. Liczenie IV
        # z cen brokera wprowadzało sztuczną różnicę 2-3pp, która brała się
        # z odmiennej metodyki, a nie z błędów danych. Wnioski z takiego
        # porównania były mylące, więc zostało usunięte.
        #
        # Weryfikujemy to, czego tastytrade NIE DAJE: realny spread bid-ask,
        # głębokość rynku i faktyczny koszt zbudowania struktury.

        for nazwa, leg in (("front", front_scan), ("back", back_scan)):
            q = wyniki[nazwa]
            print(f"   {nazwa.upper():6s} {leg.get('expiration')}  strike {leg.get('atmStrike')}")
            print(f"      bid {fmt(q['bid'])} / ask {fmt(q['ask'])}   (mid {fmt(q['mid'])}, last {fmt(q['last'])} — {q['last_position']})")
            spread = q["spread_pct"]
            if spread is not None:
                ocena = "dobry" if spread < 0.03 else ("akceptowalny" if spread < 0.08 else "SZEROKI — uwaga")
                print(f"      spread bid-ask: {fmt(spread, '%', 1)}  →  {ocena}")
            print(f"      OI: {q['open_interest'] or 'n/d'}   wolumen dziś: {q['volume'] or 'n/d'}")

        # Koszt zbudowania kalendarza: kupujesz back, sprzedajesz front.
        if wyniki["front"]["mid"] and wyniki["back"]["mid"]:
            print(f"\n   KOSZT STRUKTURY (wycena po mid):        {wyniki['back']['mid'] - wyniki['front']['mid']:+.2f}")
            if wyniki["front"]["ask"] and wyniki["back"]["bid"]:
                zle = wyniki["back"]["bid"] - wyniki["front"]["ask"]
                print(f"   W NAJGORSZYM WARIANCIE (back po bid,")
                print(f"   front po ask):                          {zle:+.2f}")
                roznica = (wyniki["back"]["mid"] - wyniki["front"]["mid"]) - zle
                print(f"   Koszt spreadów:                         {roznica:.2f}  ({roznica / max(abs(zle), 0.01) * 100:.0f}% ceny struktury)")

        # Kontekst: co mówi tastytrade (dla przypomnienia, bez przeliczania)
        print(f"\n   KONTEKST Z TASTYTRADE (to są dane skanera, nie moje obliczenia):")
        print(f"      IV front {fmt(front_scan.get('atmIv'), '%')} / back {fmt(back_scan.get('atmIv'), '%')}")
        print(f"      nachylenie term structure: {fmt(c.get('termStructureSlope'), 'pp')}")
        nach = c.get("termStructureSlope")
        if nach is not None:
            if nach > 0.04:
                print("      → Silne kontango: back wyraźnie droższy, jest miejsce na ekspansję.")
            elif nach > 0.015:
                print("      → Umiarkowane kontango: teza słabsza, ale kierunek właściwy.")
            else:
                print("      → Nachylenie płaskie lub odwrócone: premia eventowa już w krótszej nodze.")
        print(f"      implied move (model tastytrade/BS): {fmt(front_scan.get('impliedMovePct'), '%')}")

        print(f"\n{'═' * 78}")
        print("  Weryfikacja zakończona. Skrypt nie składał żadnych zleceń.")
        print(f"{'═' * 78}\n")
        return 0

    finally:
        ib.disconnect()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nPrzerwano.")
        sys.exit(130)
