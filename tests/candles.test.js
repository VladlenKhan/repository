import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage.js', () => ({
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

const { issueToken, ROLES } = await import('../lib/auth.js');
const candlesFn = (await import('../netlify/functions/candles.mjs')).default;

const SECRET = 'секрет-подписи';

/** Ответ Twelve Data: свечи идут от новых к старым. */
function payload(count = 300) {
  const start = Date.UTC(2026, 9, 1, 0, 0, 0);
  const values = Array.from({ length: count }, (_, i) => {
    const close = 4100 + i * 0.5;
    const time = new Date(start + i * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    return {
      datetime: time,
      open: String(close - 1), high: String(close + 4),
      low: String(close - 4), close: String(close), volume: '0',
    };
  }).reverse();
  return { status: 'ok', values };
}

const request = (token, timeframe = '1h') =>
  new Request(`https://x/api/candles?timeframe=${timeframe}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

let userToken;

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('TWELVE_DATA_API_KEY', 'key');
  userToken = issueToken({ login: 'vasya', role: ROLES.USER }, SECRET);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload() })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('доступ', () => {
  it('без токена отказано', async () => {
    expect((await candlesFn(request(null))).status).toBe(401);
  });

  it('вошедшему пользователю разрешено — это рыночные данные', async () => {
    expect((await candlesFn(request(userToken))).status).toBe(200);
  });
});

describe('формат данных для графика', () => {
  it('отдаёт время в секундах, а не в миллисекундах', async () => {
    // Библиотека графика ждёт секунды. С миллисекундами она построит
    // шкалу где-то в 56-тысячном году, и график будет пустым.
    const body = await (await candlesFn(request(userToken))).json();
    const first = body.candles[0].time;

    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeLessThan(10_000_000_000);
    expect(new Date(first * 1000).getUTCFullYear()).toBe(2026);
  });

  it('свечи идут строго по возрастанию времени', async () => {
    // Иначе библиотека выбрасывает ошибку и график не строится вовсе.
    const body = await (await candlesFn(request(userToken))).json();

    for (let i = 1; i < body.candles.length; i++) {
      expect(body.candles[i].time).toBeGreaterThan(body.candles[i - 1].time);
    }
  });

  it('у каждой свечи есть все четыре цены', async () => {
    const body = await (await candlesFn(request(userToken))).json();

    for (const candle of body.candles.slice(0, 5)) {
      for (const field of ['open', 'high', 'low', 'close']) {
        expect(Number.isFinite(candle[field])).toBe(true);
      }
      expect(candle.high).toBeGreaterThanOrEqual(candle.low);
    }
  });

  it('ряды EMA не содержат пустых точек', async () => {
    // Незаполненные значения в начале отбрасываются, иначе линия
    // начиналась бы с разрыва.
    const body = await (await candlesFn(request(userToken))).json();

    expect(body.ema50.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(body.ema200.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  it('EMA 200 короче EMA 50 ровно на срок прогрева', async () => {
    const body = await (await candlesFn(request(userToken))).json();
    expect(body.ema50.length - body.ema200.length).toBe(150);
  });

  it('точки EMA выровнены по времени свечей', async () => {
    const body = await (await candlesFn(request(userToken))).json();
    const times = new Set(body.candles.map((c) => c.time));

    expect(body.ema50.every((p) => times.has(p.time))).toBe(true);
  });

  it('отдаёт пивот-уровни', async () => {
    const body = await (await candlesFn(request(userToken))).json();
    expect(body.pivots).toHaveProperty('pp');
    expect(body.pivots).toHaveProperty('r1');
    expect(body.pivots).toHaveProperty('s3');
  });
});

describe('дубликаты в ответе поставщика', () => {
  it('дневной ряд остаётся строго возрастающим', async () => {
    // Twelve Data присылает одну и ту же дату дважды на 1day.
    // Библиотека графика на повторе выбрасывает ошибку.
    fetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        status: 'ok',
        values: [
          { datetime: '2026-10-07', open: '4100', high: '4110', low: '4090', close: '4105' },
          { datetime: '2026-10-06', open: '4090', high: '4100', low: '4080', close: '4095' },
          { datetime: '2026-10-04', open: '4080', high: '4090', low: '4070', close: '4085' },
          { datetime: '2026-10-04', open: '4080', high: '4090', low: '4070', close: '4085' },
        ],
      }),
    });

    const body = await (await candlesFn(request(userToken, '1day'))).json();

    expect(body.candles).toHaveLength(3);
    for (let i = 1; i < body.candles.length; i++) {
      expect(body.candles[i].time).toBeGreaterThan(body.candles[i - 1].time);
    }
  });
});

describe('таймфреймы', () => {
  it('запрашивает указанный таймфрейм', async () => {
    await candlesFn(request(userToken, '4h'));
    expect(fetch.mock.calls[0][0].toString()).toContain('interval=4h');
  });

  it('понимает сокращения', async () => {
    const body = await (await candlesFn(request(userToken, 'D1'))).json();
    expect(body.timeframe).toBe('1day');
  });

  it('отвергает неизвестный таймфрейм', async () => {
    expect((await candlesFn(request(userToken, '3h'))).status).toBe(400);
  });
});

describe('сбои поставщика данных', () => {
  it('понятно сообщает об исчерпанном лимите', async () => {
    fetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: 'error', code: 429, message: 'out of credits' }),
    });

    const response = await candlesFn(request(userToken));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('Лимит');
  });

  it('понятно сообщает о недоступности', async () => {
    fetch.mockRejectedValue(new Error('network down'));

    const response = await candlesFn(request(userToken));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('недоступен');
  });
});
