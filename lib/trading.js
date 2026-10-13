/**
 * Журнал бумажных сделок: расчёт уровней, учёт результата.
 *
 * Деньги ненастоящие, но арифметика честная — иначе статистика ничего
 * не скажет. Для XAU/USD стандартный контракт равен 100 унциям, то есть
 * движение цены на один доллар даёт сто долларов на полный лот.
 *
 * Все функции чистые: хранилище их не касается.
 */

/** Унций в одном лоте XAU/USD. */
export const CONTRACT_SIZE = 100;

/** Настройки по умолчанию. */
export const DEFAULT_SETTINGS = {
  enabled: false,
  deposit: 10000,
  lot: 0.1,
  riskPercent: 1,
  // Стоп: от структуры (за границу зоны) или от волатильности (ATR).
  stopMode: 'structure',
  stopAtrMultiple: 1.5,
  // Во сколько раз цель дальше стопа.
  rewardRatio: 2,
  maxOpenPositions: 3,
  // Спред в долларах цены. У золота он обычно 0.2–0.5 и съедается
  // на каждой сделке дважды — на входе и на выходе. Без его учёта
  // статистика systematically приукрашена.
  spread: 0.3,

  /**
   * Своп за перенос позиции через ночь, в долларах на лот.
   *
   * Отрицательное значение — списание. На золоте своп обычно
   * отрицательный в обе стороны, поэтому долгое удержание стоит денег
   * само по себе. Величина зависит от брокера; 1.5 — умеренная оценка.
   */
  swapPerNight: -1.5,

  /**
   * Проскальзывание на стопе, в долларах цены.
   *
   * Стоп исполняется по рынку, а не по выставленной цене: на гэпе и
   * быстром движении фактический выход хуже. Цель исполняется лимитом
   * и проскальзывания не имеет, поэтому учитываем только стоп.
   */
  stopSlippage: 0.2,

  /**
   * Теневая оценка сигналов моделью.
   *
   * Вердикт записывается рядом со сделкой, но на открытие не влияет.
   * Так накапливается сравнение «одобренные против отклонённых» —
   * единственный способ узнать, даёт ли слой что-то кроме слов.
   */
  llmShadow: false,

  timeframe: '1h',
  strategies: { fvgRetest: true, obRetest: true, sweepReversal: true },

  /**
   * Фильтры входа.
   *
   * Значения по умолчанию выбраны не на глаз: без них прогон по истории
   * золота даёт профит-фактор 0.93, с ними — около 1.3. Проверка на
   * отложенной части истории показала, что из всех опробованных
   * фильтров переносится именно эта пара; остальные оказались подгонкой
   * под конкретный отрезок.
   */
  /**
   * Управление открытой позицией.
   *
   * Все значения — в долях риска (R): единица равна расстоянию от входа
   * до первоначального стопа. Ноль означает «выключено».
   */
  exits: {
    /**
     * Значения проверены скользящей проверкой на золоте H1.
     *
     * Частичная фиксация — единственное изменение за всё исследование,
     * которое вывело нижнюю границу доверительного интервала выше нуля:
     * без неё −1136, с ней +256. Половина объёма снимается на 1R, и
     * сделки, которые раньше разворачивались в убыток, теперь
     * заканчиваются в небольшом плюсе.
     *
     * Трейлинг, наоборот, ухудшал результат на всех проверках — он
     * выбивает из хороших движений, — поэтому выключен.
     */
    breakevenAt: 1,
    partialAt: 1,
    trailAtr: 0,
  },

  filters: {
    // Покупать только в дешёвой половине диапазона, продавать в дорогой.
    premiumDiscount: true,
    // Не входить, если стоп уже этой доли ATR: такой выбивается шумом.
    minStopAtr: 0.8,
  },
};

