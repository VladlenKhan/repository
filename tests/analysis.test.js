import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAnalysis, formatNumber, formatSessions } from '../lib/format.js';
import { computeIndicators, describeRsi, detectTrend } from '../lib/indicators.js';
import { calculatePivotPoints, findNearestLevels } from '../lib/levels.js';
import { normalizeTimeframe } from '../lib/timeframes.js';

/** Синтетический набор свечей с заданным наклоном. */
function makeCandles(count, start, step) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return { time: i * 60000, open: close, high: close + 5, low: close - 5, close, volume: 1 };
  });
}

describe('normalizeTimeframe', () => {
  it('принимает канонические значения', () => {
    expect(normalizeTimeframe('1h')).toBe('1h');
    expect(normalizeTimeframe('1day')).toBe('1day');
  });

  it('понимает привычные трейдерам сокращения', () => {
    expect(normalizeTimeframe('H1')).toBe('1h');
    expect(normalizeTimeframe('m15')).toBe('15min');
    expect(normalizeTimeframe('D1')).toBe('1day');
    expect(normalizeTimeframe('4H')).toBe('4h');
  });

  it('возвращает таймфрейм по умолчанию для пустого ввода', () => {
    expect(normalizeTimeframe('')).toBe('1h');
    expect(normalizeTimeframe(undefined)).toBe('1h');
  });

  it('возвращает null для неизвестного значения', () => {
    expect(normalizeTimeframe('3h')).toBeNull();
    expect(normalizeTimeframe('чепуха')).toBeNull();
  });
});

describe('computeIndicators', () => {
  it('возвращает null там, где данных не хватило', () => {
    const result = computeIndicators(makeCandles(30, 2000, 1));
    expect(result.ema200).toBeNull();
    expect(result.ema50).toBeNull();
    expect(result.price).toBe(2029);
  });

  it('считает индикаторы на достаточной серии', () => {
    const result = computeIndicators(makeCandles(300, 2000, 2));
    expect(result.ema50).toBeGreaterThan(0);
    expect(result.ema200).toBeGreaterThan(0);
    expect(result.atr14).toBeCloseTo(10, 1); // размах свечи ровно 10
  });
});

describe('detectTrend', () => {
  it('видит восходящий тренд', () => {
    expect(detectTrend(computeIndicators(makeCandles(300, 2000, 2)))).toBe('up');
  });

  it('видит нисходящий тренд', () => {
    expect(detectTrend(computeIndicators(makeCandles(300, 3000, -2)))).toBe('down');
  });

  it('не выдумывает тренд на ровной линии', () => {
    expect(detectTrend(computeIndicators(makeCandles(300, 2500, 0)))).toBe('flat');
  });

  it('честно сообщает, что данных мало', () => {
    expect(detectTrend(computeIndicators(makeCandles(10, 2500, 1)))).toBe('unknown');
  });
});

describe('describeRsi', () => {
  it('различает зоны', () => {
    expect(describeRsi(75)).toBe('overbought');
    expect(describeRsi(25)).toBe('oversold');
    expect(describeRsi(50)).toBe('neutral');
    expect(describeRsi(null)).toBe('unknown');
  });
});

describe('formatNumber', () => {
  it('ставит прочерк вместо непосчитанного значения', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
  });

  it('округляет до двух знаков', () => {
    expect(formatNumber(2650.456)).toBe('2650.46');
  });
});

describe('formatSessions', () => {
  it('перечисляет пересекающиеся сессии', () => {
    expect(formatSessions(['london', 'newyork'], 'ru')).toBe('Лондон + Нью-Йорк');
  });

  it('сообщает о затишье, когда сессий нет', () => {
    expect(formatSessions([], 'ru')).toContain('затишье');
  });
});

describe('formatAnalysis', () => {
  const indicators = computeIndicators(makeCandles(300, 2400, 1));
  const pivots = calculatePivotPoints({ high: 2700, low: 2650, close: 2680 });

  const data = {
    timeframe: '1h',
    indicators,
    trend: detectTrend(indicators),
    rsiState: describeRsi(indicators.rsi14),
    levels: findNearestLevels(pivots, indicators.price),
    sessions: ['london'],
    marketOpen: true,
  };

  it('содержит все обязательные блоки', () => {
    const text = formatAnalysis(data, 'ru');
    expect(text).toContain('XAU/USD');
    expect(text).toContain('1h');
    expect(text).toContain('EMA 50 / 200');
    expect(text).toContain('RSI(14)');
    expect(text).toContain('ATR(14)');
    expect(text).toContain('Лондон');
  });

  it('заканчивается обязательной оговоркой', () => {
    expect(formatAnalysis(data, 'ru').trimEnd()).toMatch(/Это не финансовая рекомендация<\/i>$/);
    expect(formatAnalysis(data, 'en').trimEnd()).toMatch(/This is not financial advice<\/i>$/);
  });

  it('предупреждает о закрытом рынке', () => {
    const closed = formatAnalysis({ ...data, marketOpen: false }, 'ru');
    expect(closed).toContain('Рынок закрыт');
    expect(formatAnalysis(data, 'ru')).not.toContain('Рынок закрыт');
  });

  it('не ломается, когда индикаторы не посчитались', () => {
    const empty = computeIndicators(makeCandles(5, 2400, 1));
    const text = formatAnalysis(
      { ...data, indicators: empty, trend: 'unknown', rsiState: 'unknown', levels: null },
      'ru',
    );
    expect(text).toContain('—');
    expect(text).toContain('Уровни посчитать не удалось');
  });
});
