/**
 * Testy wyboru ceny opcji (src/core/pricing.ts).
 *
 * To newralgiczny fragment: od wybranej ceny zależą IV, implied move, a więc
 * ocena i term structure. Błąd tutaj nie rzuca wyjątku — po prostu daje złe
 * liczby, które wyglądają wiarygodnie.
 *
 * Testy kodują regułę opisaną w nagłówku pricing.ts:
 *   wąski spread => mid; szeroki spread + last w widełkach => last;
 *   last daleko poza widełkami => mid (last jest przestarzały).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTightSpread,
  MAX_TICK_SPREAD,
  priceSourceLabel,
  selectOptionPrice,
  STALE_LAST_PCT,
  TIGHT_SPREAD_PCT,
} from '../src/core/pricing.ts';

test('wąski spread: używa środka widełek, bez ostrzeżeń', () => {
  const sel = selectOptionPrice({ bid: 3.0, ask: 3.1, last: 3.05 });
  assert.equal(sel.source, 'mid');
  assert.equal(sel.price, 3.05);
  assert.equal(sel.twoSided, true);
  assert.equal(sel.warning, undefined, 'płynny rynek nie wymaga ostrzeżeń');
});

test('szeroki spread + last WEWNĄTRZ widełek: używa ceny transakcji', () => {
  // Bid 2.00 / ask 6.00 => mid 4.00, ale realny handel po 5.00.
  // Środek szerokiego spreadu jest tu fikcją — last jest lepszy.
  const sel = selectOptionPrice({ bid: 2.0, ask: 6.0, last: 5.0 });
  assert.equal(sel.source, 'last', 'przy szerokim spreadzie last wygrywa z mid');
  assert.equal(sel.price, 5.0);
  assert.ok(!isTightSpread(2.0, 6.0, 4.0));
});

test('last dokładnie na brzegu widełek jest traktowany jako wewnątrz', () => {
  assert.equal(selectOptionPrice({ bid: 2.0, ask: 6.0, last: 2.0 }).source, 'last');
  assert.equal(selectOptionPrice({ bid: 2.0, ask: 6.0, last: 6.0 }).source, 'last');
});

test('last blisko środka, ale poza widełkami: używa last z ostrzeżeniem', () => {
  // Widełki 4.00-4.40 (mid 4.20), last 4.50 => 7% od mid, poniżej progu 25%
  const sel = selectOptionPrice({ bid: 4.0, ask: 4.4, last: 4.5 });
  assert.equal(sel.source, 'last-outside-spread');
  assert.equal(sel.price, 4.5);
  assert.ok(sel.warning, 'musi być ostrzeżenie o możliwej nieaktualności');
  assert.ok(Math.abs(4.5 - 4.2) / 4.2 < STALE_LAST_PCT);
});

test('last daleko poza widełkami: wraca do mid (last przestarzały)', () => {
  // Widełki 4.00-4.40, last 2.00 => 52% od mid, powyżej progu 25%.
  // Kurs najpewniej się przesunął od czasu tej transakcji.
  const sel = selectOptionPrice({ bid: 4.0, ask: 4.4, last: 2.0 });
  assert.equal(sel.source, 'last-outside-spread');
  assert.equal(sel.price, 4.2, 'użyto środka widełek, nie starej transakcji');
  assert.match(sel.warning!, /wcześniejszej sesji|odległa/i);
});

test('brak bid/ask, jest last: używa last z ostrzeżeniem', () => {
  const sel = selectOptionPrice({ bid: null, ask: null, last: 2.5 });
  assert.equal(sel.price, 2.5);
  assert.equal(sel.source, 'no-market');
  assert.equal(sel.twoSided, false);
  assert.match(sel.warning!, /ostatniej ceny transakcji/i);
});

test('brak bid/ask i brak last: używa close z ostrzeżeniem', () => {
  const sel = selectOptionPrice({ bid: 0, ask: 0, last: null, close: 1.75 });
  assert.equal(sel.price, 1.75);
  assert.equal(sel.source, 'no-market');
  assert.match(sel.warning!, /zamknięcia/i);
});

test('brak jakichkolwiek danych: zwraca 0 i wyraźne ostrzeżenie', () => {
  const sel = selectOptionPrice({});
  assert.equal(sel.price, 0);
  assert.equal(sel.source, 'no-market');
  assert.match(sel.warning!, /nie ma z czego policzyć/i);
});

test('odwrócone widełki (ask < bid) są traktowane jak brak rynku', () => {
  // Sytuacja z błędnych danych: ask niższy niż bid. Nie ufamy takiemu rynkowi.
  const sel = selectOptionPrice({ bid: 5.0, ask: 3.0, last: 4.2 });
  assert.equal(sel.source, 'no-market');
  assert.equal(sel.price, 4.2, 'schodzimy do ostatniej transakcji');
});

test('zera i wartości ujemne są ignorowane', () => {
  const sel = selectOptionPrice({ bid: 0, ask: -1, last: 0, close: 2.0 });
  assert.equal(sel.price, 2.0);
  assert.equal(sel.source, 'no-market');
});

test('szeroki spread i BRAK last: zostaje mid z ostrzeżeniem', () => {
  const sel = selectOptionPrice({ bid: 1.0, ask: 5.0, last: null });
  assert.equal(sel.source, 'mid');
  assert.equal(sel.price, 3.0);
  assert.match(sel.warning!, /brak ostatniej transakcji/i);
});

test('tania opcja z typowym tickiem jest uznawana za płynną (spread kwotowy)', () => {
  // bid 3.00 / ask 3.10 to spread 3.3% ceny, ale kwotowo 0.10 = typowy tick.
  // Reguła czysto procentowa błędnie uznałaby ten rynek za niepłynny.
  const sel = selectOptionPrice({ bid: 3.0, ask: 3.1, last: 3.05 });
  assert.equal(sel.source, 'mid', 'typowy tick na taniej opcji to rynek płynny');
  assert.equal(sel.price, 3.05);
  assert.equal(sel.warning, undefined);
});

test('droga opcja: procentowy próg decyduje, gdy kwotowy nie wystarcza', () => {
  // bid 99 / ask 101 => spread 2.00 kwotowo (powyżej ticku), ale 2% ceny => ciasny
  const sel = selectOptionPrice({ bid: 99, ask: 101, last: 100.5 });
  assert.equal(sel.source, 'mid');
  assert.ok(isTightSpread(99, 101, 100));
});

test('isTightSpread: kwotowo LUB procentowo wystarcza', () => {
  assert.equal(isTightSpread(3.0, 3.1, 3.05), true, 'wąski kwotowo');
  assert.equal(isTightSpread(99, 101, 100), true, 'wąski procentowo');
  assert.equal(isTightSpread(2.0, 6.0, 4.0), false, 'szeroki w obu wymiarach');
  assert.equal(isTightSpread(1.0, 1.2, 1.1), false, '0.20 na opcji za 1.10 to 18%');
  assert.ok(MAX_TICK_SPREAD > 0 && TIGHT_SPREAD_PCT > 0);
});

test('bardzo szeroki spread z last w środku daje ostrzeżenie o spreadzie', () => {
  const sel = selectOptionPrice({ bid: 1.0, ask: 9.0, last: 5.0 });
  assert.equal(sel.source, 'last');
  assert.equal(sel.price, 5.0);
  assert.match(sel.warning!, /Bardzo szeroki spread/i);
});

test('priceSourceLabel zwraca stabilne etykiety (idą do danych archiwalnych)', () => {
  assert.equal(priceSourceLabel('mid'), 'mid');
  assert.equal(priceSourceLabel('last'), 'last');
  assert.equal(priceSourceLabel('last-outside-spread'), 'last-poza-widelkami');
  assert.equal(priceSourceLabel('no-market'), 'brak-rynku');
});