/** Сливает сохранённые настройки с умолчаниями и чистит значения. */
export function normalizeSettings(saved = {}) {
  const clamp = (value, min, max, fallback) => {
    // Отсутствующее значение проверяем ДО Number(): Number(null) и
    // Number('') дают ноль, а не NaN, поэтому пустое поле молча
    // превращалось бы в минимально допустимое вместо умолчания.
    if (value === null || value === undefined || value === '') return fallback;

    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };

  return {
    enabled: saved.enabled === true,
    deposit: clamp(saved.deposit, 1, 10_000_000, DEFAULT_SETTINGS.deposit),
    lot: clamp(saved.lot, 0.01, 100, DEFAULT_SETTINGS.lot),
    riskPercent: clamp(saved.riskPercent, 0.1, 100, DEFAULT_SETTINGS.riskPercent),
    stopMode: saved.stopMode === 'atr' ? 'atr' : 'structure',
    stopAtrMultiple: clamp(saved.stopAtrMultiple, 0.2, 10, DEFAULT_SETTINGS.stopAtrMultiple),
    rewardRatio: clamp(saved.rewardRatio, 0.2, 20, DEFAULT_SETTINGS.rewardRatio),
    maxOpenPositions: clamp(saved.maxOpenPositions, 1, 50, DEFAULT_SETTINGS.maxOpenPositions),
    spread: clamp(saved.spread, 0, 50, DEFAULT_SETTINGS.spread),
    swapPerNight: clamp(saved.swapPerNight, -100, 100, DEFAULT_SETTINGS.swapPerNight),
    stopSlippage: clamp(saved.stopSlippage, 0, 50, DEFAULT_SETTINGS.stopSlippage),
    llmShadow: saved.llmShadow === true,
    timeframe: saved.timeframe ?? DEFAULT_SETTINGS.timeframe,
    strategies: { ...DEFAULT_SETTINGS.strategies, ...(saved.strategies ?? {}) },
    exits: {
      breakevenAt: clamp(saved.exits?.breakevenAt, 0, 10, DEFAULT_SETTINGS.exits.breakevenAt),
      partialAt: clamp(saved.exits?.partialAt, 0, 10, DEFAULT_SETTINGS.exits.partialAt),
      trailAtr: clamp(saved.exits?.trailAtr, 0, 10, DEFAULT_SETTINGS.exits.trailAtr),
    },
    filters: {
      premiumDiscount: (saved.filters?.premiumDiscount ?? DEFAULT_SETTINGS.filters.premiumDiscount) === true,
      minStopAtr: clamp(saved.filters?.minStopAtr, 0, 5, DEFAULT_SETTINGS.filters.minStopAtr),
    },
  };
}

/**
 * Считает стоп и цель для сигнала.
 *
 * От структуры — за противоположную границу зоны с небольшим отступом:
 * если цена ушла за зону, идея сигнала перестала работать.
 * От ATR — на фиксированном расстоянии в единицах волатильности.
 *
 * @returns {{stopLoss:number, takeProfit:number, riskPoints:number}|null}
 */
export function calculateLevels(signal, settings, atr) {
  const bullish = signal.direction === 'bullish';
  const sign = bullish ? 1 : -1;

  let stopLoss;
  if (settings.stopMode === 'atr') {
    if (!Number.isFinite(atr) || atr <= 0) return null;
    stopLoss = signal.entry - sign * atr * settings.stopAtrMultiple;
  } else {
    const edge = bullish ? signal.zone.bottom : signal.zone.top;
    // Отступ за границу зоны, чтобы не выбивало касанием.
    const padding = Math.abs(signal.zone.top - signal.zone.bottom) * 0.1;
    stopLoss = edge - sign * padding;
  }

  const riskPoints = Math.abs(signal.entry - stopLoss);
  // Нулевой риск означал бы бесконечный размер позиции.
  if (!(riskPoints > 0)) return null;

  return {
    stopLoss: round(stopLoss),
    takeProfit: round(signal.entry + sign * riskPoints * settings.rewardRatio),
    riskPoints: round(riskPoints),
  };
}

/**
 * Размер позиции.
 *
 * Если задан риск в процентах, лот считается от него: сколько можно
 * потерять в деньгах, делённое на расстояние до стопа. Так одинаковый
 * процент риска даёт разный лот при разной ширине стопа — это и есть
 * управление риском.
 */
export function calculateLot(settings, riskPoints) {
  if (!settings.riskPercent || riskPoints <= 0) return settings.lot;

  const riskMoney = (settings.deposit * settings.riskPercent) / 100;
  const lot = riskMoney / (riskPoints * CONTRACT_SIZE);

  // Ограничения площадки: минимальный шаг лота и разумный потолок.
  return Math.max(0.01, Math.min(100, Math.round(lot * 100) / 100));
}

/** Создаёт позицию из сигнала. */
export function openPosition(signal, settings, atr, now = Date.now()) {
  const levels = calculateLevels(signal, settings, atr);
  if (!levels) return null;

  const lot = calculateLot(settings, levels.riskPoints);

  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    strategy: signal.strategy,
    direction: signal.direction,
    reason: signal.reason,
    entry: round(signal.entry),
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    riskPoints: levels.riskPoints,
    lot,
    status: 'open',
    openedAt: new Date(now).toISOString(),
    closedAt: null,
    closePrice: null,
    outcome: null,
    pnlPoints: null,
    pnlMoney: null,
  };
}

