// Curated instrument lists for the Markets panel. Every symbol can be charted, and anything
// else Yahoo, Binance, Coinbase, Bybit or OKX lists can be found with the symbol search.
// Group titles and filter labels are in the UI language; ids, universes and names are not.

import { t } from './i18n.js';

const y = (rows) => rows.map(([s, name]) => ({ full: `YAHOO:${s}`, name }));
const bn = (src, rows) => rows.map(([s, name]) => ({ full: `${src}:${s}`, name }));

export const MARKET_GROUPS = [
  // Complete markets, loaded live (thousands of instruments each)
  { id: 'all:us-stocks', title: t('mk.g.allUsStocks'), universe: 'us-stocks', filterLabel: t('mk.f.allSectors') },
  { id: 'all:us-etfs', title: t('mk.g.allUsEtfs'), universe: 'us-etfs' },
  { id: 'all:binance', title: t('mk.g.allBinance'), universe: 'binance', filterLabel: t('mk.f.allQuoteCoins') },
  { id: 'all:binancef', title: t('mk.g.allBinancef'), universe: 'binancef', filterLabel: t('mk.f.allQuoteCoins') },
  { id: 'all:coinbase', title: t('mk.g.allCoinbase'), universe: 'coinbase', filterLabel: t('mk.f.allQuoteCurrencies') },
  { id: 'all:bybit', title: t('mk.g.allBybit'), universe: 'bybit', filterLabel: t('mk.f.allQuoteCoins') },
  { id: 'all:bybitf', title: t('mk.g.allBybitf'), universe: 'bybitf', filterLabel: t('mk.f.allQuoteCoins') },
  { id: 'all:okx', title: t('mk.g.allOkx'), universe: 'okx', filterLabel: t('mk.f.allQuoteCoins') },
  { id: 'all:okxf', title: t('mk.g.allOkxf'), universe: 'okxf', filterLabel: t('mk.f.allQuoteCoins') },
  {
    id: 'indices', title: t('mk.g.indices'),
    items: y([
      ['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones Industrial Average'], ['^IXIC', 'Nasdaq Composite'], ['^NDX', 'Nasdaq 100'],
      ['^RUT', 'Russell 2000'], ['^VIX', 'CBOE Volatility Index'], ['^NYA', 'NYSE Composite'],
      ['^FTSE', 'FTSE 100 (UK)'], ['^GDAXI', 'DAX (Germany)'], ['^FCHI', 'CAC 40 (France)'], ['^STOXX50E', 'Euro Stoxx 50'],
      ['^IBEX', 'IBEX 35 (Spain)'], ['FTSEMIB.MI', 'FTSE MIB (Italy)'], ['^AEX', 'AEX (Netherlands)'], ['^SSMI', 'SMI (Switzerland)'],
      ['^N225', 'Nikkei 225 (Japan)'], ['^HSI', 'Hang Seng (Hong Kong)'], ['000001.SS', 'SSE Composite (China)'],
      ['^BSESN', 'BSE Sensex (India)'], ['^NSEI', 'Nifty 50 (India)'], ['^KS11', 'KOSPI (Korea)'], ['^TWII', 'Taiwan Weighted'],
      ['^AXJO', 'S&P/ASX 200 (Australia)'], ['^STI', 'Straits Times (Singapore)'], ['^GSPTSE', 'S&P/TSX (Canada)'],
      ['^BVSP', 'Bovespa (Brazil)'], ['^MXX', 'IPC (Mexico)'],
    ]),
  },
  {
    id: 'us', title: t('mk.g.us'),
    items: y([
      ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'],
      ['META', 'Meta Platforms'], ['AVGO', 'Broadcom'], ['TSLA', 'Tesla'], ['BRK-B', 'Berkshire Hathaway'], ['LLY', 'Eli Lilly'],
      ['JPM', 'JPMorgan Chase'], ['V', 'Visa'], ['UNH', 'UnitedHealth'], ['XOM', 'Exxon Mobil'], ['MA', 'Mastercard'],
      ['COST', 'Costco'], ['HD', 'Home Depot'], ['PG', 'Procter & Gamble'], ['JNJ', 'Johnson & Johnson'], ['WMT', 'Walmart'],
      ['NFLX', 'Netflix'], ['ORCL', 'Oracle'], ['BAC', 'Bank of America'], ['ABBV', 'AbbVie'], ['CRM', 'Salesforce'],
      ['KO', 'Coca-Cola'], ['AMD', 'AMD'], ['CVX', 'Chevron'], ['MRK', 'Merck'], ['PEP', 'PepsiCo'],
      ['ADBE', 'Adobe'], ['TMO', 'Thermo Fisher'], ['CSCO', 'Cisco'], ['MCD', "McDonald's"], ['ABT', 'Abbott'],
      ['INTC', 'Intel'], ['QCOM', 'Qualcomm'], ['DIS', 'Disney'], ['IBM', 'IBM'], ['PLTR', 'Palantir'],
      ['UBER', 'Uber'], ['SHOP', 'Shopify'], ['COIN', 'Coinbase Global'], ['PYPL', 'PayPal'], ['NKE', 'Nike'],
      ['BA', 'Boeing'], ['GS', 'Goldman Sachs'], ['MS', 'Morgan Stanley'], ['CAT', 'Caterpillar'], ['GE', 'GE Aerospace'],
      ['MU', 'Micron'], ['ARM', 'Arm Holdings'], ['SMCI', 'Super Micro Computer'], ['MSTR', 'Strategy'], ['SBUX', 'Starbucks'],
    ]),
  },
  {
    id: 'europe', title: t('mk.g.europe'),
    items: y([
      ['ASML.AS', 'ASML'], ['SAP.DE', 'SAP'], ['NOVO-B.CO', 'Novo Nordisk'], ['MC.PA', 'LVMH'], ['NESN.SW', 'Nestlé'],
      ['ROG.SW', 'Roche'], ['NOVN.SW', 'Novartis'], ['AZN.L', 'AstraZeneca'], ['SHEL.L', 'Shell'], ['HSBA.L', 'HSBC'],
      ['ULVR.L', 'Unilever'], ['BP.L', 'BP'], ['SIE.DE', 'Siemens'], ['ALV.DE', 'Allianz'], ['BMW.DE', 'BMW'],
      ['VOW3.DE', 'Volkswagen'], ['MBG.DE', 'Mercedes-Benz'], ['DTE.DE', 'Deutsche Telekom'], ['TTE.PA', 'TotalEnergies'],
      ['OR.PA', "L'Oréal"], ['AIR.PA', 'Airbus'], ['RMS.PA', 'Hermès'], ['SAN.MC', 'Banco Santander'], ['ITX.MC', 'Inditex'],
      ['ENI.MI', 'Eni'], ['ISP.MI', 'Intesa Sanpaolo'], ['RACE.MI', 'Ferrari'], ['ADYEN.AS', 'Adyen'], ['SPOT', 'Spotify'],
    ]),
  },
  {
    id: 'asia', title: t('mk.g.asia'),
    items: y([
      ['7203.T', 'Toyota'], ['6758.T', 'Sony'], ['9984.T', 'SoftBank Group'], ['8306.T', 'Mitsubishi UFJ'], ['6861.T', 'Keyence'],
      ['0700.HK', 'Tencent'], ['9988.HK', 'Alibaba'], ['3690.HK', 'Meituan'], ['1299.HK', 'AIA Group'], ['0005.HK', 'HSBC (HK)'],
      ['1211.HK', 'BYD'], ['005930.KS', 'Samsung Electronics'], ['000660.KS', 'SK Hynix'], ['2330.TW', 'TSMC'],
      ['2317.TW', 'Hon Hai (Foxconn)'], ['RELIANCE.NS', 'Reliance Industries'], ['TCS.NS', 'Tata Consultancy'],
      ['INFY.NS', 'Infosys'], ['HDFCBANK.NS', 'HDFC Bank'], ['BHP.AX', 'BHP'], ['CBA.AX', 'Commonwealth Bank'],
      ['CSL.AX', 'CSL'], ['D05.SI', 'DBS'], ['BABA', 'Alibaba (US)'], ['PDD', 'PDD Holdings'], ['TSM', 'TSMC (US)'],
    ]),
  },
  {
    id: 'etfs', title: t('mk.g.etfs'),
    items: y([
      ['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['IWM', 'Russell 2000'], ['DIA', 'Dow Jones'], ['VTI', 'Total US market'],
      ['VOO', 'S&P 500 (Vanguard)'], ['VEA', 'Developed markets'], ['VWO', 'Emerging markets'], ['EFA', 'EAFE'], ['EEM', 'Emerging markets (iShares)'],
      ['GLD', 'Gold'], ['SLV', 'Silver'], ['USO', 'Crude oil'], ['TLT', '20+ year Treasuries'], ['IEF', '7–10 year Treasuries'],
      ['HYG', 'High yield bonds'], ['LQD', 'Investment grade bonds'], ['XLF', 'Financials'], ['XLK', 'Technology'],
      ['XLE', 'Energy'], ['XLV', 'Health care'], ['XLI', 'Industrials'], ['XLY', 'Consumer discretionary'],
      ['XLP', 'Consumer staples'], ['XLU', 'Utilities'], ['SMH', 'Semiconductors'], ['ARKK', 'ARK Innovation'],
      ['VNQ', 'Real estate'], ['IBIT', 'Bitcoin (iShares)'], ['TQQQ', 'Nasdaq 100 3×'],
    ]),
  },
  {
    id: 'forex', title: t('mk.g.forex'),
    items: y([
      ['EURUSD=X', 'EUR / USD'], ['GBPUSD=X', 'GBP / USD'], ['USDJPY=X', 'USD / JPY'], ['USDCHF=X', 'USD / CHF'],
      ['AUDUSD=X', 'AUD / USD'], ['USDCAD=X', 'USD / CAD'], ['NZDUSD=X', 'NZD / USD'], ['EURGBP=X', 'EUR / GBP'],
      ['EURJPY=X', 'EUR / JPY'], ['GBPJPY=X', 'GBP / JPY'], ['EURCHF=X', 'EUR / CHF'], ['AUDJPY=X', 'AUD / JPY'],
      ['EURAUD=X', 'EUR / AUD'], ['USDCNY=X', 'USD / CNY'], ['USDINR=X', 'USD / INR'], ['USDMXN=X', 'USD / MXN'],
      ['USDTRY=X', 'USD / TRY'], ['USDZAR=X', 'USD / ZAR'], ['USDSEK=X', 'USD / SEK'], ['USDNOK=X', 'USD / NOK'],
      ['USDPLN=X', 'USD / PLN'], ['USDSGD=X', 'USD / SGD'], ['USDHKD=X', 'USD / HKD'], ['DX-Y.NYB', 'US Dollar Index'],
    ]),
  },
  {
    id: 'commodities', title: t('mk.g.commodities'),
    items: y([
      ['GC=F', 'Gold'], ['SI=F', 'Silver'], ['PL=F', 'Platinum'], ['PA=F', 'Palladium'], ['HG=F', 'Copper'],
      ['CL=F', 'Crude oil (WTI)'], ['BZ=F', 'Brent crude'], ['NG=F', 'Natural gas'], ['RB=F', 'Gasoline'], ['HO=F', 'Heating oil'],
      ['ZC=F', 'Corn'], ['ZW=F', 'Wheat'], ['ZS=F', 'Soybeans'], ['KC=F', 'Coffee'], ['SB=F', 'Sugar'],
      ['CC=F', 'Cocoa'], ['CT=F', 'Cotton'], ['OJ=F', 'Orange juice'], ['LE=F', 'Live cattle'], ['HE=F', 'Lean hogs'],
    ]),
  },
  {
    id: 'futures', title: t('mk.g.futures'),
    items: y([
      ['ES=F', 'S&P 500 E-mini'], ['NQ=F', 'Nasdaq 100 E-mini'], ['YM=F', 'Dow E-mini'], ['RTY=F', 'Russell 2000 E-mini'],
      ['ZB=F', 'US 30-year bond'], ['ZN=F', 'US 10-year note'], ['ZF=F', 'US 5-year note'], ['ZT=F', 'US 2-year note'],
      ['6E=F', 'Euro FX'], ['6J=F', 'Japanese yen'], ['6B=F', 'British pound'], ['BTC=F', 'Bitcoin (CME)'],
    ]),
  },
  {
    id: 'bonds', title: t('mk.g.bonds'),
    items: y([
      ['^IRX', 'US 13-week T-bill'], ['^FVX', 'US 5-year yield'], ['^TNX', 'US 10-year yield'], ['^TYX', 'US 30-year yield'],
    ]),
  },
  {
    id: 'crypto', title: t('mk.g.crypto'),
    items: bn('BINANCE', [
      ['BTCUSDT', 'Bitcoin'], ['ETHUSDT', 'Ethereum'], ['SOLUSDT', 'Solana'], ['XRPUSDT', 'XRP'], ['BNBUSDT', 'BNB'],
      ['DOGEUSDT', 'Dogecoin'], ['ADAUSDT', 'Cardano'], ['TRXUSDT', 'TRON'], ['AVAXUSDT', 'Avalanche'], ['LINKUSDT', 'Chainlink'],
      ['DOTUSDT', 'Polkadot'], ['TONUSDT', 'Toncoin'], ['SHIBUSDT', 'Shiba Inu'], ['LTCUSDT', 'Litecoin'], ['BCHUSDT', 'Bitcoin Cash'],
      ['NEARUSDT', 'NEAR'], ['UNIUSDT', 'Uniswap'], ['APTUSDT', 'Aptos'], ['ARBUSDT', 'Arbitrum'], ['OPUSDT', 'Optimism'],
      ['SUIUSDT', 'Sui'], ['PEPEUSDT', 'Pepe'], ['ATOMUSDT', 'Cosmos'], ['FILUSDT', 'Filecoin'], ['XLMUSDT', 'Stellar'],
      ['ETCUSDT', 'Ethereum Classic'], ['AAVEUSDT', 'Aave'], ['INJUSDT', 'Injective'], ['ETHBTC', 'ETH / BTC'],
    ]),
  },
  {
    id: 'perps', title: t('mk.g.perps'),
    items: bn('BINANCEF', [
      ['BTCUSDT', 'Bitcoin perpetual'], ['ETHUSDT', 'Ethereum perpetual'], ['SOLUSDT', 'Solana perpetual'],
      ['XRPUSDT', 'XRP perpetual'], ['BNBUSDT', 'BNB perpetual'], ['DOGEUSDT', 'Dogecoin perpetual'],
      ['ADAUSDT', 'Cardano perpetual'], ['AVAXUSDT', 'Avalanche perpetual'], ['LINKUSDT', 'Chainlink perpetual'],
      ['SUIUSDT', 'Sui perpetual'], ['LTCUSDT', 'Litecoin perpetual'], ['1000PEPEUSDT', 'Pepe ×1000 perpetual'],
    ]),
  },
  {
    id: 'coinbase', title: t('mk.g.coinbase'),
    items: bn('COINBASE', [
      ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['SOL-USD', 'Solana'], ['XRP-USD', 'XRP'], ['DOGE-USD', 'Dogecoin'],
      ['ADA-USD', 'Cardano'], ['AVAX-USD', 'Avalanche'], ['LINK-USD', 'Chainlink'], ['LTC-USD', 'Litecoin'], ['DOT-USD', 'Polkadot'],
      ['SHIB-USD', 'Shiba Inu'], ['UNI-USD', 'Uniswap'], ['XLM-USD', 'Stellar'], ['BCH-USD', 'Bitcoin Cash'], ['USDT-USD', 'Tether'],
    ]),
  },
  { id: 'screen:day_gainers', title: t('mk.g.dayGainers'), screener: 'day_gainers' },
  { id: 'screen:day_losers', title: t('mk.g.dayLosers'), screener: 'day_losers' },
  { id: 'screen:most_actives', title: t('mk.g.mostActives'), screener: 'most_actives' },
  { id: 'screen:trending', title: t('mk.g.trending'), screener: 'trending' },
  { id: 'screen:small_cap_gainers', title: t('mk.g.smallCapGainers'), screener: 'small_cap_gainers' },
  { id: 'screen:growth_technology_stocks', title: t('mk.g.growthTech'), screener: 'growth_technology_stocks' },
  { id: 'screen:most_shorted_stocks', title: t('mk.g.mostShorted'), screener: 'most_shorted_stocks' },
  { id: 'screen:top_mutual_funds', title: t('mk.g.topMutualFunds'), screener: 'top_mutual_funds' },
];

export const marketCount = () => MARKET_GROUPS.reduce((n, g) => n + (g.items?.length || 0), 0);
