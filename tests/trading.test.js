import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SIZE,
  DEFAULT_SETTINGS,
  calculateLevels,
  calculateLot,
  checkExit,
  closePosition,
  floatingPnl,
  normalizeSettings,
  managePosition,
  nightsHeld,
  openPosition,
  summarize,
} from '../lib/trading.js';

const settings = { ...DEFAULT_SETTINGS, deposit: 10000, riskPercent: 1, rewardRatio: 2 };

const signal = {
  strategy: 'fvgRetest',
  direction: 'bullish',
  entry: 4100,
  zone: { top: 4105, bottom: 4090 },
  reason: 'тест',
};

describe('normalizeSettings', () => {
  it('подставляет умолчания вместо мусора', () => {
    const result = normalizeSettings({ deposit: 'abc', lot: null });
    expect(result.deposit).toBe(10000);
    expect(result.lot).toBe(0.1);
  });

  it('пустое поле формы не превращается в минимум', () => {
    // Number(null) и Number('') дают ноль, а не NaN: без явной проверки
    // пустое поле зажималось бы в минимально допустимое значение.
    for (const empty of [null, undefined, '']) {
      expect(normalizeSettings({ lot: empty }).lot).toBe(0.1);
      expect(normalizeSettings({ deposit: empty }).deposit).toBe(10000);
      expect(normalizeSettings({ rewardRatio: empty }).rewardRatio).toBe(2);
    }
  });

  it('загоняет значения в допустимые границы', () => {
    expect(normalizeSettings({ lot: 9999 }).lot).toBe(100);
    expect(normalizeSettings({ lot: 0 }).lot).toBe(0.01);
    expect(normalizeSettings({ riskPercent: -5 }).riskPercent).toBe(0.1);
  });

  it('торговля выключена, пока явно не включена', () => {
    expect(normalizeSettings({}).enabled).toBe(false);
    expect(normalizeSettings({ enabled: 'да' }).enabled).toBe(false);
    expect(normalizeSettings({ enabled: true }).enabled).toBe(true);
  });

  it('сохраняет выбор стратегий поверх умолчаний', () => {
    const result = normalizeSettings({ strategies: { fvgRetest: false } });
    expect(result.strategies.fvgRetest).toBe(false);
    expect(result.strategies.obRetest).toBe(true);
  });
});

describe('calculateLevels', () => {
  it('ставит стоп за границу зоны', () => {
    const levels = calculateLevels(signal, settings, 10);
    // Нижняя граница 4090 минус отступ 10% от высоты зоны (15 * 0.1).
    expect(levels.stopLoss).toBe(4088.5);
  });

  it('цель дальше стопа во столько раз, сколько задано', () => {
    const levels = calculateLevels(signal, settings, 10);
    const risk = signal.entry - levels.stopLoss;
    const reward = levels.takeProfit - signal.entry;

    expect(reward / risk).toBeCloseTo(2, 5);
  });

  it('для продажи всё зеркально', () => {
    const sell = { ...signal, direction: 'bearish', entry: 4100 };
    const levels = calculateLevels(sell, settings, 10);

    expect(levels.stopLoss).toBeGreaterThan(4100);
    expect(levels.takeProfit).toBeLessThan(4100);
  });

  it('режим ATR ставит стоп от волатильности', () => {
    const levels = calculateLevels(signal, { ...settings, stopMode: 'atr', stopAtrMultiple: 1.5 }, 20);
    expect(levels.stopLoss).toBe(4070); // 4100 - 20 * 1.5
  });

  it('без ATR в режиме ATR сигнал отклоняется', () => {
    expect(calculateLevels(signal, { ...settings, stopMode: 'atr' }, null)).toBeNull();
  });

  it('нулевой риск отклоняется', () => {
    // Иначе размер позиции получился бы бесконечным.
    const degenerate = { ...signal, entry: 4090, zone: { top: 4090, bottom: 4090 } };
    expect(calculateLevels(degenerate, settings, 10)).toBeNull();
  });
});

describe('calculateLot', () => {
  it('считает лот от заданного риска', () => {
    // Риск 1% от 10 000 = 100 долларов. Стоп 10 долларов цены.
    // 100 / (10 * 100 унций) = 0.1 лота.
    expect(calculateLot(settings, 10)).toBe(0.1);
  });

  it('широкий стоп даёт меньший лот', () => {
    // В этом и смысл управления риском: потеря одинаковая.
    expect(calculateLot(settings, 40)).toBeLessThan(calculateLot(settings, 10));
  });

  it('не опускается ниже минимального шага', () => {
    expect(calculateLot(settings, 100000)).toBe(0.01);
  });
});

