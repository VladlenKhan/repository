import { describe, expect, it } from 'vitest';
import {
  analyzeStructure,
  detectStructure,
  findFairValueGaps,
  findLiquidityPools,
  findLiquiditySweeps,
  findOrderBlocks,
  findSwings,
  premiumDiscount,
} from '../lib/structure.js';

/**
 * Конструктор свечи. Время задаётся индексом в часах — так в тестах
 * видно порядок, а абсолютные значения роли не играют.
 */
let clock = 0;
const candle = (open, high, low, close) => ({
  time: (clock += 3600) * 1000,
  open, high, low, close,
});

/** Ровная свеча вокруг цены — «ничего не происходит». */
const flat = (price) => candle(price, price + 1, price - 1, price);

describe('findSwings', () => {
  it('находит максимум, возвышающийся над соседями', () => {
    const candles = [
      flat(100), flat(101), flat(102),
      candle(103, 120, 102, 110), // явный пик
      flat(104), flat(103), flat(102),
    ];

    const highs = findSwings(candles, 3).filter((s) => s.kind === 'high');

    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(120);
    expect(highs[0].index).toBe(3);
  });

  it('находит минимум', () => {
    const candles = [
      flat(110), flat(109), flat(108),
      candle(107, 108, 90, 100), // явная впадина
      flat(105), flat(106), flat(107),
    ];

    const lows = findSwings(candles, 3).filter((s) => s.kind === 'low');

    expect(lows).toHaveLength(1);
    expect(lows[0].price).toBe(90);
  });

  it('не считает экстремумом равные соседние уровни', () => {
    // Строгое неравенство: плато — не экстремум.
    const candles = Array.from({ length: 7 }, () => flat(100));
    expect(findSwings(candles, 3)).toHaveLength(0);
  });

  it('чем больше strength, тем меньше экстремумов', () => {
    const candles = Array.from({ length: 40 }, (_, i) =>
      candle(100, 100 + Math.sin(i / 2) * 10 + 5, 100 + Math.sin(i / 2) * 10 - 5, 100),
    );

    expect(findSwings(candles, 2).length).toBeGreaterThanOrEqual(findSwings(candles, 5).length);
  });

  it('не падает на слишком короткой серии', () => {
    expect(findSwings([flat(100)], 3)).toEqual([]);
    expect(findSwings([], 3)).toEqual([]);
    expect(findSwings(null, 3)).toEqual([]);
  });
});

describe('detectStructure', () => {
  /** Серия: пик, откат, пробой пика закрытием. */
  function bullishBreak() {
    return [
      flat(100), flat(101), flat(102),
      candle(103, 115, 102, 110), // максимум 115
      flat(104), flat(103), flat(102),
      candle(104, 120, 103, 118), // закрытие 118 выше 115 — слом
      flat(119),
    ];
  }

  it('видит слом структуры вверх', () => {
    const candles = bullishBreak();
    const events = detectStructure(candles, findSwings(candles, 3));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].direction).toBe('bullish');
    expect(events[0].price).toBe(115);
  });

  it('первый слом — это BOS, а не CHoCH', () => {
    const candles = bullishBreak();
    const events = detectStructure(candles, findSwings(candles, 3));
    expect(events[0].type).toBe('BOS');
  });

  it('слом против структуры помечается как CHoCH', () => {
    clock = 0;
    const candles = [
      // восходящая структура: пробиваем максимум
      flat(100), flat(101), flat(102),
      candle(103, 115, 102, 110),
      flat(104), flat(103), flat(102),
      candle(104, 120, 103, 118),
      // откат и формирование минимума
      flat(112), flat(110), flat(108),
      candle(107, 108, 95, 100),
      flat(102), flat(104), flat(106),
      // пробой минимума вниз — смена характера
      candle(100, 101, 90, 92),
      flat(91),
    ];

    const events = detectStructure(candles, findSwings(candles, 3));
    const bearish = events.filter((e) => e.direction === 'bearish');

    expect(bearish.length).toBeGreaterThan(0);
    expect(bearish[0].type).toBe('CHoCH');
  });

  it('пробой тенью без закрытия сломом НЕ считается', () => {
    // Это ключевое отличие: такой пробой — снятие ликвидности.
    clock = 0;
    const candles = [
      flat(100), flat(101), flat(102),
      candle(103, 115, 102, 110),
      flat(104), flat(103), flat(102),
      candle(104, 118, 103, 108), // тень выше 115, закрытие ниже
      flat(107),
    ];

    const events = detectStructure(candles, findSwings(candles, 3));
    expect(events).toHaveLength(0);
  });

  it('на пустом наборе экстремумов возвращает пусто', () => {
    expect(detectStructure([flat(100)], [])).toEqual([]);
  });

  it('не использует экстремум раньше, чем он подтверждён', () => {
    // Экстремум на свече i становится известен только через strength
    // свечей. Если использовать его сразу, детектор «знает будущее»
    // и находит сломы, которых в реальном времени не существовало.
    clock = 0;
    const candles = bullishBreak();
    const swings = findSwings(candles, 3);
    const events = detectStructure(candles, swings, { strength: 3 });

    for (const event of events) {
      expect(event.brokenSwing.index + 3).toBeLessThanOrEqual(event.index);
    }
  });

  it('один уровень срабатывает только один раз', () => {
    // Иначе каждая следующая свеча за уровнем давала бы новое событие.
    clock = 0;
    const candles = [
      flat(100), flat(101), flat(102),
      candle(103, 115, 102, 110),
      flat(104), flat(103), flat(102),
      candle(104, 120, 103, 118),
      flat(119), flat(121), flat(122), // держимся выше пробитого уровня
    ];

    const events = detectStructure(candles, findSwings(candles, 3), { strength: 3 });
    const atLevel115 = events.filter((e) => e.price === 115);

    expect(atLevel115).toHaveLength(1);
  });

  it('порядок событий читается как BOS вверх, CHoCH вниз, BOS вниз', () => {
    clock = 0;
    const candles = [
      flat(100), flat(101), flat(102), candle(103, 115, 102, 110),
      flat(104), flat(103), flat(102), candle(104, 120, 103, 118),
      flat(112), flat(110), flat(108), candle(107, 108, 95, 100),
      flat(102), flat(104), flat(106), candle(100, 101, 90, 92), flat(91),
    ];

    const events = detectStructure(candles, findSwings(candles, 3), { strength: 3 });

    expect(events.map((e) => `${e.type} ${e.direction}`)).toEqual([
      'BOS bullish',
      'CHoCH bearish',
      'BOS bearish',
    ]);
  });
});

