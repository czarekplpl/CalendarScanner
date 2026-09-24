/**
 * SCORING KALENDARZA POD EKSPANSJĘ IV PRZED WYNIKAMI
 * =================================================
 *
 * STRUKTURA, KTÓRĄ OCENIAMY (wybrana przez użytkownika):
 *
 *   long calendar = kupujesz dalsze wygaśnięcie (back), sprzedajesz bliższe (front),
 *   ta sama strike (najlepiej ATM). WCHODZISZ przed wynikami i ZAMYKASZ PRZED
 *   publikacją. Nie trzymasz struktury przez zdarzenie.
 *
 * Zarabiasz na dwóch rzeczach jednocześnie:
 *   (a) front decayuje szybciej niż back (theta netto dodatnia przy strike ~spot),
 *   (b) IV frontu rośnie szybciej niż IV backu w miarę zbliżania się wyników
 *       (term structure się wypłaszcza/odwraca) — a Ty jesteś long back / short front,
 *       więc zarabiasz na tym, że KRÓTKA NOGA DROŻEJE.
 *
 * GDZIE MAJĄ WYPADAĆ WYNIKI WZGLĘDEM NÓG — to najważniejsza decyzja w całym scoringu.
 *
 *   daysFromFrontExpiryToEarnings = dni OD wygaśnięcia frontu DO wyników
 *     > 0 : front wygasa PRZED wynikami     (chcemy tego)
 *     < 0 : front wygasa PO wynikach        (krótka noga zawiera zdarzenie)
 *
 *   ──(1)── front wygasa PRZED wynikami ──(2)── wyniki ──(3)── back wygasa
 *   d > 0                                    d = 0            d < 0
 *
 *   (1) STREFA DOCELOWA, gdy d ∈ [1, 10]:
 *       Wchodzisz na 25-35 dni przed wynikami, front wygasa tuż przed publikacją.
 *       Przez cały okres trzymania IV frontu narasta (premia eventowa napływa do
 *       bliższego wygaśnięcia najmocniej), a Ty masz ją SPRZEDANĄ — więc drożeje
 *       przeciwko Tobie... dlatego zarabiasz na DELCIE TERM STRUCTURE: back, który
 *       trzymasz, jest long vega i to on zyskuje na wzroście zmienności, podczas
 *       gdy frontowa premia jest już "zapłacona" i szybko zanika.
 *       Praktycznie: to układ, w którym zysk pochodzi z rozszerzenia się różnicy
 *       między IV back a IV front. Zamykasz PRZED publikacją, więc nie ma gapu.
 *
 *   (2) d ∈ [-3, 0] — front wygasa w dniach wyników lub tuż po nich:
 *       Nadal akceptowalne (krótka noga wygasa praktycznie ze zdarzeniem), ale
 *       rośnie ryzyko pin risk i przesunięcia daty wyników przez spółkę.
 *
 *   (3) d < -3 — front wygasa PO wynikach:
 *       Krótka noga siedzi w zdarzeniu. Jeśli planujesz zamknąć przed publikacją,
 *       to nie jest problem sam w sobie, ale struktura jest wrażliwa na to,
 *       czy faktycznie zamkniesz — dlatego dostaje wyraźnie mniej punktów.
 *
 *   d > 25 — front wygasa zbyt wcześnie przed wynikami:
 *       Premia eventowa jeszcze nie napłynęła do frontu, term structure jest płaska,
 *       nie ma czego rozgrywać. Lepiej poczekać na bliższe wygaśnięcie.
 *
 * POZOSTAŁE SKŁADNIKI (wagi w SCORE_WEIGHTS):
 *  - Term structure: chcemy, żeby front był TAŃSZY niż back (dodatnie nachylenie
 *    back IV - front IV). Wtedy krótka noga ma pole do wzrostu, a długa jest już
 *    wyceniona — to jest cała teza tej strategii.
 *  - Taniość opcjonalności: implied move frontu vs. typowy historyczny ruch po
 *    wynikach + kontrola skrajnych poziomów IV.
 *  - Płynność: open interest ATM i szerokość spreadu bid-ask decydują, czy wejście
 *    i wyjście nie zjedzą zysku. To najczęstszy powód, dla którego dobry pomysł
 *    nie jest wykonalny.
 *  - IV rank z historii zapisanej przez skaner: wolimy wchodzić, gdy IV spółki jest
 *    niska względem własnej historii.
 *
 * DODATKOWO: twarde ograniczenie oceny. Jeśli w układzie występuje którykolwiek
 * z krytycznych problemów (wyniki we froncie przy niepotwierdzonej dacie, brak
 * płynności, odwrócona krzywa), ocena jest ścinana do MAX_CRITICAL_SCORE,
 * żeby żadna kombinacja pozostałych plusów nie wypromowała układu, którego
 * po prostu nie należy brać.
 */