describe('openPosition', () => {
  it('собирает позицию из сигнала', () => {
    const position = openPosition(signal, settings, 10);

    expect(position.direction).toBe('bullish');
    expect(position.status).toBe('open');
    expect(position.entry).toBe(4100);
    expect(position.strategy).toBe('fvgRetest');
  });

  it('выдаёт разные идентификаторы', () => {
    expect(openPosition(signal, settings, 10).id).not.toBe(openPosition(signal, settings, 10).id);
  });
});

describe('checkExit', () => {
  const position = openPosition(signal, settings, 10);

  it('свеча внутри диапазона не закрывает позицию', () => {
    expect(checkExit(position, { high: 4105, low: 4095 })).toBeNull();
  });

  it('достижение цели закрывает в плюс', () => {
    expect(checkExit(position, { high: 99999, low: 4099 }).outcome).toBe('tp');
  });

  it('достижение стопа закрывает в минус', () => {
    expect(checkExit(position, { high: 4101, low: 0 }).outcome).toBe('sl');
  });

  it('при касании и стопа, и цели выбирается стоп', () => {
    // Внутри свечи порядок неизвестен. Считаем худший случай, иначе
    // статистика окажется приукрашенной.
    expect(checkExit(position, { high: 99999, low: 0 }).outcome).toBe('sl');
  });
});

describe('closePosition', () => {
  it('считает прибыль по размеру контракта', () => {
    const position = { ...openPosition(signal, settings, 10), lot: 0.1 };
    const closed = closePosition(position, 'tp', 4110);

    expect(closed.pnlPoints).toBe(10);
    // 10 долларов движения × 0.1 лота × 100 унций = 100 долларов.
    expect(closed.pnlMoney).toBe(10 * 0.1 * CONTRACT_SIZE);
  });

  it('для продажи знак переворачивается', () => {
    const sell = { ...openPosition({ ...signal, direction: 'bearish' }, settings, 10), lot: 0.1 };
    const closed = closePosition(sell, 'tp', 4090);

    expect(closed.pnlPoints).toBe(10);
    expect(closed.pnlMoney).toBeGreaterThan(0);
  });

  it('убыток считается отрицательным', () => {
    const position = { ...openPosition(signal, settings, 10), lot: 0.1 };
    expect(closePosition(position, 'sl', 4090).pnlMoney).toBeLessThan(0);
  });
});

describe('floatingPnl', () => {
  it('показывает текущий результат открытой позиции', () => {
    const position = { ...openPosition(signal, settings, 10), lot: 0.5 };
    expect(floatingPnl(position, 4105).pnlMoney).toBe(5 * 0.5 * CONTRACT_SIZE);
  });
});

describe('summarize', () => {
  const make = (strategy, pnl) => ({
    strategy, status: 'closed', pnlMoney: pnl, pnlPoints: pnl / 10,
  });

  const positions = [
    make('fvgRetest', 200),
    make('fvgRetest', -100),
    make('fvgRetest', 150),
    make('obRetest', -80),
    { strategy: 'obRetest', status: 'open' },
  ];

  it('считает долю прибыльных сделок', () => {
    const stats = summarize(positions, settings);
    expect(stats.total).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBe(50);
  });

  it('открытые позиции в статистику результата не входят', () => {
    expect(summarize(positions, settings).open).toBe(1);
  });

  it('считает итог в деньгах и процентах от депозита', () => {
    const stats = summarize(positions, settings);
    expect(stats.pnlMoney).toBe(170);
    expect(stats.pnlPercent).toBe(1.7);
  });

  it('профит-фактор больше единицы означает плюс', () => {
    const stats = summarize(positions, settings);
    // Заработано 350, потеряно 180.
    expect(stats.profitFactor).toBeCloseTo(1.94, 1);
  });

  it('считает худшую просадку', () => {
    const stats = summarize(positions, settings);
    expect(stats.maxDrawdown).toBeLessThan(0);
  });

  it('разбивает результат по стратегиям', () => {
    const stats = summarize(positions, settings);

    expect(stats.byStrategy.fvgRetest.total).toBe(3);
    expect(stats.byStrategy.fvgRetest.pnlMoney).toBe(250);
    expect(stats.byStrategy.obRetest.winRate).toBe(0);
  });

  it('не падает на пустом журнале', () => {
    const stats = summarize([], settings);
    expect(stats.total).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.profitFactor).toBeNull();
  });
});