describe('findFairValueGaps', () => {
  it('находит бычий разрыв', () => {
    clock = 0;
    const candles = [
      candle(100, 102, 99, 101),   // high 102
      candle(101, 112, 101, 111),  // импульс
      candle(111, 115, 106, 114),  // low 106 > 102 — разрыв 102..106
    ];

    const gaps = findFairValueGaps(candles);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].direction).toBe('bullish');
    expect(gaps[0].bottom).toBe(102);
    expect(gaps[0].top).toBe(106);
  });

  it('находит медвежий разрыв', () => {
    clock = 0;
    const candles = [
      candle(110, 112, 108, 109),  // low 108
      candle(109, 109, 100, 101),  // импульс вниз
      candle(101, 104, 99, 100),   // high 104 < 108 — разрыв 104..108
    ];

    const gaps = findFairValueGaps(candles);

    expect(gaps[0].direction).toBe('bearish');
    expect(gaps[0].bottom).toBe(104);
    expect(gaps[0].top).toBe(108);
  });

  it('отсеивает слишком мелкие разрывы', () => {
    clock = 0;
    const candles = [
      candle(100, 100.01, 99, 100),
      candle(100, 101, 100, 100.5),
      candle(100.5, 101, 100.02, 100.8), // разрыв 0.01 — шум
    ];

    expect(findFairValueGaps(candles)).toHaveLength(0);
  });

  it('помечает отработанным разрыв, в который цена вернулась', () => {
    clock = 0;
    const candles = [
      candle(100, 102, 99, 101),
      candle(101, 112, 101, 111),
      candle(111, 115, 106, 114),
      candle(114, 115, 103, 105), // вернулись в зону 102..106
    ];

    expect(findFairValueGaps(candles)[0].mitigated).toBe(true);
  });

  it('не помечает отработанным разрыв, который цена не трогала', () => {
    clock = 0;
    const candles = [
      candle(100, 102, 99, 101),
      candle(101, 112, 101, 111),
      candle(111, 115, 106, 114),
      candle(114, 120, 112, 118), // ушли вверх, не возвращаясь
    ];

    expect(findFairValueGaps(candles)[0].mitigated).toBe(false);
  });
});

