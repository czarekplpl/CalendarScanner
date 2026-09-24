/**
 * Testy matematyki: Black-Scholes, solver IV, parytet put-call.
 * Uruchomienie: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  atmIvFromQuotes,
  blackScholes,
  impliedVolatility,
  normCdf,
  normInv,
  straddlePrice,
} from '../src/core/blackscholes.ts';
import { daysBetween, easterSunday, thirdFriday, tradingDaysBetween } from '../src/core/market.ts';

const near = (actual: number, expected: number, tol = 1e-6, msg?: string) => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    msg ?? `oczekiwano ${expected} ± ${tol}, otrzymano ${actual}`,
  );
};

test('normCdf: wartości wzorcowe', () => {
  near(normCdf(0), 0.5, 1e-9);
  near(normCdf(1.96), 0.9750021049, 1e-6);
  near(normCdf(-1.96), 0.0249978951, 1e-6);
  near(normCdf(1), 0.8413447461, 1e-7);
  near(normCdf(3), 0.998650102, 1e-7);
  near(normCdf(-3), 0.001349898, 1e-7);
});

test('normInv: odwrotność normCdf', () => {
  for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    const x = normInv(p);
    near(normCdf(x), p, 1e-6, `normCdf(normInv(${p})) powinno dać ${p}`);
  }
  near(normInv(0.975), 1.959964, 1e-4);
  near(normInv(0.5), 0, 1e-9);
  assert.throws(() => normInv(0), /musi być/);
  assert.throws(() => normInv(1), /musi być/);
});

test('blackScholes: znane wartości dla opcji ATM', () => {
  // S=100, K=100, T=1, vol=20%, r=0 (żeby porównać z tablicami)
  const call = blackScholes({ type: 'call', spot: 100, strike: 100, timeToExpiry: 1, vol: 0.2, rate: 0 });
  // Wartość znana z tablic: ~7.9656
  near(call.price, 7.9656, 5e-3, 'cena call ATM powinna wynosić ~7.9656');
  near(call.delta, 0.5398, 5e-3);
  // Put ATM = call ATM przy r=0 (parytet)
  const put = blackScholes({ type: 'put', spot: 100, strike: 100, timeToExpiry: 1, vol: 0.2, rate: 0 });
  near(put.price, call.price, 1e-9, 'przy r=0 i ATM call == put');
  near(put.delta, call.delta - 1, 1e-9, 'delta puta = delta calla - 1');
});

test('blackScholes: parytet put-call z dywidendą i stopą', () => {
  const params = { spot: 152.3, strike: 150, timeToExpiry: 0.37, vol: 0.31, rate: 0.045, dividendYield: 0.012 };
  const call = blackScholes({ ...params, type: 'call' });
  const put = blackScholes({ ...params, type: 'put' });
  // C - P = S*e^(-qT) - K*e^(-rT)
  const lhs = call.price - put.price;
  const rhs =
    params.spot * Math.exp(-params.dividendYield * params.timeToExpiry) -
    params.strike * Math.exp(-params.rate * params.timeToExpiry);
  near(lhs, rhs, 1e-9, 'parytet put-call musi zachodzić dokładnie');
});

test('blackScholes: greki mają poprawne znaki', () => {
  const call = blackScholes({ type: 'call', spot: 100, strike: 105, timeToExpiry: 0.25, vol: 0.3, rate: 0.04 });
  const put = blackScholes({ type: 'put', spot: 100, strike: 95, timeToExpiry: 0.25, vol: 0.3, rate: 0.04 });
  assert.ok(call.delta > 0 && call.delta < 1, 'delta calla w (0,1)');
  assert.ok(put.delta < 0 && put.delta > -1, 'delta puta w (-1,0)');
  assert.ok(call.gamma > 0 && put.gamma > 0, 'gamma dodatnia');
  assert.ok(call.vega > 0 && put.vega > 0, 'vega dodatnia');
  assert.ok(call.theta < 0, 'theta calla ujemna dla typowej opcji');
  // Gamma i vega zależą tylko od strike/moneyness — dla tego samego K muszą być równe
  const callAtm = blackScholes({ type: 'call', spot: 100, strike: 100, timeToExpiry: 0.25, vol: 0.3, rate: 0.04 });
  const putAtm = blackScholes({ type: 'put', spot: 100, strike: 100, timeToExpiry: 0.25, vol: 0.3, rate: 0.04 });
  near(callAtm.gamma, putAtm.gamma, 1e-12, 'gamma call/put przy tej samej strike jest równa');
  near(callAtm.vega, putAtm.vega, 1e-12, 'vega call/put przy tej samej strike jest równa');
});

test('impliedVolatility: round-trip odzyskuje zadaną zmienność (ATM i przy strike)', () => {
  for (const vol of [0.08, 0.15, 0.3, 0.65, 1.2]) {
    for (const type of ['call', 'put'] as const) {
      for (const strike of [95, 100, 105]) {
        const price = blackScholes({ type, spot: 100, strike, timeToExpiry: 0.2, vol, rate: 0.04 }).price;
        const solved = impliedVolatility(price, {
          type,
          spot: 100,
          strike,
          timeToExpiry: 0.2,
          rate: 0.04,
        });
        assert.ok(solved.converged, `solver powinien zbiec dla vol=${vol} type=${type} K=${strike}`);
        near(solved.iv, vol, 1e-5, `vol=${vol}, type=${type}, K=${strike}`);
      }
    }
  }
});

test('impliedVolatility: głęboko ITM — kryterium stopu w przestrzeni IV ratuje dokładność', () => {
  // Przypadek, który ujawnił błąd projektowy: call spot=100, K=80, T=0.2, IV=8%.
  // Vega w rozwiązaniu to ~1.4e-8, więc residual ceny MUSI być rzędu 1e-14, żeby
  // wynik był dokładny. Gdyby solver zatrzymywał się na tolerancji CENY (np. 1e-6),
  // zwróciłby IV ≈ 0.106 zamiast 0.08 — liczbę, która wygląda poprawnie, a jest
  // artefaktem. Kryterium stopu na kroku (diff/vega) daje tu wynik dokładny.
  const price = blackScholes({ type: 'call', spot: 100, strike: 80, timeToExpiry: 0.2, vol: 0.08, rate: 0.04 }).price;
  const solved = impliedVolatility(price, { type: 'call', spot: 100, strike: 80, timeToExpiry: 0.2, rate: 0.04 });
  assert.ok(solved.converged, 'solver musi zbiec');
  near(solved.iv, 0.08, 1e-4, 'IV musi być dokładna mimo znikomej vega');
  assert.ok(
    Math.abs(solved.modelPrice - price) < 1e-12,
    'residual ceny musi być na poziomie precyzji maszynowej',
  );
});

test('impliedVolatility: bardzo głębokie ITM => brak rozwiązania w zakresie', () => {
  // K=60: wartość czasowa ~1e-11, poniżej dolnej granicy zakresu zmienności.
  // Tu naprawdę nie ma czego odczytać — solver musi to zgłosić.
  const price = blackScholes({ type: 'call', spot: 100, strike: 60, timeToExpiry: 0.2, vol: 0.08, rate: 0.04 }).price;
  const solved = impliedVolatility(price, { type: 'call', spot: 100, strike: 60, timeToExpiry: 0.2, rate: 0.04 });
  assert.equal(solved.converged, false);
  assert.equal(solved.method, 'fallback');
});

test('impliedVolatility: ATM ma pełną wiarygodność (identyfikowalna vega)', () => {
  const price = blackScholes({ type: 'call', spot: 100, strike: 100, timeToExpiry: 0.2, vol: 0.35, rate: 0.04 }).price;
  const solved = impliedVolatility(price, { type: 'call', spot: 100, strike: 100, timeToExpiry: 0.2, rate: 0.04 });
  assert.ok(solved.converged, 'ATM musi się rozwiązać');
  assert.ok((solved.vega ?? 0) > 1e-3, 'ATM ma dużą vegę');
  near(solved.iv, 0.35, 1e-5);
});

test('impliedVolatility: lekko ITM/OTM (typowy zakres skanera) działa poprawnie', () => {
  // Skaner liczy tylko ATM, ale łańcuch bywa rzadki — sprawdzamy pasmo ±10% i różne DTE.
  for (const strike of [90, 92.5, 110]) {
    for (const dte of [7, 21, 60]) {
      for (const vol of [0.2, 0.5, 0.9]) {
        const T = dte / 365;
        const price = blackScholes({ type: 'call', spot: 100, strike, timeToExpiry: T, vol, rate: 0.04 }).price;
        const solved = impliedVolatility(price, { type: 'call', spot: 100, strike, timeToExpiry: T, rate: 0.04 });
        assert.ok(
          solved.converged,
          `powinno być identyfikowalne: K=${strike} dte=${dte} vol=${vol}`,
        );
        near(solved.iv, vol, 1e-4, `K=${strike} dte=${dte} vol=${vol}`);
      }
    }
  }
});

test('impliedVolatility: cena poniżej wartości wewnętrznej nie zmyśla wyniku', () => {
  // Call z ceną 0.01 przy spot 150 i strike 100 => arbitraż, solver nie ma rozwiązania
  const solved = impliedVolatility(0.01, {
    type: 'call',
    spot: 150,
    strike: 100,
    timeToExpiry: 0.1,
    rate: 0.04,
  });
  assert.equal(solved.converged, false, 'brak rozwiązania => converged=false');
  assert.equal(solved.method, 'fallback');
});

test('impliedVolatility: cena absurdalnie wysoka jest ograniczana do zakresu', () => {
  const solved = impliedVolatility(9999, {
    type: 'call',
    spot: 100,
    strike: 100,
    timeToExpiry: 0.1,
    rate: 0.04,
  });
  assert.equal(solved.converged, false);
  assert.ok(solved.iv <= 5.0, 'IV ograniczone do górnej granicy zakresu');
});

test('atmIvFromQuotes: IV ATM i cena straddle', () => {
  const spot = 200;
  const strike = 200;
  const trueIv = 0.42;
  const T = 30 / 365;
  const callMid = blackScholes({ type: 'call', spot, strike, timeToExpiry: T, vol: trueIv, rate: 0.04 }).price;
  const putMid = blackScholes({ type: 'put', spot, strike, timeToExpiry: T, vol: trueIv, rate: 0.04 }).price;

  const res = atmIvFromQuotes({ spot, strike, daysToExpiry: 30, callMid, putMid, rate: 0.04 });
  assert.ok(res.reliable, 'ATM z normalną IV musi być wiarygodne');
  near(res.iv, trueIv, 1e-4, 'IV ATM powinna odzyskać zadaną zmienność');
  near(res.straddle, callMid + putMid, 1e-12);
});

test('straddle: przybliżenie ceny ATM ~ 0.8 * S * vol * sqrt(T)', () => {
  const S = 100;
  const vol = 0.3;
  const T = 0.25;
  const price = straddlePrice({ spot: S, strike: S, timeToExpiry: T, vol, rate: 0 });
  const approx = 0.7979 * S * vol * Math.sqrt(T);
  near(price, approx, 0.06, 'straddle ATM powinien być blisko 0.8*S*vol*sqrt(T)');
});

test('kalendarz: Wielkanoc i Wielki Piątek', () => {
  assert.equal(easterSunday(2024), '2024-03-31');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.equal(easterSunday(2026), '2026-04-05');
  // Wielki Piątek 2026 = 3 kwietnia; giełda zamknięta, a to piątek
  assert.equal(tradingDaysBetween('2026-04-02', '2026-04-06'), 1, 'Wielki Piątek nie jest sesją');
});

test('kalendarz: trzecie piątki i liczenie sesji', () => {
  assert.equal(thirdFriday(2026, 10), '2026-10-16');
  assert.equal(thirdFriday(2026, 11), '2026-11-20');
  assert.equal(thirdFriday(2026, 12), '2026-12-18');
  // Tydzień 2026-09-21 (pon) -> 2026-09-25 (pt) = 4 sesje
  assert.equal(tradingDaysBetween('2026-09-21', '2026-09-25'), 4);
  // Dwa tygodnie
  assert.equal(tradingDaysBetween('2026-09-21', '2026-10-02'), 9);
  // Wstecz
  assert.equal(tradingDaysBetween('2026-09-25', '2026-09-21'), -4);
  // Ten sam dzień
  assert.equal(tradingDaysBetween('2026-09-21', '2026-09-21'), 0);
});

test('kalendarz: Thanksgiving 2026 (26 listopada, czwartek) jest wolny', () => {
  assert.equal(daysBetween('2026-11-25', '2026-11-30'), 5);
  // 25.11 śr -> 27.11 pt: tylko piątek jest sesją (czwartek to święto)
  assert.equal(tradingDaysBetween('2026-11-25', '2026-11-27'), 1);
  // Cały tydzień z świętem: 23,24,25,27 = 4 sesje (26 to święto, 28-29 weekend)
  assert.equal(tradingDaysBetween('2026-11-20', '2026-11-27'), 4);
});

test('kalendarz: święta przesunięte na poniedziałek', () => {
  // MLK Day 2026 = 19 stycznia (poniedziałek)
  assert.equal(tradingDaysBetween('2026-01-16', '2026-01-20'), 1, 'poniedziałek 19.01 wolny');
  // 4 lipca 2026 wypada w sobotę => NYSE zamyka w piątek 3 lipca
  assert.equal(tradingDaysBetween('2026-07-02', '2026-07-06'), 1, 'piątek 3.07 wolny za 4 lipca');
  // Nowy Rok 2026 = czwartek 1 stycznia
  assert.equal(tradingDaysBetween('2025-12-31', '2026-01-02'), 1, 'czwartek 1.01 wolny, piątek 2.01 sesja');
});

test('kalendarz: brak sesji w weekendy i święta', () => {
  assert.equal(tradingDaysBetween('2026-09-25', '2026-09-28'), 1, 'weekend nie liczy się jako sesja');
  assert.equal(tradingDaysBetween('2026-12-24', '2026-12-28'), 1, '24.12 (czw) i 25.12 (św) zamknięte, 28.12 pon otwarte');
  assert.equal(tradingDaysBetween('2026-07-02', '2026-07-06'), 1, '3.07 (pt) zamknięte za 4 lipca (sobota), 6.07 pon otwarte');
});