describe('учёт спреда', () => {
  const position = { ...openPosition(signal, settings, 10), lot: 0.1 };

  it('спред уменьшает прибыль', () => {
    const withoutSpread = closePosition(position, 'tp', 4110, Date.now(), 0);
    const withSpread = closePosition(position, 'tp', 4110, Date.now(), 0.3);

    expect(withSpread.pnlMoney).toBeLessThan(withoutSpread.pnlMoney);
    expect(withSpread.pnlPoints).toBe(9.7);
  });

  it('спред увеличивает убыток', () => {
    const withSpread = closePosition(position, 'sl', 4090, Date.now(), 0.3);
    expect(withSpread.pnlPoints).toBe(-10.3);
  });

  it('сохраняет результат до вычета для сравнения', () => {
    const closed = closePosition(position, 'tp', 4110, Date.now(), 0.3);
    expect(closed.grossPoints).toBe(10);
    expect(closed.spreadCost).toBe(0.3 * 0.1 * CONTRACT_SIZE);
  });

  it('частая торговля страдает от спреда сильнее', () => {
    // Десять мелких сделок теряют на спреде больше, чем одна крупная
    // с тем же суммарным движением.
    const small = Array.from({ length: 10 }, () =>
      closePosition(position, 'tp', 4101, Date.now(), 0.3).pnlMoney,
    ).reduce((a, b) => a + b, 0);
    const big = closePosition(position, 'tp', 4110, Date.now(), 0.3).pnlMoney;

    expect(small).toBeLessThan(big);
  });
});

describe('managePosition', () => {
  const base = { ...openPosition(signal, settings, 10), lot: 0.2, riskPoints: 10, entry: 4100 };

  it('переносит стоп в безубыток после прохождения заданного R', () => {
    const { position } = managePosition(base, { high: 4111, low: 4100 }, 10, { breakevenAt: 1 });
    expect(position.stopLoss).toBe(4100);
  });

  it('не переносит стоп раньше времени', () => {
    const { position } = managePosition(base, { high: 4105, low: 4100 }, 10, { breakevenAt: 1 });
    expect(position.stopLoss).toBe(base.stopLoss);
  });

  it('стоп никогда не отходит назад', () => {
    // Безубыток уже стоит — новая свеча не должна его ухудшить.
    const moved = { ...base, stopLoss: 4100 };
    const { position } = managePosition(moved, { high: 4102, low: 4099 }, 10, { trailAtr: 5 });
    expect(position.stopLoss).toBeGreaterThanOrEqual(4100);
  });

  it('фиксирует половину объёма на заданном R', () => {
    const { position, partial } = managePosition(base, { high: 4111, low: 4100 }, 10, { partialAt: 1 });

    expect(partial).not.toBeNull();
    expect(partial.lot).toBe(0.1);
    expect(partial.outcome).toBe('partial');
    expect(partial.pnlMoney).toBeGreaterThan(0);
    // Остаток продолжает жить с уменьшенным объёмом.
    expect(position.lot).toBe(0.1);
  });

  it('фиксирует частично только один раз', () => {
    const first = managePosition(base, { high: 4111, low: 4100 }, 10, { partialAt: 1 });
    const second = managePosition(first.position, { high: 4120, low: 4100 }, 10, { partialAt: 1 });

    expect(second.partial).toBeNull();
  });

  it('тянет стоп за ценой', () => {
    const { position } = managePosition(base, { high: 4140, low: 4100 }, 10, { trailAtr: 2 });
    expect(position.stopLoss).toBe(4120); // 4140 - 10 * 2
  });

  it('для продажи всё зеркально', () => {
    const sell = { ...openPosition({ ...signal, direction: 'bearish' }, settings, 10), riskPoints: 10, entry: 4100, lot: 0.2 };
    const { position, partial } = managePosition(sell, { high: 4100, low: 4089 }, 10, { partialAt: 1, breakevenAt: 1 });

    expect(partial.pnlMoney).toBeGreaterThan(0);
    expect(position.stopLoss).toBe(4100);
  });

  it('без настроек ничего не меняет', () => {
    const { position, partial } = managePosition(base, { high: 4200, low: 4000 }, 10, {});
    expect(partial).toBeNull();
    expect(position).toBe(base);
  });

  it('проверенные значения стоят по умолчанию', () => {
    // Частичная фиксация — единственное, что вывело нижнюю границу
    // доверительного интервала выше нуля.
    const s = normalizeSettings({});
    expect(s.exits.partialAt).toBe(1);
    expect(s.exits.breakevenAt).toBe(1);
    expect(s.exits.trailAtr).toBe(0);
  });
});