/**
 * Проверяет, не закрылась ли позиция по свече.
 *
 * Тонкость: если свеча задела и стоп, и цель, мы не знаем, что было
 * раньше — внутри свечи порядка нет. Считаем худший случай, то есть
 * стоп. Иначе статистика получится приукрашенной.
 *
 * @returns {{outcome:'tp'|'sl', price:number}|null}
 */
export function checkExit(position, candle) {
  const bullish = position.direction === 'bullish';

  const hitStop = bullish ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
  const hitTarget = bullish ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;

  if (hitStop) return { outcome: 'sl', price: position.stopLoss };
  if (hitTarget) return { outcome: 'tp', price: position.takeProfit };
  return null;
}

/**
 * Закрывает позицию и считает результат.
 *
 * Спред вычитается один раз за сделку: вход по худшей стороне рынка
 * и выход по худшей вместе дают примерно его величину. Без этого
 * статистика получается лучше реальности, причём тем заметнее, чем
 * чаще система торгует.
 */
export function closePosition(position, outcome, price, now = Date.now(), costs = 0) {
  // Раньше пятым аргументом был один спред — старые вызовы продолжают
  // работать, новые передают объект со всеми издержками.
  const { spread = 0, swapPerNight = 0, stopSlippage = 0 } =
    typeof costs === 'number' ? { spread: costs } : costs;

  const sign = position.direction === 'bullish' ? 1 : -1;

  // Стоп исполняется по рынку: фактический выход хуже выставленного.
  const actualPrice = outcome === 'sl' ? price - sign * stopSlippage : price;

  const grossPoints = (actualPrice - position.entry) * sign;
  const netPoints = grossPoints - spread;

  const nights = nightsHeld(position.openedAt, now);
  const swapMoney = round(nights * swapPerNight * position.lot);

  return {
    ...position,
    status: 'closed',
    closedAt: new Date(now).toISOString(),
    closePrice: round(actualPrice),
    outcome,
    grossPoints: round((price - position.entry) * sign),
    spreadCost: round(spread * position.lot * CONTRACT_SIZE),
    slippageCost: round(stopSlippage * position.lot * CONTRACT_SIZE * (outcome === 'sl' ? 1 : 0)),
    nights,
    swapCost: swapMoney,
    pnlPoints: round(netPoints),
    pnlMoney: round(netPoints * position.lot * CONTRACT_SIZE + swapMoney),
  };
}

/**
 * Сколько раз позиция пережила полночь по UTC.
 *
 * В среду своп начисляется тройной — так на площадках компенсируют
 * выходные. Это заметно для позиций, висящих неделями.
 */
export function nightsHeld(openedAt, closedAt) {
  const from = new Date(openedAt);
  const to = new Date(closedAt);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return 0;

  const day = (d) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
  let nights = 0;

  for (let d = day(from) + 1; d <= day(to); d++) {
    // Тройной своп начисляется в ночь со СРЕДЫ на четверг — так
    // компенсируют выходные. Значит, утраивается та ночь, по итогам
    // которой наступает четверг. Эпоха Unix началась в четверг,
    // поэтому номер дня, кратный семи, и есть четверг.
    nights += d % 7 === 0 ? 3 : 1;
  }
  return nights;
}

/** Текущий результат незакрытой позиции по рыночной цене. */
export function floatingPnl(position, price) {
  const sign = position.direction === 'bullish' ? 1 : -1;
  const points = (price - position.entry) * sign;
  return {
    pnlPoints: round(points),
    pnlMoney: round(points * position.lot * CONTRACT_SIZE),
  };
}

/**
 * Сводная статистика по закрытым сделкам — то самое «сколько плюсов
 * и минусов».
 */
export function summarize(positions, settings = DEFAULT_SETTINGS) {
  const closed = positions.filter((p) => p.status === 'closed');
  const wins = closed.filter((p) => p.pnlMoney > 0);
  const losses = closed.filter((p) => p.pnlMoney <= 0);

  const total = closed.reduce((sum, p) => sum + p.pnlMoney, 0);
  const grossWin = wins.reduce((sum, p) => sum + p.pnlMoney, 0);
  const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p.pnlMoney, 0));

  return {
    total: closed.length,
    open: positions.filter((p) => p.status === 'open').length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
    pnlMoney: round(total),
    pnlPercent: settings.deposit ? round((total / settings.deposit) * 100) : null,
    averageWin: wins.length ? round(grossWin / wins.length) : null,
    averageLoss: losses.length ? round(grossLoss / losses.length) : null,
    // Отношение заработанного к потерянному: больше единицы — в плюс.
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdown: round(maxDrawdown(closed)),
    byStrategy: byStrategy(closed),
  };
}

