import { describe, expect, it } from 'vitest';
import {
  calculatePivotPoints,
  findNearestLevels,
  previousClosedCandle,
} from '../lib/levels.js';

describe('calculatePivotPoints', () => {
  // Эталон считается вручную: H=110, L=90, C=100
  // PP = (110+90+100)/3 = 100, range = 20
  const candle = { high: 110, low: 90, close: 100 };

  it('считает центральный пивот как среднее H, L и C', () => {
    expect(calculatePivotPoints(candle).pp).toBe(100);
  });

  it('считает первые уровни сопротивления и поддержки', () => {
    const p = calculatePivotPoints(candle);
    expect(p.r1).toBe(110); // 2*100 - 90
    expect(p.s1).toBe(90);  // 2*100 - 110
  });

  it('считает вторые уровни через размах свечи', () => {
    const p = calculatePivotPoints(candle);
    expect(p.r2).toBe(120); // 100 + 20
    expect(p.s2).toBe(80);  // 100 - 20
  });

  it('считает третьи уровни', () => {
    const p = calculatePivotPoints(candle);
    expect(p.r3).toBe(130); // 110 + 2*(100-90)
    expect(p.s3).toBe(70);  // 90 - 2*(110-100)
  });

  it('сохраняет порядок уровней снизу вверх', () => {
    const p = calculatePivotPoints(candle);
    expect([p.s3, p.s2, p.s1, p.pp, p.r1, p.r2, p.r3]).toEqual(
      [p.s3, p.s2, p.s1, p.pp, p.r1, p.r2, p.r3].slice().sort((a, b) => a - b),
    );
  });

  it('округляет до двух знаков', () => {
    const p = calculatePivotPoints({ high: 2650.333, low: 2600.111, close: 2630.777 });
    expect(p.pp).toBe(2627.07);
  });

  it('работает на реальных числах по золоту', () => {
    // PP = (2685.4 + 2648.1 + 2671.9) / 3 = 2668.46666...
    // Производные уровни считаются от НЕокруглённого PP:
    // R1 = 2 * 2668.46666... - 2648.1 = 2688.83333... -> 2688.83
    // Если округлить PP заранее, получится 2688.84 — на цент мимо.
    const p = calculatePivotPoints({ high: 2685.4, low: 2648.1, close: 2671.9 });
    expect(p.pp).toBe(2668.47);
    expect(p.r1).toBe(2688.83);
    expect(p.s1).toBe(2651.53);
  });

  it('отвергает нечисловые значения', () => {
    expect(() => calculatePivotPoints({ high: 1, low: 2, close: null })).toThrow(TypeError);
  });

  it('отвергает свечу, где high ниже low', () => {
    expect(() => calculatePivotPoints({ high: 90, low: 110, close: 100 })).toThrow(RangeError);
  });
});

describe('findNearestLevels', () => {
  const pivots = calculatePivotPoints({ high: 110, low: 90, close: 100 });

  it('находит уровни непосредственно вокруг цены', () => {
    const { support, resistance } = findNearestLevels(pivots, 105);
    expect(support.value).toBe(100); // PP
    expect(resistance.value).toBe(110); // R1
  });

  it('возвращает null, если цена выше всех уровней', () => {
    expect(findNearestLevels(pivots, 999).resistance).toBeNull();
  });

  it('возвращает null, если цена ниже всех уровней', () => {
    expect(findNearestLevels(pivots, 1).support).toBeNull();
  });

  it('называет уровень по имени', () => {
    expect(findNearestLevels(pivots, 105).resistance.name).toBe('R1');
  });
});

describe('previousClosedCandle', () => {
  it('берёт предпоследнюю свечу, так как последняя ещё формируется', () => {
    const candles = [{ close: 1 }, { close: 2 }, { close: 3 }];
    expect(previousClosedCandle(candles).close).toBe(2);
  });

  it('возвращает null, если свечей меньше двух', () => {
    expect(previousClosedCandle([{ close: 1 }])).toBeNull();
    expect(previousClosedCandle([])).toBeNull();
  });
});
