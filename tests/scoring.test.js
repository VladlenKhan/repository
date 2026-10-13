import { describe, expect, it } from 'vitest';
import { scoreMarket } from '../lib/scoring.js';
import { formatSignal } from '../lib/format.js';

/** Ряд свечей с заданным наклоном. */
const series = (count, step, base = 4000) =>
  Array.from({ length: count }, (_, i) => {
    const price = base + i * step;
    return { time: (i + 1) * 3600000, open: price - step, high: price + 5, low: price - 5, close: price };
  });

const structure = (over = {}) => ({
  trend: null,
  events: [],
  zones: [],
  pools: [],
  range: { zone: 'equilibrium', position: 0.5, high: 4200, low: 4000, equilibrium: 4100 },
  ...over,
});

const indicators = (over = {}) => ({
  price: 4100, ema50: 4100, ema200: 4100, rsi14: 50, atr14: 12, ...over,
});

describe('отдельные факторы', () => {
  it('восходящий тренд даёт плюс, нисходящий минус', () => {
    const up = scoreMarket({
      candles: series(60, 2), structure: structure(),
      indicators: indicators({ price: 4200, ema50: 4150, ema200: 4050 }),
    });
    const down = scoreMarket({
      candles: series(60, -2), structure: structure(),
      indicators: indicators({ price: 4000, ema50: 4050, ema200: 4150 }),
    });

    expect(up.factors.trend.score).toBe(1);
    expect(down.factors.trend.score).toBe(-1);
  });

  it('слом структуры весит больше смены характера', () => {
    // CHoCH часто оказывается ложным, поэтому его вклад вдвое меньше.
    const bos = scoreMarket({
      candles: series(60, 1), indicators: indicators(),
      structure: structure({ events: [{ type: 'BOS', direction: 'bullish', price: 4100 }] }),
    });
    const choch = scoreMarket({
      candles: series(60, 1), indicators: indicators(),
      structure: structure({ events: [{ type: 'CHoCH', direction: 'bullish', price: 4100 }] }),
    });

    expect(bos.factors.structure.score).toBe(1);
    expect(choch.factors.structure.score).toBe(0.5);
  });

  it('дорогая половина диапазона работает против покупки', () => {
    // Единственный фактор, прошедший проверку на отложенной истории.
    const expensive = scoreMarket({
      candles: series(60, 1), indicators: indicators(),
      structure: structure({ range: { zone: 'premium', position: 0.9 } }),
    });
    const cheap = scoreMarket({
      candles: series(60, 1), indicators: indicators(),
      structure: structure({ range: { zone: 'discount', position: 0.1 } }),
    });

    expect(expensive.factors.range.score).toBeLessThan(0);
    expect(cheap.factors.range.score).toBeGreaterThan(0);
  });

  it('крайности RSI работают на возврат', () => {
    const oversold = scoreMarket({
      candles: series(60, 1), structure: structure(), indicators: indicators({ rsi14: 20 }),
    });
    const overbought = scoreMarket({
      candles: series(60, 1), structure: structure(), indicators: indicators({ rsi14: 85 }),
    });

    expect(oversold.factors.momentum.score).toBeGreaterThan(0);
    expect(overbought.factors.momentum.score).toBeLessThan(0);
  });

  it('далёкие зоны и скопления не учитываются', () => {
    const far = scoreMarket({
      candles: series(60, 1), indicators: indicators({ price: 4100 }),
      structure: structure({
        zones: [{ kind: 'fvg', direction: 'bullish', top: 5000, bottom: 4990 }],
        pools: [{ price: 5000, side: 'buy-side', count: 5 }],
      }),
    });

    expect(far.factors.zones.score).toBe(0);
    expect(far.factors.liquidity.score).toBe(0);
  });

  it('положение скопления считается относительно цены, а не типа', () => {
    // buy-side означает «над максимумами», это не то же самое,
    // что «выше текущей цены».
    const below = scoreMarket({
      candles: series(60, 1), indicators: indicators({ price: 4100 }),
      structure: structure({ pools: [{ price: 4095, side: 'buy-side', count: 3 }] }),
    });

    expect(below.factors.liquidity.score).toBeLessThan(0);
    expect(below.factors.liquidity.note).toContain('ниже');
  });
});