/** Худшая просадка по нарастающему итогу. */
function maxDrawdown(closed) {
  let peak = 0;
  let equity = 0;
  let worst = 0;

  for (const position of closed) {
    equity += position.pnlMoney;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

/** Разбивка по стратегиям — видно, какая из них тянет результат. */
function byStrategy(closed) {
  const groups = {};

  for (const position of closed) {
    const group = (groups[position.strategy] ??= { total: 0, wins: 0, pnlMoney: 0 });
    group.total += 1;
    if (position.pnlMoney > 0) group.wins += 1;
    group.pnlMoney = round(group.pnlMoney + position.pnlMoney);
  }

  for (const group of Object.values(groups)) {
    group.winRate = Math.round((group.wins / group.total) * 1000) / 10;
  }
  return groups;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/* ======================= Управление позицией ======================= */

/**
 * Обновляет стоп и при необходимости фиксирует часть объёма.
 *
 * Критично для честности: вызывать ЭТУ функцию нужно ПОСЛЕ проверки
 * выхода по текущей свече, а не до. Иначе получится, что стоп успел
 * переехать в безубыток раньше, чем цена сходила против позиции на
 * той же свече, — внутри свечи порядок неизвестен, и такое допущение
 * систематически завышает результат.
 *
 * @param {object} position
 * @param {object} candle - свеча, которую уже проверили на выход
 * @param {number|null} atr
 * @param {object} exits - настройки управления
 * @param {{spread?: number}} [costs] - издержки: частичное закрытие
 *   такая же рыночная операция, как любая другая, и платит спред
 * @returns {{position: object, partial: object|null}}
 */
export function managePosition(position, candle, atr, exits = {}, costs = {}) {
  const bullish = position.direction === 'bullish';
  const sign = bullish ? 1 : -1;
  const risk = position.riskPoints;
  if (!(risk > 0)) return { position, partial: null };

  // Сколько R прошла цена в лучшую сторону за эту свечу.
  const best = bullish ? candle.high : candle.low;
  const progress = ((best - position.entry) * sign) / risk;

  let updated = position;
  let partial = null;

  // Частичная фиксация: половина объёма снимается, остаток едет дальше.
  if (
    exits.partialAt > 0 &&
    !position.partialTaken &&
    progress >= exits.partialAt
  ) {
    const half = Math.max(0.01, Math.round((position.lot / 2) * 100) / 100);
    const price = position.entry + sign * risk * exits.partialAt;

    // Спред платится и здесь. Без этого стратегии с частичной
    // фиксацией выглядели бы выгоднее, чем они есть: каждая сделка
    // закрывалась бы дважды, а издержки списывались бы один раз.
    const spread = costs.spread ?? 0;
    const netPoints = risk * exits.partialAt - spread;

    partial = {
      ...position,
      id: `${position.id}-p`,
      lot: half,
      status: 'closed',
      outcome: 'partial',
      closePrice: round(price),
      grossPoints: round(risk * exits.partialAt),
      spreadCost: round(spread * half * CONTRACT_SIZE),
      slippageCost: 0,
      swapCost: 0,
      pnlPoints: round(netPoints),
      pnlMoney: round(netPoints * half * CONTRACT_SIZE),
    };

    updated = { ...updated, lot: round(position.lot - half), partialTaken: true };
  }

  // Безубыток: стоп переносится на цену входа.
  if (exits.breakevenAt > 0 && progress >= exits.breakevenAt) {
    const atEntry = bullish
      ? Math.max(updated.stopLoss, position.entry)
      : Math.min(updated.stopLoss, position.entry);
    updated = { ...updated, stopLoss: round(atEntry) };
  }

  // Трейлинг: стоп подтягивается за ценой и никогда не отходит назад.
  if (exits.trailAtr > 0 && Number.isFinite(atr) && atr > 0) {
    const trailed = best - sign * atr * exits.trailAtr;
    const better = bullish
      ? Math.max(updated.stopLoss, trailed)
      : Math.min(updated.stopLoss, trailed);
    updated = { ...updated, stopLoss: round(better) };
  }

  return { position: updated, partial };
}