describe('findOrderBlocks', () => {
  it('берёт последнюю медвежью свечу перед сломом вверх', () => {
    clock = 0;
    const candles = [
      flat(100), flat(101), flat(102),
      candle(103, 115, 102, 110),
      flat(104),
      candle(104, 105, 99, 100),   // медвежья — вот она
      candle(100, 112, 100, 111),  // импульс
      candle(111, 120, 110, 118),  // слом
      flat(119),
    ];

    const events = detectStructure(candles, findSwings(candles, 3));
    const blocks = findOrderBlocks(candles, events);

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].direction).toBe('bullish');
    // Зона — тело со тенями последней медвежьей свечи.
    expect(blocks[0].bottom).toBe(99);
    expect(blocks[0].top).toBe(105);
  });

  it('не уходит в поиске дальше заданной глубины', () => {
    clock = 0;
    const candles = [
      candle(110, 111, 100, 101), // медвежья, но очень далеко
      ...Array.from({ length: 30 }, () => candle(100, 101, 99, 100.5)),
      candle(100, 130, 100, 128),
    ];

    const events = detectStructure(candles, findSwings(candles, 3));
    const blocks = findOrderBlocks(candles, events, { lookback: 3 });

    expect(blocks.every((b) => b.index > 20)).toBe(true);
  });
});

describe('findLiquidityPools', () => {
  it('объединяет близкие максимумы в один пул', () => {
    const swings = [
      { index: 1, time: 1, price: 100.0, kind: 'high' },
      { index: 5, time: 2, price: 100.05, kind: 'high' },
      { index: 9, time: 3, price: 100.02, kind: 'high' },
    ];

    const pools = findLiquidityPools(swings);

    expect(pools).toHaveLength(1);
    expect(pools[0].count).toBe(3);
    expect(pools[0].side).toBe('buy-side');
  });

  it('далёкие уровни в один пул не сливает', () => {
    const swings = [
      { index: 1, time: 1, price: 100, kind: 'high' },
      { index: 5, time: 2, price: 150, kind: 'high' },
    ];

    expect(findLiquidityPools(swings)).toHaveLength(0);
  });

  it('минимумы дают ликвидность под рынком', () => {
    const swings = [
      { index: 1, time: 1, price: 90, kind: 'low' },
      { index: 5, time: 2, price: 90.03, kind: 'low' },
    ];

    expect(findLiquidityPools(swings)[0].side).toBe('sell-side');
  });
});

describe('findLiquiditySweeps', () => {
  it('ловит снятие максимума тенью с возвратом', () => {
    clock = 0;
    const candles = [flat(100), flat(100), candle(100, 120, 99, 101)];
    const swings = [{ index: 0, time: candles[0].time, price: 110, kind: 'high' }];

    const sweeps = findLiquiditySweeps(candles, swings, { strength: 0 });

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].direction).toBe('bearish');
  });

  it('не считает снятием закрытие за уровнем', () => {
    // Закрытие за уровнем — это слом структуры, а не снятие.
    clock = 0;
    const candles = [flat(100), flat(100), candle(100, 120, 99, 115)];
    const swings = [{ index: 0, time: candles[0].time, price: 110, kind: 'high' }];

    expect(findLiquiditySweeps(candles, swings, { strength: 0 })).toHaveLength(0);
  });

  it('ловит снятие минимума', () => {
    clock = 0;
    const candles = [flat(100), flat(100), candle(100, 101, 80, 95)];
    const swings = [{ index: 0, time: candles[0].time, price: 90, kind: 'low' }];

    expect(findLiquiditySweeps(candles, swings, { strength: 0 })[0].direction).toBe('bullish');
  });

  it('один уровень снимается только один раз', () => {
    // Иначе каждая следующая свеча за уровнем давала бы новое «снятие»,
    // и разметка превращалась бы в шум.
    clock = 0;
    const candles = [
      flat(100),
      candle(100, 120, 99, 101),
      candle(101, 121, 99, 102),
      candle(102, 122, 99, 103),
    ];
    const swings = [{ index: 0, time: candles[0].time, price: 110, kind: 'high' }];

    expect(findLiquiditySweeps(candles, swings, { strength: 0 })).toHaveLength(1);
  });

  it('не использует экстремум раньше подтверждения', () => {
    clock = 0;
    const candles = [flat(100), candle(100, 120, 99, 101), flat(100)];
    const swings = [{ index: 0, time: candles[0].time, price: 110, kind: 'high' }];

    // При strength=3 экстремум с индексом 0 подтвердится только к свече 3,
    // которой в этой серии нет.
    expect(findLiquiditySweeps(candles, swings, { strength: 3 })).toHaveLength(0);
  });

  it('измеряет глубину захода за уровень', () => {
    clock = 0;
    const candles = [flat(100), candle(100, 120, 99, 101)];
    const swings = [{ index: 0, time: candles[0].time, price: 110, kind: 'high' }];

    expect(findLiquiditySweeps(candles, swings, { strength: 0 })[0].depth).toBe(10);
  });
});