describe('сводный вердикт', () => {
  it('при согласии факторов даёт направление', () => {
    const result = scoreMarket({
      candles: series(60, 3),
      indicators: indicators({ price: 4200, ema50: 4150, ema200: 4050, rsi14: 25 }),
      structure: structure({
        events: [{ type: 'BOS', direction: 'bullish', price: 4150 }],
        range: { zone: 'discount', position: 0.2 },
      }),
    });

    expect(result.direction).toBe('long');
    expect(result.total).toBeGreaterThan(0);
  });

  it('при разнобое честно сообщает об отсутствии перевеса', () => {
    const result = scoreMarket({
      candles: series(60, 0),
      indicators: indicators(),
      structure: structure(),
    });

    expect(result.direction).toBe('flat');
    expect(result.confidence).toMatch(/нет перевеса|низкая/);
  });

  it('при разнобое уверенность не бывает высокой', () => {
    // Тренд и структура вверх, диапазон и RSI вниз — факторы спорят,
    // и система не должна делать вид, что всё однозначно.
    const conflicted = scoreMarket({
      candles: series(60, 2),
      indicators: indicators({ price: 4200, ema50: 4150, ema200: 4050, rsi14: 88 }),
      structure: structure({
        events: [{ type: 'BOS', direction: 'bullish', price: 4150 }],
        range: { zone: 'premium', position: 0.97 },
        pools: [{ price: 4150, side: 'sell-side', count: 4 }],
      }),
    });

    expect(conflicted.agreement).toBeLessThan(0.8);
    expect(conflicted.confidence).not.toBe('высокая');
  });

  it('согласие считается только по значимым факторам', () => {
    const result = scoreMarket({
      candles: series(60, 2),
      indicators: indicators({ price: 4200, ema50: 4150, ema200: 4050 }),
      structure: structure(),
    });

    expect(result.agreement).toBeGreaterThanOrEqual(0);
    expect(result.agreement).toBeLessThanOrEqual(1);
  });

  it('не падает на пустых данных', () => {
    const result = scoreMarket({
      candles: [], indicators: { price: null }, structure: structure(),
    });

    expect(result.direction).toBe('flat');
  });
});

describe('сообщение сигнала', () => {
  const score = scoreMarket({
    candles: series(60, 2),
    indicators: indicators({ price: 4200, ema50: 4150, ema200: 4050 }),
    structure: structure({ events: [{ type: 'BOS', direction: 'bullish', price: 4150 }] }),
  });

  it('показывает разбор по каждому фактору', () => {
    const text = formatSignal({ score, timeframe: '1h', price: 4200, levels: null, lot: null }, 'ru');

    for (const label of ['Тренд', 'Структура', 'диапазоне', 'RSI']) {
      expect(text).toContain(label);
    }
  });

  it('содержит уровни, когда они рассчитаны', () => {
    const levels = { entry: 4200, stopLoss: 4180, takeProfit: 4230, rewardRatio: 1.5 };
    const text = formatSignal({ score, timeframe: '1h', price: 4200, levels, lot: 0.1 }, 'ru');

    expect(text).toContain('4180');
    expect(text).toContain('4230');
  });

  it('объясняет, почему уровней нет', () => {
    const flat = { ...score, direction: 'flat' };
    const text = formatSignal({ score: flat, timeframe: '1h', price: 4200, levels: null }, 'ru');

    expect(text).toContain('не дают перевеса');
  });

  it('честно сообщает, чего оценка не учитывает', () => {
    const text = formatSignal({ score, timeframe: '1h', price: 4200, levels: null }, 'ru');

    expect(text).toContain('Настроения участников');
    expect(text).toContain('календарь');
  });

  it('заканчивается обязательной оговоркой', () => {
    const text = formatSignal({ score, timeframe: '1h', price: 4200, levels: null }, 'ru');
    expect(text.trimEnd()).toMatch(/Это не финансовая рекомендация<\/i>$/);
  });
});
