import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricesError, createTwelveDataProvider, getCandlesCached } from '../lib/prices.js';
import * as storage from '../lib/storage.js';

// Blobs вне Netlify недоступны, поэтому хранилище подменяем целиком.
vi.mock('../lib/storage.js', () => ({
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

const provider = createTwelveDataProvider({ apiKey: 'test-key', symbol: 'XAU/USD' });

/** Ответ Twelve Data: свечи идут от новых к старым. */
const timeSeriesResponse = {
  status: 'ok',
  values: [
    { datetime: '2026-10-06 12:00:00', open: '2680', high: '2690', low: '2675', close: '2685', volume: '100' },
    { datetime: '2026-10-06 11:00:00', open: '2670', high: '2682', low: '2668', close: '2680', volume: '120' },
  ],
};

/** Удобный конструктор ответа fetch. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('getCandles', () => {
  it('разворачивает свечи от старых к новым', async () => {
    fetch.mockResolvedValue(jsonResponse(timeSeriesResponse));
    const candles = await provider.getCandles({ timeframe: '1h', limit: 2 });

    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(2680); // более ранняя свеча идёт первой
    expect(candles[1].close).toBe(2685);
  });

  it('разбирает время как UTC', async () => {
    fetch.mockResolvedValue(jsonResponse(timeSeriesResponse));
    const [first] = await provider.getCandles({ timeframe: '1h', limit: 2 });
    expect(new Date(first.time).toISOString()).toBe('2026-10-06T11:00:00.000Z');
  });

  it('передаёт ключ и параметры в запрос', async () => {
    fetch.mockResolvedValue(jsonResponse(timeSeriesResponse));
    await provider.getCandles({ timeframe: '4h', limit: 50 });

    const url = fetch.mock.calls[0][0].toString();
    expect(url).toContain('interval=4h');
    expect(url).toContain('outputsize=50');
    expect(url).toContain('apikey=test-key');
    expect(url).toContain(encodeURIComponent('XAU/USD'));
  });

  it('распознаёт лимит, присланный под видом успешного ответа', async () => {
    // Twelve Data отвечает HTTP 200, а об ошибке сообщает в теле.
    fetch.mockResolvedValue(
      jsonResponse({ status: 'error', code: 429, message: 'You have run out of API credits' }),
    );

    await expect(provider.getCandles({ timeframe: '1h', limit: 10 })).rejects.toMatchObject({
      name: 'PricesError',
      kind: 'rate_limit',
    });
  });

  it('распознаёт лимит по коду HTTP 429', async () => {
    fetch.mockResolvedValue(jsonResponse({}, 429));
    await expect(provider.getCandles({ timeframe: '1h', limit: 10 })).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('помечает сетевой сбой как недоступность', async () => {
    fetch.mockRejectedValue(new Error('network down'));
    await expect(provider.getCandles({ timeframe: '1h', limit: 10 })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('помечает таймаут как недоступность', async () => {
    fetch.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(provider.getCandles({ timeframe: '1h', limit: 10 })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('сообщает об ошибке, если свечей не пришло', async () => {
    fetch.mockResolvedValue(jsonResponse({ status: 'ok', values: [] }));
    await expect(provider.getCandles({ timeframe: '1h', limit: 10 })).rejects.toBeInstanceOf(
      PricesError,
    );
  });
});

describe('getQuote', () => {
  it('возвращает число', async () => {
    fetch.mockResolvedValue(jsonResponse({ price: '2684.55' }));
    const quote = await provider.getQuote();
    expect(quote.price).toBe(2684.55);
  });

  it('не пропускает нечисловую цену', async () => {
    fetch.mockResolvedValue(jsonResponse({ price: 'n/a' }));
    await expect(provider.getQuote()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('getCandlesCached', () => {
  it('отдаёт кэш, не трогая сеть', async () => {
    storage.getCachedCandles.mockResolvedValueOnce([{ close: 1 }]);
    const result = await getCandlesCached({ timeframe: '1h', limit: 10, provider });

    expect(result).toEqual([{ close: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('идёт в сеть и кладёт результат в кэш при промахе', async () => {
    storage.getCachedCandles.mockResolvedValueOnce(null);
    fetch.mockResolvedValue(jsonResponse(timeSeriesResponse));

    await getCandlesCached({ timeframe: '1h', limit: 10, provider });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.setCachedCandles).toHaveBeenCalledOnce();

    // Время жизни кэша — четверть часа для часового таймфрейма.
    const [, , ttl] = storage.setCachedCandles.mock.calls[0];
    expect(ttl).toBe(15 * 60_000);
  });

  it('ключ кэша учитывает провайдера, символ и таймфрейм', async () => {
    storage.getCachedCandles.mockResolvedValueOnce(null);
    fetch.mockResolvedValue(jsonResponse(timeSeriesResponse));

    await getCandlesCached({ timeframe: '4h', limit: 300, provider });

    expect(storage.getCachedCandles).toHaveBeenCalledWith('twelvedata:XAU/USD:4h:300');
  });
});

describe('normalizeSeries', () => {
  it('убирает повторы по времени', async () => {
    // Twelve Data на дневном таймфрейме присылает одну дату дважды.
    const { normalizeSeries } = await import('../lib/prices.js');
    const result = normalizeSeries([
      { time: 1000, close: 1 },
      { time: 1000, close: 2 },
      { time: 2000, close: 3 },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.time)).toEqual([1000, 2000]);
  });

  it('из повторов оставляет более свежую запись', async () => {
    const { normalizeSeries } = await import('../lib/prices.js');
    const result = normalizeSeries([
      { time: 1000, close: 1 },
      { time: 1000, close: 2 },
    ]);

    expect(result[0].close).toBe(2);
  });

  it('упорядочивает по возрастанию времени', async () => {
    const { normalizeSeries } = await import('../lib/prices.js');
    const result = normalizeSeries([
      { time: 3000, close: 3 },
      { time: 1000, close: 1 },
      { time: 2000, close: 2 },
    ]);

    expect(result.map((c) => c.time)).toEqual([1000, 2000, 3000]);
  });

  it('не трогает уже корректный ряд', async () => {
    const { normalizeSeries } = await import('../lib/prices.js');
    const input = [{ time: 1000, close: 1 }, { time: 2000, close: 2 }];
    expect(normalizeSeries(input)).toEqual(input);
  });
});