import { addDays, tradingDaysBetween } from './market.ts';
import type { CalendarCandidate, EarningsEvent, IvPoint, ScoreComponent } from '../types.ts';

export const SCORE_WEIGHTS = {
  timing: 34, // gdzie wypadają wyniki względem nóg
  termStructure: 22, // nachylenie term structure (teza strategii)
  cheapness: 16, // implied move vs. historia + poziom IV
  liquidity: 18, // open interest i spread
  ivRank: 10, // percentyl własnej IV
} as const;

const MAX_SCORE =
  SCORE_WEIGHTS.timing +
  SCORE_WEIGHTS.termStructure +
  SCORE_WEIGHTS.cheapness +
  SCORE_WEIGHTS.liquidity +
  SCORE_WEIGHTS.ivRank;

/** Pułap oceny, gdy w układzie jest krytyczny problem. */
export const MAX_CRITICAL_SCORE = 40;

export interface ScoreInput {
  symbol: string;
  name?: string;
  sector?: string;
  spot: number;
  earnings: EarningsEvent;
  front: IvPoint;
  back: IvPoint;
  /** Dni kalendarzowe od dziś do wyników */
  daysToEarnings: number;
  /** Dziś (YYYY-MM-DD) — do wyliczenia sugestii daty wejścia */
  today: string;
  /** Percentyl własnej IV z historii skanera (0-100) */
  ivRank?: number;
  /** Średni historyczny ruch po wynikach w ułamku (np. 0.06 = 6%) */
  avgHistoricalMovePct?: number;
  /** Minimalny OI ATM, poniżej którego struktura jest trudna do zbudowania */
  minOpenInterest?: number;
  /** Czy to ETF (nie ma wyników spółki — pomijamy składniki eventowe) */
  isEtf?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Punktacja za umiejscowienie wyników względem nóg.
 *
 * Szczyt: front wygasa 1-10 dni przed wynikami. Wtedy cały okres trzymania to
 * narastanie premii eventowej w bliższym wygaśnięciu, a my zamykamy pozycję
 * przed publikacją — dokładnie struktura, którą wybrał użytkownik.
 */
export function scoreTiming(daysFromFrontExpiryToEarnings: number): ScoreComponent {
  const max = SCORE_WEIGHTS.timing;
  const d = daysFromFrontExpiryToEarnings;
  let points: number;
  let note: string;

  if (d >= 1 && d <= 10) {
    points = max;
    note = `Front wygasa ${d} dni przed wynikami — strefa docelowa: cały okres trzymania to napływ premii eventowej do bliższego wygaśnięcia, a zamykasz przed publikacją.`;
  } else if (d >= 11 && d <= 25) {
    points = max * 0.72;
    note = `Front wygasa ${d} dni przed wynikami — układ dobry, ale premia eventowa napływa do frontu dopiero w ostatnich dniach; wejście może być przedwczesne.`;
  } else if (d >= -3 && d <= 0) {
    points = max * 0.65;
    note = `Front wygasa ${Math.abs(d)} dni po wynikach — krótka noga obejmuje zdarzenie. Do przyjęcia, ale rośnie pin risk i ryzyko przesunięcia daty przez spółkę.`;
  } else if (d > 25) {
    points = max * 0.25;
    note = `Front wygasa ${d} dni przed wynikami — za wcześnie: term structure jest jeszcze płaska i nie ma czego rozgrywać. Poczekaj na bliższe wygaśnięcie.`;
  } else {
    points = max * 0.3;
    note = `Front wygasa ${Math.abs(d)} dni PO wynikach — krótka noga siedzi w zdarzeniu. Struktura wymaga konsekwentnego zamknięcia przed publikacją, inaczej bierzesz na siebie gap.`;
  }

  return { key: 'timing', label: 'Umiejscowienie wyników', points: round1(points), maxPoints: max, note };
}

/**
 * Term structure: back IV - front IV (w punktach procentowych).
 *
 * Dodatnie nachylenie jest TU tezą strategii: front jest tańszy niż back, czyli
 * rynek jeszcze nie wycenił w pełni zdarzenia w bliższym terminie. Krótka noga
 * (którą sprzedajesz) ma pole do wzrostu, długa (którą trzymasz) jest już wyceniona.
 * Odwrócona krzywa oznacza, że premia eventowa JUŻ jest w froncie — nie ma z czego zarabiać.
 */
export function scoreTermStructure(frontIv: number, backIv: number): ScoreComponent {
  const max = SCORE_WEIGHTS.termStructure;
  const spreadPp = (backIv - frontIv) * 100;
  let points: number;
  let note: string;

  if (spreadPp >= 6) {
    points = max;
    note = `Back IV wyższa o ${spreadPp.toFixed(1)} pp — front wyraźnie nie wycenia zdarzenia, jest miejsce na ekspansję.`;
  } else if (spreadPp >= 2) {
    points = max * 0.78;
    note = `Back IV wyższa o ${spreadPp.toFixed(1)} pp — zdrowe, dodatnie nachylenie.`;
  } else if (spreadPp >= -1) {
    points = max * 0.5;
    note = `Term structure płaska (${spreadPp.toFixed(1)} pp) — brak wyraźnej przewagi, ale też bez pułapki.`;
  } else if (spreadPp >= -4) {
    points = max * 0.25;
    note = `Front IV wyższa o ${Math.abs(spreadPp).toFixed(1)} pp — zdarzenie już w cenach frontu; część premii eventowej została wypłacona.`;
  } else {
    points = max * 0.08;
    note = `Silnie odwrócona krzywa (${spreadPp.toFixed(1)} pp) — rynek agresywnie wycenia zdarzenie w froncie; teza o ekspansji term structure jest już zrealizowana.`;
  }

  return { key: 'termStructure', label: 'Nachylenie term structure', points: round1(points), maxPoints: max, note };
}

/**
 * Taniość opcjonalności: implied move frontu vs. typowy historyczny ruch po wynikach
 * + kara za skrajne poziomy IV (bardzo niska = cienki absolutny ruch, bardzo wysoka
 * = ryzyko wejścia po szczycie zmienności).
 */
export function scoreCheapness(
  impliedMovePct: number,
  avgHistoricalMovePct: number | undefined,
  frontIv: number,
): ScoreComponent {
  const max = SCORE_WEIGHTS.cheapness;
  const parts: string[] = [];
  let points = max * 0.5; // punkt startowy, gdy brak historii do porównania

  // UWAGA — SKĄD BIERZE SIĘ `avgHistoricalMovePct` I CZYM NIE JEST:
  //
  // Jedynym darmowym źródłem, jakie mieliśmy, był endpoint Finnhuba
  // /stock/earnings, który zwraca `surprisePercent` — czyli NIESPODZIANKĘ NA EPS
  // (o ile faktyczny zysk na akcję pobił prognozę analityków). To NIE jest ruch
  // kursu akcji po wynikach. Spółka może pobić prognozę o 2% i spaść o 5%, bo
  // rynek oczekiwał więcej — i odwrotnie.
  //
  // Dodatkowo darmowy plan Finnhuba zwraca TYLKO 4 kwartały, co jest zbyt małą
  // próbą na jakąkolwiek statystykę.
  //
  // Dlatego ten parametr jest teraz ŚWIADOMIE przekazywany jako undefined
  // (patrz core/scan.ts): ocena opiera się wyłącznie na poziomie IV i jawnie
  // mówi, że brakuje historii ruchów. Wcześniej podstawialiśmy EPS jako ruch
  // kursu, co dawało pozornie precyzyjną, ale nieprawdziwą ocenę.
  //
  // Aby to naprawić, trzeba źródła z HISTORYCZNYMI KURSAMI (np. IBKR, które ma
  // dane historyczne) i policzyć realne reakcje kursu w dniu wyników.
  if (avgHistoricalMovePct && avgHistoricalMovePct > 0.005) {
    const ratio = impliedMovePct / avgHistoricalMovePct;
    if (ratio <= 0.75) {
      points = max;
      parts.push(`Rynek wycenia ruch ${(impliedMovePct * 100).toFixed(1)}% vs. historyczne ${(avgHistoricalMovePct * 100).toFixed(1)}% — opcjonalność tania.`);
    } else if (ratio <= 1.0) {
      points = max * 0.78;
      parts.push(`Implied ${(impliedMovePct * 100).toFixed(1)}% vs. historyczne ${(avgHistoricalMovePct * 100).toFixed(1)}% — wycena rozsądna.`);
    } else if (ratio <= 1.3) {
      points = max * 0.42;
      parts.push(`Implied ${(impliedMovePct * 100).toFixed(1)}% vs. historyczne ${(avgHistoricalMovePct * 100).toFixed(1)}% — rynek wycenia więcej niż typowo.`);
    } else {
      points = max * 0.15;
      parts.push(`Implied ${(impliedMovePct * 100).toFixed(1)}% vs. historyczne ${(avgHistoricalMovePct * 100).toFixed(1)}% — spora premia za zdarzenie; wchodzisz na drogo.`);
    }
  } else {
    parts.push(
      `Brak danych o historycznych ruchach kursu po wynikach — ocena wyłącznie po poziomie zmienności ` +
        `(implied move ${(impliedMovePct * 100).toFixed(1)}%). Ocena neutralna, nie „tania opcjonalność".`,
    );
  }

  const ivPct = frontIv * 100;
  if (ivPct < 18) {
    points *= 0.6;
    parts.push(`IV frontu tylko ${ivPct.toFixed(0)}% — mały absolutny ruch, słaba konweksja.`);
  } else if (ivPct > 75) {
    points *= 0.6;
    parts.push(`IV frontu ${ivPct.toFixed(0)}% — wysoko; ryzyko wejścia po szczycie zmienności.`);
  } else if (ivPct >= 25 && ivPct <= 60) {
    parts.push(`IV frontu ${ivPct.toFixed(0)}% — w komfortowym zakresie do handlu kalendarzem.`);
  }

  return {
    key: 'cheapness',
    label: 'Taniość opcjonalności',
    points: round1(clamp(points, 0, max)),
    maxPoints: max,
    note: parts.join(' '),
  };
}

/** Płynność: OI na strike ATM oraz szerokość spreadu bid-ask. */
export function scoreLiquidity(
  front: IvPoint,
  back: IvPoint,
  minOpenInterest: number,
): ScoreComponent {
  const max = SCORE_WEIGHTS.liquidity;
  const minOi = Math.min(front.atmOpenInterest, back.atmOpenInterest);
  const worstSpread = Math.max(front.atmSpreadPct, back.atmSpreadPct);

  // ── SPREAD ────────────────────────────────────────────────────────────────
  // KLUCZOWE ROZRÓŻNIENIE: `atmSpreadPct === 1` NIE znaczy „spread 100%", tylko
  // „nie wiemy". Niektórzy dostawcy (tastytrade na naszym poziomie uprawnień)
  // nie udostępniają notowań, więc spreadu po prostu nie ma z czego policzyć.
  //
  // Traktowanie braku danych jak bardzo szerokiego spreadu byłoby podwójnym
  // błędem: karałoby kandydatów za to, jakiego dostawcę wybrał użytkownik,
  // i wpychało WSZYSTKICH w cięcie krytyczne (ocena 40), przez co ranking
  // przestawał cokolwiek różnicować. Dlatego brak danych = punktów neutralnie
  // (połowa puli na spread), a nie zero.
  const spreadUnknown = worstSpread >= 0.99;
  const spreadPoints = spreadUnknown
    ? max * 0.4 * 0.5
    : clamp((0.12 - worstSpread) / (0.12 - 0.015), 0, 1) * max * 0.4;

  // ── OPEN INTEREST ─────────────────────────────────────────────────────────
  // OI: pełne punkty od 3x progu, zero poniżej progu.
  const oiRatio = minOi / Math.max(minOpenInterest, 1);
  const oiPoints = clamp((oiRatio - 1) / 2, 0, 1) * max * 0.6;

  const notes = [
    `OI ATM min(front, back) = ${minOi} kontraktów${minOi < minOpenInterest ? ` — poniżej progu ${minOpenInterest}, struktura trudna do zbudowania` : ''}.`,
    spreadUnknown
      ? 'Spread bid-ask niedostępny u tego dostawcy (brak notowań opcji) — ocena neutralna, zweryfikuj spread u brokera przed wejściem.'
      : `Najgorszy spread ATM ${(worstSpread * 100).toFixed(1)}% mid.`,
  ];

  return {
    key: 'liquidity',
    label: 'Płynność kalendarza',
    points: round1(oiPoints + spreadPoints),
    maxPoints: max,
    note: notes.join(' '),
  };
}

/** IV rank: percentyl własnej IV z historii zapisanej przez skaner. */
export function scoreIvRank(ivRank: number | undefined): ScoreComponent {
  const max = SCORE_WEIGHTS.ivRank;
  if (ivRank === undefined) {
    return {
      key: 'ivRank',
      label: 'IV rank (historia skanera)',
      points: round1(max * 0.5),
      maxPoints: max,
      note: 'Za mało danych historycznych — skaner zbiera je od pierwszego uruchomienia (potrzeba ~60 dni).',
    };
  }
  const points = clamp((75 - ivRank) / 75, 0, 1) * max;
  const note =
    ivRank <= 25
      ? `IV rank ${ivRank}% — zmienność niska względem własnej historii, dobre miejsce na long vega.`
      : ivRank <= 50
        ? `IV rank ${ivRank}% — neutralnie.`
        : ivRank <= 75
          ? `IV rank ${ivRank}% — powyżej środka; uważaj na wejście po szczycie.`
          : `IV rank ${ivRank}% — zmienność bardzo wysoko względem historii; kupowanie vega jest drogie.`;
  return { key: 'ivRank', label: 'IV rank (historia skanera)', points: round1(points), maxPoints: max, note };
}

/** Zbiera flagi i ostrzeżenia na podstawie danych i wyniku punktowego. */
/**
 * `spreadDataMissing` mówi, że dostawca nie udostępnia notowań opcji, więc
 * spreadu bid-ask nie da się policzyć. Rozróżnienie „brak danych" od „zły spread"
 * jest istotne: pierwsze nie może obniżać oceny ani być problemem krytycznym.
 */
export function buildFlagsAndWarnings(
  input: ScoreInput,
  daysFromFrontExpiryToEarnings: number,
  score: number,
  spreadDataMissing: boolean,
): { flags: string[]; warnings: string[] } {
  const flags: string[] = [];
  const warnings: string[] = [];
  const minOi = input.minOpenInterest ?? 100;
  const d = daysFromFrontExpiryToEarnings;

  if (d >= 1 && d <= 10) flags.push('STREFA-DOCELOWA');
  if (d >= -3 && d <= 0) flags.push('FRONT-NA-WYNIKACH');
  if (d <= -4) flags.push('WYNIKI-W-FRONCIE');
  if (input.back.atmIv - input.front.atmIv > 0.02) flags.push('KONTANGO');
  if (input.ivRank !== undefined && input.ivRank <= 25) flags.push('IV-NISKO');
  if (
    input.avgHistoricalMovePct &&
    input.front.impliedMovePct <= input.avgHistoricalMovePct * 0.85
  ) {
    flags.push('TANIA-OPCJONALNOSC');
  }
  if (input.front.atmOpenInterest >= minOi * 3) flags.push('PLYNNY');
  if (score >= 70 && input.earnings.confirmed) flags.push('GOTOWY-DO-ANALIZY');

  // ── Ostrzeżenia ────────────────────────────────────────────────────────────
  if (!input.earnings.confirmed) {
    warnings.push('Data wyników niepotwierdzona — spółka może ją przesunąć, a to zmienia cały układ nóg. Przy niepotwierdzonej dacie nie wchodź pełnym rozmiarem.');
  }
  if (d <= -4) {
    warnings.push(`Front wygasa ${Math.abs(d)} dni po wynikach — krótka noga zawiera zdarzenie. Jeśli nie zamkniesz pozycji przed publikacją, bierzesz na siebie gap.`);
  } else if (d <= 0) {
    warnings.push('Front wygasa w dniach publikacji wyników — rośnie pin risk (kurs przyklejony do strike) oraz ryzyko przesunięcia daty przez spółkę.');
  }
  if (d > 25) {
    warnings.push('Front wygasa bardzo wcześnie przed wynikami — premia eventowa jeszcze nie napłynęła; rozważ późniejsze wygaśnięcie.');
  }
  if (!spreadDataMissing && (input.front.atmSpreadPct > 0.08 || input.back.atmSpreadPct > 0.08)) {
    warnings.push('Szeroki spread bid-ask na strike ATM — wejście i wyjście zjedzą część zysku.');
  }
  if (spreadDataMissing) {
    warnings.push(
      'Spread bid-ask nieznany (dostawca nie udostępnia notowań opcji) — sprawdź płynność u swojego brokera przed wejściem.',
    );
  }
  if (input.front.atmOpenInterest < minOi || input.back.atmOpenInterest < minOi) {
    warnings.push(`Niski open interest ATM (front ${input.front.atmOpenInterest}, back ${input.back.atmOpenInterest}) — ryzyko, że nie zbudujesz i nie zamkniesz struktury po godziwej cenie.`);
  }
  if (input.front.dte < 7) {
    warnings.push(`Front wygasa za ${input.front.dte} dni — za mało czasu na rozwinięcie się struktury.`);
  }
  if (input.back.atmIv - input.front.atmIv < -0.02) {
    warnings.push('Term structure odwrócona — premia eventowa jest już w krótszej nodze, teza o ekspansji jest w dużej mierze zrealizowana.');
  }
  if (input.isEtf) {
    warnings.push('To ETF, nie spółka — nie ma własnych wyników. Powiązane zdarzenia to największe pozycje w portfelu lub decyzja Fed; interpretuj ocenę ostrożniej.');
  }

  return { flags, warnings };
}

function gradeFor(score: number): CalendarCandidate['grade'] {
  if (score >= 78) return 'A';
  if (score >= 63) return 'B';
  if (score >= 48) return 'C';
  return 'D';
}

/** Główna funkcja: buduje w pełni ocenionego kandydata. */
export function scoreCandidate(input: ScoreInput): CalendarCandidate {
  const daysFromFrontToEarnings = input.front.daysToEarnings;
  const components: ScoreComponent[] = [
    scoreTiming(daysFromFrontToEarnings),
    scoreTermStructure(input.front.atmIv, input.back.atmIv),
    scoreCheapness(input.front.impliedMovePct, input.avgHistoricalMovePct, input.front.atmIv),
    scoreLiquidity(input.front, input.back, input.minOpenInterest ?? 100),
    scoreIvRank(input.ivRank),
  ];

  const rawScore = components.reduce((sum, c) => sum + c.points, 0);
  let score = Math.round(clamp((rawScore / MAX_SCORE) * 100, 0, 100));

  // Czy dostawca w ogóle podaje spread bid-ask? Wartość 1 to nasz znacznik braku
  // danych (patrz core/pricing.ts) — patrz komentarz w buildFlagsAndWarnings.
  const spreadDataMissing = input.front.atmSpreadPct >= 0.99 || input.back.atmSpreadPct >= 0.99;

  const { flags, warnings } = buildFlagsAndWarnings(input, daysFromFrontToEarnings, score, spreadDataMissing);

  // ── Twarde ograniczenie: krytyczne problemy ścinają ocenę ──────────────────
  // Powód: suma punktów mogłaby wypromować układ, którego nie należy brać.
  // Np. świetna płynność i tani implied move nie ratują sytuacji, w której
  // front wygasa długo po wynikach przy niepotwierdzonej dacie.
  const critical =
    (daysFromFrontToEarnings <= -4 && !input.earnings.confirmed) ||
    Math.min(input.front.atmOpenInterest, input.back.atmOpenInterest) < (input.minOpenInterest ?? 100) ||
    input.back.atmIv - input.front.atmIv < -0.04 ||
    // Sprawdzenie spreadu tylko wtedy, gdy spread JEST ZNANY. Wartość 1 to
    // nasz znacznik "brak danych" — karanie za nią wszystkich kandydatów
    // od dostawcy bez notowań zrównałoby ich oceny z dołem skali.
    (!spreadDataMissing && (input.front.atmSpreadPct > 0.15 || input.back.atmSpreadPct > 0.15));

  if (critical) score = Math.min(score, MAX_CRITICAL_SCORE);

  const tradingDaysToEarnings = tradingDaysBetween(input.today, input.earnings.date);
  const earningsInsideBackOnly = daysFromFrontToEarnings >= 0;

  // Sugerowana data wejścia: na ~15 dni przed wygaśnięciem frontu (środek życia
  // frontu — theta jest już odczuwalna, a premia eventowa zaczyna narastać).
  const suggestedEntryDate = input.front.dte > 18 ? addDays(input.today, input.front.dte - 15) : input.today;

  return {
    symbol: input.symbol,
    name: input.name,
    sector: input.sector,
    spot: input.spot,
    earnings: input.earnings,
    daysToEarnings: input.daysToEarnings,
    tradingDaysToEarnings,
    earningsInsideBackOnly,
    front: input.front,
    back: input.back,
    termStructureSlope: input.back.atmIv - input.front.atmIv,
    termStructureRatio: input.back.atmIv > 0 ? input.front.atmIv / input.back.atmIv : undefined,
    ivRank: input.ivRank,
    avgHistoricalMovePct: input.avgHistoricalMovePct,
    score,
    grade: gradeFor(score),
    components,
    flags,
    suggestedEntryDate,
    warnings,
  };
}

export { MAX_SCORE };
