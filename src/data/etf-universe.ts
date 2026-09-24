/**
 * ETF-y o realnej płynności opcji — dodatek do top 200 spółek.
 *
 * PO CO: na spółkach z dołu top 200 (i na ADR-ach) łańcuchy bywają cienkie —
 * open interest na ATM w okolicy kilkudziesięciu kontraktów, spread 10%+.
 * Kalendarza na tym nie zbudujesz. Za to kilkadziesiąt ETF-ów sektorowych
 * i indeksowych ma łańcuchy głębokie na setki strike'ów, a wokół wyników
 * kluczowych spółek w portfelu (albo decyzji Fed) ich IV też się rozszerza.
 *
 * WAŻNE — jak czytać wyniki dla ETF:
 *   ETF NIE MA wyników spółki. Daty, które zwróci kalendarz dla tych tickerów,
 *   to najczęściej daty dywidend/dystrybucji albo błędne dopasowania po symbolu.
 *   Dlatego:
 *     1. Domyślnie INCLUDE_ETFS=false — włączasz świadomie.
 *     2. Każdy kandydat-ETF dostaje ostrzeżenie w wyniku i flagę w scoringu.
 *     3. Traktuj je jako listę "tu warto patrzeć na term structure", a nie
 *        jako gotowe rekomendacje — kontekst zdarzenia musisz dodać sam
 *        (wyniki największych składników, posiedzenie Fed, dane makro).
 *
 * Konwencja: pole `marketCapB` to przybliżona wartość aktywów netto (AUM) w mld USD
 * i służy WYŁĄCZNIE do sortowania priorytetów, nie do obliczeń.
 */

export interface EtfEntry {
  symbol: string;
  name: string;
  sector: string;
  marketCapB: number;
  isEtf: true;
}

export const ETF_UNIVERSE: EtfEntry[] = [
  // ── Szeroki rynek ──────────────────────────────────────────────────────────
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', sector: 'Index', marketCapB: 640, isEtf: true },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: 'Index', marketCapB: 340, isEtf: true },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', sector: 'Index', marketCapB: 68, isEtf: true },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF', sector: 'Index', marketCapB: 38, isEtf: true },
  { symbol: 'MDY', name: 'SPDR S&P MidCap 400 ETF', sector: 'Index', marketCapB: 22, isEtf: true },
  { symbol: 'RSP', name: 'Invesco S&P 500 Equal Weight ETF', sector: 'Index', marketCapB: 62, isEtf: true },

  // ── Technologia i półprzewodniki (najbardziej eventowe sektory) ────────────
  { symbol: 'XLK', name: 'Technology Select Sector SPDR', sector: 'Information Technology', marketCapB: 78, isEtf: true },
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF', sector: 'Information Technology', marketCapB: 28, isEtf: true },
  { symbol: 'SOXX', name: 'iShares Semiconductor ETF', sector: 'Information Technology', marketCapB: 14, isEtf: true },
  { symbol: 'IGV', name: 'iShares Expanded Tech-Software Sector ETF', sector: 'Information Technology', marketCapB: 11, isEtf: true },
  { symbol: 'CIBR', name: 'First Trust NASDAQ Cybersecurity ETF', sector: 'Information Technology', marketCapB: 8, isEtf: true },

  // ── Sektory cykliczne ─────────────────────────────────────────────────────
  { symbol: 'XLE', name: 'Energy Select Sector SPDR', sector: 'Energy', marketCapB: 37, isEtf: true },
  { symbol: 'XOP', name: 'SPDR S&P Oil & Gas Exploration & Production ETF', sector: 'Energy', marketCapB: 7, isEtf: true },
  { symbol: 'OIH', name: 'VanEck Oil Services ETF', sector: 'Energy', marketCapB: 2, isEtf: true },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR', sector: 'Financials', marketCapB: 52, isEtf: true },
  { symbol: 'KRE', name: 'SPDR S&P Regional Banking ETF', sector: 'Financials', marketCapB: 4, isEtf: true },
  { symbol: 'KBE', name: 'SPDR S&P Bank ETF', sector: 'Financials', marketCapB: 3, isEtf: true },
  { symbol: 'XLI', name: 'Industrial Select Sector SPDR', sector: 'Industrials', marketCapB: 24, isEtf: true },
  { symbol: 'XLB', name: 'Materials Select Sector SPDR', sector: 'Materials', marketCapB: 6, isEtf: true },
  { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR', sector: 'Consumer Discretionary', marketCapB: 23, isEtf: true },
  { symbol: 'XLP', name: 'Consumer Staples Select Sector SPDR', sector: 'Consumer Staples', marketCapB: 16, isEtf: true },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR', sector: 'Health Care', marketCapB: 38, isEtf: true },
  { symbol: 'XBI', name: 'SPDR S&P Biotech ETF', sector: 'Health Care', marketCapB: 7, isEtf: true },
  { symbol: 'IBB', name: 'iShares Biotechnology ETF', sector: 'Health Care', marketCapB: 7, isEtf: true },
  { symbol: 'XRT', name: 'SPDR S&P Retail ETF', sector: 'Consumer Discretionary', marketCapB: 1, isEtf: true },
  { symbol: 'XHB', name: 'SPDR S&P Homebuilders ETF', sector: 'Consumer Discretionary', marketCapB: 2, isEtf: true },
  { symbol: 'XLU', name: 'Utilities Select Sector SPDR', sector: 'Utilities', marketCapB: 19, isEtf: true },
  { symbol: 'XLRE', name: 'Real Estate Select Sector SPDR', sector: 'Real Estate', marketCapB: 8, isEtf: true },
  { symbol: 'XLC', name: 'Communication Services Select Sector SPDR', sector: 'Communication Services', marketCapB: 22, isEtf: true },

  // ── Tematyczne / inne ─────────────────────────────────────────────────────
  { symbol: 'GLD', name: 'SPDR Gold Shares', sector: 'Commodities', marketCapB: 105, isEtf: true },
  { symbol: 'SLV', name: 'iShares Silver Trust', sector: 'Commodities', marketCapB: 15, isEtf: true },
  { symbol: 'USO', name: 'United States Oil Fund', sector: 'Commodities', marketCapB: 1, isEtf: true },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', sector: 'Fixed Income', marketCapB: 48, isEtf: true },
  { symbol: 'HYG', name: 'iShares iBoxx High Yield Corporate Bond ETF', sector: 'Fixed Income', marketCapB: 17, isEtf: true },
  { symbol: 'EEM', name: 'iShares MSCI Emerging Markets ETF', sector: 'Emerging Markets', marketCapB: 18, isEtf: true },
  { symbol: 'FXI', name: 'iShares China Large-Cap ETF', sector: 'Emerging Markets', marketCapB: 6, isEtf: true },
  { symbol: 'EWZ', name: 'iShares MSCI Brazil ETF', sector: 'Emerging Markets', marketCapB: 5, isEtf: true },
  { symbol: 'ARKK', name: 'ARK Innovation ETF', sector: 'Thematic', marketCapB: 7, isEtf: true },
  { symbol: 'BITO', name: 'ProShares Bitcoin Strategy ETF', sector: 'Thematic', marketCapB: 2, isEtf: true },
];