describe('premiumDiscount', () => {
  const candles = [
    candle(100, 100, 100, 100),
    candle(200, 200, 200, 200),
  ];

  it('верх диапазона — premium', () => {
    expect(premiumDiscount(candles, 190).zone).toBe('premium');
  });

  it('низ диапазона — discount', () => {
    expect(premiumDiscount(candles, 110).zone).toBe('discount');
  });

  it('середина — равновесие', () => {
    const result = premiumDiscount(candles, 150);
    expect(result.zone).toBe('equilibrium');
    expect(result.equilibrium).toBe(150);
  });

  it('считает положение долей от диапазона', () => {
    expect(premiumDiscount(candles, 175).position).toBe(0.75);
  });

  it('зона OTE лежит между 62% и 79% отката', () => {
    const { ote } = premiumDiscount(candles, 150);
    expect(ote.from).toBeCloseTo(121, 0);
    expect(ote.to).toBeCloseTo(138, 0);
  });

  it('не падает на пустых данных', () => {
    expect(premiumDiscount([], 100)).toBeNull();
  });
});

describe('analyzeStructure', () => {
  it('собирает всю разметку разом', () => {
    clock = 0;
    const candles = Array.from({ length: 120 }, (_, i) => {
      const base = 4000 + Math.sin(i / 7) * 60 + i * 0.6;
      return candle(base, base + 12, base - 11, base + 3);
    });

    const result = analyzeStructure(candles);

    for (const key of ['swings', 'events', 'fvg', 'orderBlocks', 'liquidityPools', 'sweeps']) {
      expect(Array.isArray(result[key]), key).toBe(true);
    }
    expect(result.range).not.toBeNull();
    expect(result.swings.length).toBeGreaterThan(0);
  });

  it('не падает на коротких данных', () => {
    const result = analyzeStructure([flat(100), flat(101)]);
    expect(result.swings).toEqual([]);
    expect(result.events).toEqual([]);
  });
});

describe('проверка на эталонных рынках', () => {
  /** Лестница вверх: импульс, откат выше предыдущего, снова импульс. */
  function staircase(legs = 12, up = true) {
    const candles = [];
    let price = 100;
    let t = 0;
    const sign = up ? 1 : -1;

    for (let leg = 0; leg < legs; leg++) {
      for (let i = 0; i < 8; i++) {
        price += 3 * sign;
        candles.push({ time: ++t * 3600000, open: price - 3 * sign, high: price + 1, low: price - 4, close: price });
      }
      for (let i = 0; i < 4; i++) {
        price -= 1.2 * sign;
        candles.push({ time: ++t * 3600000, open: price + 1.2 * sign, high: price + 2, low: price - 1, close: price });
      }
    }
    return candles;
  }

  it('в чистом тренде вверх нет ни одной смены характера', () => {
    // Это главная проверка корректности: если в безоткатном тренде
    // появляется CHoCH, детектор считает сменой характера обычный откат.
    const result = analyzeStructure(staircase(12, true));
    const bos = result.events.filter((e) => e.type === 'BOS');
    const choch = result.events.filter((e) => e.type === 'CHoCH');

    expect(bos.length).toBeGreaterThan(5);
    expect(choch).toHaveLength(0);
    expect(result.trend).toBe('bullish');
  });

  it('в чистом тренде вниз — то же самое зеркально', () => {
    const result = analyzeStructure(staircase(12, false));

    expect(result.events.filter((e) => e.type === 'CHoCH')).toHaveLength(0);
    expect(result.trend).toBe('bearish');
  });

  it('в боковике без обновления экстремумов событий нет', () => {
    const candles = Array.from({ length: 120 }, (_, i) => {
      const d = Math.sin(i / 3) * 6;
      return { time: (i + 1) * 3600000, open: 100 + d, high: 103 + d, low: 97 + d, close: 100 + d };
    });

    expect(analyzeStructure(candles).events).toHaveLength(0);
  });

  it('справляется с пятью тысячами свечей быстро', () => {
    // Разметка считается при каждом открытии графика, поэтому важно,
    // чтобы она не упиралась в лимит времени функции.
    const candles = Array.from({ length: 5000 }, (_, i) => {
      const base = 4000 + Math.sin(i / 37) * 80 + i * 0.05;
      return { time: (i + 1) * 3600000, open: base, high: base + 9, low: base - 8, close: base + 2 };
    });

    const started = Date.now();
    const result = analyzeStructure(candles);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.swings.length).toBeGreaterThan(0);
  });
});