describe('свопы и проскальзывание', () => {
  const position = {
    ...openPosition(signal, settings, 10),
    lot: 1,
    entry: 4100,
    openedAt: '2026-10-05T10:00:00Z', // понедельник
  };

  it('ночь считается по пересечению полуночи, а не по часам', () => {
    // Девять часов внутри суток — ни одной ночи.
    expect(nightsHeld('2026-10-05T01:00:00Z', '2026-10-05T23:00:00Z')).toBe(0);
    expect(nightsHeld('2026-10-05T23:00:00Z', '2026-10-06T01:00:00Z')).toBe(1);
  });

  it('ночь со среды на четверг считается за три', () => {
    // Так площадки компенсируют выходные.
    expect(nightsHeld('2026-10-07T10:00:00Z', '2026-10-08T10:00:00Z')).toBe(3);
  });

  it('обычная ночь считается за одну', () => {
    expect(nightsHeld('2026-10-05T10:00:00Z', '2026-10-06T10:00:00Z')).toBe(1);
  });

  it('своп уменьшает результат длинного удержания', () => {
    const quick = closePosition(position, 'tp', 4110, Date.parse('2026-10-05T18:00:00Z'),
      { swapPerNight: -1.5 });
    const slow = closePosition(position, 'tp', 4110, Date.parse('2026-10-12T18:00:00Z'),
      { swapPerNight: -1.5 });

    expect(slow.pnlMoney).toBeLessThan(quick.pnlMoney);
    expect(slow.nights).toBeGreaterThan(quick.nights);
  });

  it('проскальзывание ухудшает выход по стопу', () => {
    const clean = closePosition(position, 'sl', 4090, Date.parse('2026-10-05T18:00:00Z'), {});
    const real = closePosition(position, 'sl', 4090, Date.parse('2026-10-05T18:00:00Z'),
      { stopSlippage: 0.5 });

    expect(real.pnlMoney).toBeLessThan(clean.pnlMoney);
    expect(real.closePrice).toBe(4089.5);
  });

  it('по цели проскальзывания нет — это лимитная заявка', () => {
    const closed = closePosition(position, 'tp', 4110, Date.parse('2026-10-05T18:00:00Z'),
      { stopSlippage: 0.5 });

    expect(closed.closePrice).toBe(4110);
    expect(closed.slippageCost).toBe(0);
  });

  it('старый вызов с одним спредом продолжает работать', () => {
    const closed = closePosition(position, 'tp', 4110, Date.parse('2026-10-05T18:00:00Z'), 0.3);
    expect(closed.pnlPoints).toBe(9.7);
  });

  it('издержки показаны по отдельности', () => {
    const closed = closePosition(position, 'sl', 4090, Date.parse('2026-10-08T18:00:00Z'),
      { spread: 0.3, swapPerNight: -1.5, stopSlippage: 0.2 });

    expect(closed.spreadCost).toBeGreaterThan(0);
    expect(closed.slippageCost).toBeGreaterThan(0);
    expect(closed.swapCost).toBeLessThan(0);
  });
});

describe('издержки частичного закрытия', () => {
  const base = { ...openPosition(signal, settings, 10), lot: 0.2, riskPoints: 10, entry: 4100 };

  it('частичное закрытие платит спред', () => {
    // Это такая же рыночная операция, как любая другая. Без списания
    // стратегии с частичной фиксацией выглядят выгоднее, чем есть:
    // сделка закрывается дважды, а издержки считались бы один раз.
    const free = managePosition(base, { high: 4111, low: 4100 }, 10, { partialAt: 1 }, {});
    const paid = managePosition(base, { high: 4111, low: 4100 }, 10, { partialAt: 1 }, { spread: 0.3 });

    expect(paid.partial.pnlMoney).toBeLessThan(free.partial.pnlMoney);
    expect(paid.partial.spreadCost).toBeGreaterThan(0);
  });

  it('спред списывается с фактического объёма половины', () => {
    const { partial } = managePosition(base, { high: 4111, low: 4100 }, 10, { partialAt: 1 }, { spread: 0.3 });
    expect(partial.spreadCost).toBe(0.3 * 0.1 * CONTRACT_SIZE);
  });
});
