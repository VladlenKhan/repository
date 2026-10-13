import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage.js', () => ({
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

const { DEFAULT_FILTERS, backtest, bootstrap, walkForward } = await import('../lib/backtest.js');
const { normalizeSettings } = await import('../lib/trading.js');
const { issueToken } = await import('../lib/auth.js');
const backtestFn = (await import('../netlify/functions/backtest.mjs')).default;

const SECRET = 'секрет';
const settings = normalizeSettings({ enabled: true, deposit: 10000, spread: 0.3 });

/** Пилообразный ряд: даёт и структуру, и имбалансы. */
function market(count = 1200) {
  return Array.from({ length: count }, (_, i) => {
    const base = 4000 + Math.sin(i / 23) * 70 + Math.sin(i / 7) * 18 + i * 0.03;
    return {
      time: (i + 1) * 3600000,
      open: base,
      high: base + 9 + Math.abs(Math.sin(i)) * 6,
      low: base - 9 - Math.abs(Math.cos(i)) * 6,
      close: base + Math.sin(i / 3) * 4,
    };
  });
}

describe('движок бэктеста', () => {
  it('прогоняет историю и возвращает статистику', () => {
    const result = backtest(market(), settings);

    expect(result.stats).toBeDefined();
    expect(result.bars).toBeGreaterThan(0);
    expect(Array.isArray(result.positions)).toBe(true);
  });

  it('на короткой истории возвращает пустой результат', () => {
    expect(backtest(market(100), settings).stats.total).toBe(0);
  });

  it('работает быстро — иначе перебирать варианты бессмысленно', () => {
    const candles = market(5000);
    const started = Date.now();
    backtest(candles, settings);

    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('фильтры уменьшают число сделок', () => {
    const without = backtest(market(), settings, DEFAULT_FILTERS);
    const withFilter = backtest(market(), settings, { ...DEFAULT_FILTERS, minStopAtr: 1.5 });

    expect(withFilter.stats.total).toBeLessThanOrEqual(without.stats.total);
  });

  it('выключенная стратегия не торгует', () => {
    const only = normalizeSettings({
      ...settings,
      strategies: { fvgRetest: false, obRetest: false, sweepReversal: true },
    });

    const result = backtest(market(), only);
    const used = new Set(result.positions.map((p) => p.strategy));

    expect(used.has('fvgRetest')).toBe(false);
    expect(used.has('obRetest')).toBe(false);
  });

  it('спред ухудшает результат', () => {
    const clean = backtest(market(), normalizeSettings({ ...settings, spread: 0 }));
    const costly = backtest(market(), normalizeSettings({ ...settings, spread: 1 }));

    expect(costly.stats.pnlMoney).toBeLessThan(clean.stats.pnlMoney);
  });

  it('выход по времени закрывает зависшие позиции', () => {
    const result = backtest(market(), settings, { ...DEFAULT_FILTERS, maxBars: 10 });
    const byTime = result.positions.filter((p) => p.outcome === 'time');

    expect(byTime.length).toBeGreaterThan(0);
  });

  it('не превышает лимит одновременных позиций', () => {
    const limited = normalizeSettings({ ...settings, maxOpenPositions: 1 });
    const result = backtest(market(), limited);

    expect(result.positions.filter((p) => p.status === 'open').length).toBeLessThanOrEqual(1);
  });
});

describe('эндпоинт бэктеста', () => {
  const post = (token, body) =>
    new Request('https://x/api/backtest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });

  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('TWELVE_DATA_API_KEY', 'key');

    const values = market(1500)
      .map((c) => ({
        datetime: new Date(c.time).toISOString().slice(0, 19).replace('T', ' '),
        open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close),
      }))
      .reverse();

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ status: 'ok', values }),
    })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('гостю отказано', async () => {
    expect((await backtestFn(post(null, {}))).status).toBe(401);
  });

  it('вошедшему отдаёт три набора цифр', async () => {
    const token = issueToken({ login: 'tg1', role: 'user' }, SECRET);
    const body = await (await backtestFn(post(token, { settings: { timeframe: '1h' } }))).json();

    // Разделение встроено: по нему видно, насколько результат подогнан.
    expect(body.train).toBeDefined();
    expect(body.test).toBeDefined();
    expect(body.full).toBeDefined();
  });

  it('торгуемые участки частей не перекрываются', async () => {
    // Главное свойство разделения: сделки проверочной части не могли
    // участвовать в подборе. Сумма торгуемых свечей не должна
    // превышать общее их число — иначе участки наложились.
    const token = issueToken({ login: 'tg1', role: 'user' }, SECRET);
    const body = await (await backtestFn(post(token, { settings: { timeframe: '1h' } }))).json();

    expect(body.period.trainBars).toBeGreaterThan(0);
    expect(body.period.testBars).toBeGreaterThan(0);
    expect(body.period.trainBars + body.period.testBars).toBeLessThanOrEqual(body.period.bars);
  });

  it('отдаёт кривую капитала', async () => {
    const token = issueToken({ login: 'tg1', role: 'user' }, SECRET);
    const body = await (await backtestFn(post(token, { settings: { timeframe: '1h' } }))).json();

    expect(Array.isArray(body.equity)).toBe(true);
    if (body.equity.length > 1) {
      // Кривая должна идти по возрастанию времени.
      expect(body.equity[1].time).toBeGreaterThanOrEqual(body.equity[0].time);
    }
  });

  it('отвергает неизвестный таймфрейм', async () => {
    const token = issueToken({ login: 'tg1', role: 'user' }, SECRET);
    expect((await backtestFn(post(token, { settings: { timeframe: '3h' } }))).status).toBe(400);
  });

  it('понятно сообщает об исчерпанном лимите API', async () => {
    fetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: 'error', code: 429, message: 'out of credits' }),
    });

    const token = issueToken({ login: 'tg1', role: 'user' }, SECRET);
    const response = await backtestFn(post(token, { settings: { timeframe: '1h' } }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('Лимит');
  });
});

