import { describe, expect, it, vi } from 'vitest';
import { runTradingStep } from '../lib/paper-trading.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/trading.js';

const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, maxOpenPositions: 2 });

/** Свечи без всякой структуры — сигналов на них быть не должно. */
const quiet = Array.from({ length: 60 }, (_, i) => ({
  time: (i + 1) * 3600000,
  open: 100, high: 101, low: 99, close: 100,
}));

const position = (overrides = {}) => ({
  id: 'p1',
  strategy: 'fvgRetest',
  direction: 'bullish',
  entry: 100,
  stopLoss: 95,
  takeProfit: 110,
  lot: 0.1,
  status: 'open',
  openedAt: new Date().toISOString(),
  ...overrides,
});

describe('runTradingStep', () => {
  it('закрывает позицию по достижении цели', async () => {
    const candles = [...quiet, { time: 99e6, open: 100, high: 115, low: 100, close: 112 }];
    const result = await runTradingStep(candles, [position()], settings);

    expect(result.closed).toHaveLength(1);
    expect(result.closed[0].outcome).toBe('tp');
    expect(result.closed[0].pnlMoney).toBeGreaterThan(0);
  });

  it('закрывает позицию по стопу', async () => {
    const candles = [...quiet, { time: 99e6, open: 100, high: 101, low: 90, close: 93 }];
    const result = await runTradingStep(candles, [position()], settings);

    expect(result.closed[0].outcome).toBe('sl');
    expect(result.closed[0].pnlMoney).toBeLessThan(0);
  });

  it('уже закрытые позиции не трогает', async () => {
    const closedBefore = position({ status: 'closed', pnlMoney: 50 });
    const candles = [...quiet, { time: 99e6, open: 100, high: 115, low: 90, close: 112 }];

    expect((await runTradingStep(candles, [closedBefore], settings)).closed).toHaveLength(0);
  });

  it('при выключенной торговле новых позиций не открывает', async () => {
    const off = normalizeSettings({ ...settings, enabled: false });
    const result = await runTradingStep(quiet, [], off);

    expect(result.opened).toHaveLength(0);
  });

  it('не превышает лимит открытых позиций', async () => {
    const full = [position({ id: 'a' }), position({ id: 'b', strategy: 'obRetest' })];
    const result = await runTradingStep(quiet, full, settings);

    expect(result.positions.filter((p) => p.status === 'open').length).toBeLessThanOrEqual(2);
  });

  it('сначала закрывает, потом открывает', async () => {
    // Иначе лимит считался бы по позициям, которые вот-вот закроются.
    const candles = [...quiet, { time: 99e6, open: 100, high: 115, low: 100, close: 112 }];
    const result = await runTradingStep(candles, [position()], settings);

    const stillOpen = result.positions.filter((p) => p.status === 'open');
    expect(stillOpen).toHaveLength(0);
  });

  it('на спокойном рынке сигналов нет', async () => {
    expect((await runTradingStep(quiet, [], settings)).opened).toHaveLength(0);
  });

  it('не падает на пустых свечах', async () => {
    const result = await runTradingStep([], [], settings);
    expect(result.closed).toEqual([]);
    expect(result.opened).toEqual([]);
  });

  it('не открывает вторую позицию по той же стратегии', async () => {
    // Иначе серия сигналов одной идеи забила бы весь журнал.
    const existing = [position({ strategy: 'sweepReversal' })];
    const result = await runTradingStep(quiet, existing, settings);

    const bySweep = result.positions.filter(
      (p) => p.status === 'open' && p.strategy === 'sweepReversal',
    );
    expect(bySweep).toHaveLength(1);
  });
});

describe('фильтры входа', () => {
  /** Диапазон 100–200: цена 190 — дорого, 110 — дёшево. */
  function rangeCandles(lastClose) {
    const candles = Array.from({ length: 80 }, (_, i) => ({
      time: (i + 1) * 3600000,
      open: 100 + (i % 2) * 100, high: 200, low: 100, close: 150,
    }));
    candles.push({ time: 99e6, open: lastClose, high: lastClose + 1, low: lastClose - 1, close: lastClose });
    return candles;
  }

  it('настройки по умолчанию включают проверенные фильтры', () => {
    const s = normalizeSettings({});
    expect(s.filters.premiumDiscount).toBe(true);
    expect(s.filters.minStopAtr).toBe(0.8);
  });

  it('фильтры можно выключить', () => {
    const s = normalizeSettings({ filters: { premiumDiscount: false, minStopAtr: 0 } });
    expect(s.filters.premiumDiscount).toBe(false);
    expect(s.filters.minStopAtr).toBe(0);
  });

  it('мусор в пороге заменяется умолчанием', () => {
    expect(normalizeSettings({ filters: { minStopAtr: 'много' } }).filters.minStopAtr).toBe(0.8);
  });

  it('не открывает позиций в спокойном рынке независимо от фильтров', async () => {
    const quiet = Array.from({ length: 80 }, (_, i) => ({
      time: (i + 1) * 3600000, open: 100, high: 101, low: 99, close: 100,
    }));
    const on = normalizeSettings({ enabled: true });
    expect((await runTradingStep(quiet, [], on)).opened).toHaveLength(0);
  });
});

describe('теневая оценка моделью', () => {
  it('по умолчанию выключена', () => {
    expect(normalizeSettings({}).llmShadow).toBe(false);
  });

  it('включается явно', () => {
    expect(normalizeSettings({ llmShadow: true }).llmShadow).toBe(true);
    expect(normalizeSettings({ llmShadow: 'да' }).llmShadow).toBe(false);
  });
});
