import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { YahooAdapter, toYahooSymbol } from '../yahoo';

describe('toYahooSymbol exchange suffix mapping', () => {
  it('US has no suffix', () => {
    assert.equal(toYahooSymbol('NVDA', 'US'), 'NVDA');
  });

  it('Shanghai uses .SS', () => {
    assert.equal(toYahooSymbol('600519', 'SS'), '600519.SS');
  });

  it('Shenzhen uses .SZ', () => {
    assert.equal(toYahooSymbol('000001', 'SZ'), '000001.SZ');
  });

  it('Hong Kong pads to 4 digits and uses .HK', () => {
    assert.equal(toYahooSymbol('700', 'HK'), '0700.HK');
    assert.equal(toYahooSymbol('5', 'HK'), '0005.HK');
    assert.equal(toYahooSymbol('0700', 'HK'), '0700.HK');
  });

  it('KOSPI uses .KS, KOSDAQ uses .KQ', () => {
    assert.equal(toYahooSymbol('005930', 'KS'), '005930.KS');
    assert.equal(toYahooSymbol('035720', 'KQ'), '035720.KQ');
  });

  it('Tokyo uses .T', () => {
    assert.equal(toYahooSymbol('7203', 'T'), '7203.T');
  });

  it('Thailand uses .BK', () => {
    assert.equal(toYahooSymbol('PTT', 'BK'), 'PTT.BK');
  });

  it('London uses .L', () => {
    assert.equal(toYahooSymbol('HSBA', 'L'), 'HSBA.L');
  });

  it('Xetra uses .DE', () => {
    assert.equal(toYahooSymbol('SAP', 'DE'), 'SAP.DE');
  });

  it('Euronext venues use their own suffixes', () => {
    assert.equal(toYahooSymbol('MC', 'PA'), 'MC.PA');
    assert.equal(toYahooSymbol('ASML', 'AS'), 'ASML.AS');
    assert.equal(toYahooSymbol('ABI', 'BR'), 'ABI.BR');
    assert.equal(toYahooSymbol('EDP', 'LS'), 'EDP.LS');
    assert.equal(toYahooSymbol('ENI', 'MI'), 'ENI.MI');
  });

  it('Does not double-suffix when symbol already contains a dot', () => {
    assert.equal(toYahooSymbol('0700.HK', 'HK'), '0700.HK');
    assert.equal(toYahooSymbol('SAP.DE', 'DE'), 'SAP.DE');
  });
});

describe('YahooAdapter with mocked client', () => {
  it('London prices are divided by 100 (pence -> pounds)', async () => {
    const mock = {
      async search() {
        return { quotes: [] };
      },
      async chart() {
        return {
          quotes: [
            {
              date: new Date('2025-01-02T00:00:00Z'),
              open: 700,
              high: 720,
              low: 695,
              close: 710,
              volume: 1000,
            },
          ],
        };
      },
    };
    const adapter = new YahooAdapter(mock);
    const bars = await adapter.getDailyOhlcv('HSBA', 'L', new Date(0), new Date());
    assert.equal(bars.length, 1);
    const first = bars[0]!;
    assert.equal(first.close, 7.1);
    assert.equal(first.open, 7);
    assert.equal(first.high, 7.2);
    assert.equal(first.low, 6.95);
    assert.equal(first.date, '2025-01-02');
  });

  it('Non-pence exchanges keep raw close', async () => {
    const mock = {
      async search() {
        return { quotes: [] };
      },
      async chart() {
        return {
          quotes: [
            {
              date: new Date('2025-01-02T00:00:00Z'),
              open: 500,
              high: 510,
              low: 495,
              close: 505,
              volume: 0,
            },
          ],
        };
      },
    };
    const adapter = new YahooAdapter(mock);
    const bars = await adapter.getDailyOhlcv('NVDA', 'US', new Date(0), new Date());
    assert.equal(bars[0]!.close, 505);
  });

  it('searchSymbols passes through and maps exchange from suffix', async () => {
    const mock = {
      async search() {
        return {
          quotes: [
            { symbol: '0700.HK', shortname: 'Tencent', currency: 'HKD', quoteType: 'EQUITY' },
            { symbol: 'NVDA', longname: 'NVIDIA Corp', currency: 'USD', quoteType: 'EQUITY' },
          ],
        };
      },
      async chart() {
        return { quotes: [] };
      },
    };
    const adapter = new YahooAdapter(mock);
    const all = await adapter.searchSymbols('tencent');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.exchange, 'HK');
    assert.equal(all[1]!.exchange, 'US');

    const hk = await adapter.searchSymbols('tencent', 'HK');
    assert.equal(hk.length, 1);
    assert.equal(hk[0]!.symbol, '0700.HK');
  });

  it('intraday bars are scaled per exchange', async () => {
    const mock = {
      async search() {
        return { quotes: [] };
      },
      async chart() {
        return {
          quotes: [
            {
              date: new Date('2025-01-02T09:30:00Z'),
              open: 800,
              high: 805,
              low: 798,
              close: 803,
              volume: 100,
            },
          ],
        };
      },
    };
    const adapter = new YahooAdapter(mock);
    const bars = await adapter.getIntradayOhlcv(
      'HSBA',
      'L',
      new Date('2025-01-02T00:00:00Z'),
      new Date('2025-01-03T00:00:00Z'),
      '1h',
    );
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.close, 8.03);
    assert.equal(bars[0]!.interval, '1h');
  });
});