describe('скользящая проверка', () => {
  it('делит историю на несколько окон', () => {
    const result = walkForward(market(4000), settings, {}, { trainBars: 800, testBars: 400 });

    expect(result.summary.windowCount).toBeGreaterThan(2);
    expect(result.windows.length).toBe(result.summary.windowCount);
  });

  it('проверочные окна идут последовательно и не повторяются', () => {
    const result = walkForward(market(4000), settings, {}, { trainBars: 800, testBars: 400 });

    for (let i = 1; i < result.windows.length; i++) {
      expect(result.windows[i].from).toBeGreaterThan(result.windows[i - 1].from);
    }
  });

  it('считает долю прибыльных окон', () => {
    const result = walkForward(market(4000), settings, {}, { trainBars: 800, testBars: 400 });

    expect(result.summary.consistency).toBeGreaterThanOrEqual(0);
    expect(result.summary.consistency).toBeLessThanOrEqual(100);
  });

  it('отдаёт сделки проверочных окон отдельно', () => {
    // Это единственный набор, не участвовавший в подборе параметров.
    const result = walkForward(market(4000), settings, {}, { trainBars: 800, testBars: 400 });
    expect(Array.isArray(result.testPositions)).toBe(true);
  });

  it('на короткой истории окон не строит', () => {
    expect(walkForward(market(500), settings).summary.windowCount).toBe(0);
  });
});

describe('оценка значимости', () => {
  const trades = (count, pnl) =>
    Array.from({ length: count }, () => ({ status: 'closed', pnlMoney: pnl }));

  it('на малом числе сделок не считает', () => {
    expect(bootstrap(trades(10, 100))).toBeNull();
  });

  it('даёт интервал вокруг медианы', () => {
    const result = bootstrap([...trades(60, 100), ...trades(40, -80)]);

    expect(result.pnl.low).toBeLessThanOrEqual(result.pnl.median);
    expect(result.pnl.median).toBeLessThanOrEqual(result.pnl.high);
  });

  it('у стабильно прибыльного набора нижняя граница выше нуля', () => {
    const result = bootstrap(trades(100, 50));

    expect(result.pnl.low).toBeGreaterThan(0);
    expect(result.lossProbability).toBe(0);
  });

  it('у набора около нуля интервал пересекает ноль', () => {
    // Половина сделок в плюс, половина в такой же минус — результат
    // неотличим от случайности, и это должно быть видно.
    const result = bootstrap([...trades(50, 100), ...trades(50, -100)]);

    expect(result.pnl.low).toBeLessThan(0);
    expect(result.lossProbability).toBeGreaterThan(20);
  });

  it('результат воспроизводим при одном seed', () => {
    const set = [...trades(60, 100), ...trades(40, -80)];
    expect(bootstrap(set, { seed: 7 })).toEqual(bootstrap(set, { seed: 7 }));
  });

  it('разные seed дают разные выборки', () => {
    // Набор с разнообразными величинами: на двух одинаковых значениях
    // медиана совпала бы при любых выборках, и проверка была бы пустой.
    const varied = Array.from({ length: 80 }, (_, i) => ({
      status: 'closed',
      pnlMoney: i % 3 === 0 ? -40 - i : 70 + i * 2,
    }));

    const a = JSON.stringify(bootstrap(varied, { seed: 1 }));
    const b = JSON.stringify(bootstrap(varied, { seed: 999 }));

    expect(a).not.toBe(b);
  });
});
