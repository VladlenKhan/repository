/**
 * Детектор рыночной структуры в терминах Smart Money / ICT.
 *
 * Все функции чистые: на вход свечи, на выход объекты разметки. Ни сети,
 * ни хранилища — поэтому поведение воспроизводимо и проверяется тестами
 * на вручную собранных свечах.
 *
 * Свеча: { time: number, open, high, low, close }, порядок — от старых
 * к новым, без повторов по времени (это обеспечивает normalizeSeries).
 *
 * Определения взяты в их формализуемом виде. Там, где методология
 * допускает разночтения, выбранное правило описано в комментарии —
 * чтобы потом не гадать, почему разметка выглядит именно так.
 */

/* ======================= Свинги ======================= */

/**
 * Экстремумы (swing points).
 *
 * Свеча считается swing-максимумом, если её high строго выше hiмаксимумов
 * `strength` соседей с каждой стороны. Минимум — зеркально.
 *
 * Чем больше strength, тем крупнее найденные колебания: на strength=2
 * размечается каждая мелкая волна, на strength=5 — только заметные.
 *
 * @param {Array} candles
 * @param {number} strength - сколько соседей проверять с каждой стороны
 * @returns {Array<{index:number, time:number, price:number, kind:'high'|'low'}>}
 */
export function findSwings(candles, strength = 3) {
  if (!Array.isArray(candles) || candles.length < strength * 2 + 1) return [];

  const swings = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) isHigh = false;
      if (candles[j].low <= candle.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) swings.push({ index: i, time: candle.time, price: candle.high, kind: 'high' });
    if (isLow) swings.push({ index: i, time: candle.time, price: candle.low, kind: 'low' });
  }

  return swings;
}

/* ======================= Структура: BOS и CHoCH ======================= */

/**
 * События слома структуры.
 *
 * BOS (Break of Structure) — цена закрылась за последним экстремумом
 * ПО направлению текущей структуры: восходящая структура обновила
 * максимум, нисходящая — минимум. Это продолжение.
 *
 * CHoCH (Change of Character) — первый слом ПРОТИВ структуры: в
 * восходящей пробит последний минимум. Это возможный разворот.
 *
 * Важное решение: слом засчитывается по ЗАКРЫТИЮ, а не по тени.
 * Пробой тенью без закрытия — это снятие ликвидности, оно ловится
 * отдельной функцией и означает обратное.
 *
 * @returns {Array<{index, time, price, type:'BOS'|'CHoCH', direction:'bullish'|'bearish', brokenSwing}>}
 */
export function detectStructure(candles, swings, options = {}) {
  const strength = options.strength ?? 3;
  const events = [];
  if (swings.length === 0) return events;

  // Направление структуры. Пока не было ни одного слома — не определено.
  let trend = null;

  // Последние подтверждённые экстремумы, за которыми следим.
  let lastHigh = null;
  let lastLow = null;

  // Указатель на ещё не учтённые экстремумы. Он же не даёт одному
  // уровню сработать дважды: пройденные свинги назад не возвращаются.
  let cursor = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Экстремум на свече j подтверждается только через strength свечей:
    // раньше этого момента мы не можем знать, что он экстремум. Без
    // этой задержки детектор заглядывал бы в будущее и находил сломы,
    // которых в реальном времени не существовало.
    while (cursor < swings.length && swings[cursor].index + strength <= i) {
      const swing = swings[cursor];
      cursor += 1;

      // Защищённый экстремум.
      //
      // В восходящей структуре сломом характера считается пробой не
      // любого минимума, а того, от которого пошёл импульс. Поэтому
      // пока структура бычья, минимум обновляем только вверх: каждый
      // следующий минимум должен быть выше предыдущего. Иначе любой
      // мелкий откат засчитывался бы как смена характера, и CHoCH
      // появлялся бы чаще BOS — чего в тренде быть не должно.
      if (swing.kind === 'high') {
        if (trend === 'bearish' && lastHigh && swing.price > lastHigh.price) continue;
        lastHigh = swing;
      } else {
        if (trend === 'bullish' && lastLow && swing.price < lastLow.price) continue;
        lastLow = swing;
      }
    }

    if (lastHigh && candle.close > lastHigh.price) {
      const type = trend === 'bearish' ? 'CHoCH' : 'BOS';
      events.push({
        index: i,
        time: candle.time,
        price: lastHigh.price,
        type,
        direction: 'bullish',
        brokenSwing: lastHigh,
      });
      trend = 'bullish';
      // Пробитый уровень больше не актуален: ждём следующего экстремума.
      lastHigh = null;
    } else if (lastLow && candle.close < lastLow.price) {
      const type = trend === 'bullish' ? 'CHoCH' : 'BOS';
      events.push({
        index: i,
        time: candle.time,
        price: lastLow.price,
        type,
        direction: 'bearish',
        brokenSwing: lastLow,
      });
      trend = 'bearish';
      lastLow = null;
    }
  }

  return events;
}

/** Текущее направление структуры по последнему событию. */
export function currentTrend(events) {
  const last = events.at(-1);
  return last ? last.direction : null;
}

/* ======================= Имбалансы (FVG) ======================= */

/**
 * Fair Value Gap — разрыв, который цена проскочила без торговли.
 *
 * Бычий FVG на тройке свечей [i-1, i, i+1]: low[i+1] > high[i-1].
 * Между этими уровнями не было сделок — середина свечи i пролетела.
 * Медвежий — зеркально: high[i+1] < low[i-1].
 *
 * Отработанным (mitigated) считаем разрыв, в который цена вернулась
 * хотя бы касанием после его образования.
 *
 * @param {Array} candles
 * @param {{minSizeRatio?: number}} [options] - минимальный размер разрыва
 *   в долях от цены, чтобы отсеять шум
 */
export function findFairValueGaps(candles, options = {}) {
  const minSizeRatio = options.minSizeRatio ?? 0.0005;
  const gaps = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    const bullish = next.low > prev.high;
    const bearish = next.high < prev.low;
    if (!bullish && !bearish) continue;

    const top = bullish ? next.low : prev.low;
    const bottom = bullish ? prev.high : next.high;
    const size = top - bottom;

    // Крошечные разрывы — шум, на графике их не видно и торговать нечем.
    if (size / candles[i].close < minSizeRatio) continue;

    gaps.push({
      index: i,
      time: candles[i].time,
      direction: bullish ? 'bullish' : 'bearish',
      top,
      bottom,
      size,
      ...mitigation(candles, i + 2, bottom, top),
    });
  }

  return gaps;
}

/**
 * Вернулась ли цена в зону после её образования.
 * @returns {{mitigated:boolean, mitigatedAt:number|null}}
 */
function mitigation(candles, fromIndex, bottom, top) {
  for (let j = fromIndex; j < candles.length; j++) {
    if (candles[j].low <= top && candles[j].high >= bottom) {
      return { mitigated: true, mitigatedAt: candles[j].time };
    }
  }
  return { mitigated: false, mitigatedAt: null };
}

/* ======================= Order blocks ======================= */

/**
 * Order block — последняя свеча противоположного направления перед
 * импульсом, сломавшим структуру.
 *
 * Логика методологии: там, где крупный участник набирал позицию, цена
 * позже часто реагирует повторно. Формализуем так: от каждого события
 * слома идём назад и берём ближайшую свечу противоположного цвета.
 *
 * Зоной считается тело вместе с тенью в сторону движения — именно его
 * принято размечать прямоугольником.
 *
 * @param {Array} candles
 * @param {Array} events - результат detectStructure
 * @param {{lookback?: number}} [options]
 */
export function findOrderBlocks(candles, events, options = {}) {
  const lookback = options.lookback ?? 15;
  const blocks = [];

  for (const event of events) {
    const wantBearishCandle = event.direction === 'bullish';
    const from = Math.max(0, event.index - lookback);

    for (let i = event.index - 1; i >= from; i--) {
      const candle = candles[i];
      const isBearish = candle.close < candle.open;

      if (isBearish !== wantBearishCandle) continue;

      blocks.push({
        index: i,
        time: candle.time,
        direction: event.direction,
        top: candle.high,
        bottom: candle.low,
        causedBy: { type: event.type, time: event.time },
        ...mitigation(candles, event.index + 1, candle.low, candle.high),
      });
      break;
    }
  }

  return blocks;
}

/* ======================= Ликвидность ======================= */

/**
 * Пулы ликвидности — скопления равных экстремумов.
 *
 * Несколько максимумов на одном уровне означают скопление стоп-заявок
 * над ними. В методологии это цель для движения: ликвидность «снимают».
 *
 * @param {Array} swings
 * @param {{tolerance?: number, minCount?: number}} [options]
 *   tolerance — допуск в долях цены, при котором экстремумы считаем равными
 */
export function findLiquidityPools(swings, options = {}) {
  const tolerance = options.tolerance ?? 0.0008;
  const minCount = options.minCount ?? 2;
  const pools = [];

  for (const kind of ['high', 'low']) {
    const points = swings.filter((s) => s.kind === kind).sort((a, b) => a.price - b.price);

    let group = [];
    const flush = () => {
      if (group.length >= minCount) {
        const prices = group.map((p) => p.price);
        pools.push({
          kind,
          // Для максимумов ликвидность лежит НАД уровнем, для минимумов — под.
          side: kind === 'high' ? 'buy-side' : 'sell-side',
          price: prices.reduce((a, b) => a + b, 0) / prices.length,
          count: group.length,
          from: Math.min(...group.map((p) => p.time)),
          to: Math.max(...group.map((p) => p.time)),
        });
      }
      group = [];
    };

    for (const point of points) {
      const first = group[0];
      if (!first || Math.abs(point.price - first.price) / first.price <= tolerance) {
        group.push(point);
        continue;
      }
      flush();
      group = [point];
    }
    flush();
  }

  return pools.sort((a, b) => a.price - b.price);
}

/**
 * Снятие ликвидности — тень вышла за прошлый экстремум, а закрытие
 * вернулось обратно.
 *
 * Это противоположность слому структуры: там закрытие ЗА уровнем, здесь
 * закрытие ВНУТРИ. Отличие принципиальное: слом означает продолжение,
 * снятие — ложный пробой и вероятный разворот.
 */
export function findLiquiditySweeps(candles, swings, options = {}) {
  const strength = options.strength ?? 3;
  const sweeps = [];

  // Снятый уровень считается израсходованным: ликвидность за ним уже
  // забрали. Без этого один экстремум давал бы «снятие» на каждой
  // следующей свече, и разметка превращалась бы в шум.
  const consumed = new Set();

  // Указатель на подтверждённые экстремумы — та же защита от
  // заглядывания в будущее, что и в detectStructure.
  let cursor = 0;
  const active = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    while (cursor < swings.length && swings[cursor].index + strength <= i) {
      active.push(swings[cursor]);
      cursor += 1;
    }

    // Смотрим только на свежие уровни: ликвидность за экстремумом
    // годовой давности уже давно собрана.
    for (let k = active.length - 1; k >= 0 && k >= active.length - 20; k--) {
      const swing = active[k];
      if (consumed.has(swing.index)) continue;

      const sweptHigh =
        swing.kind === 'high' && candle.high > swing.price && candle.close < swing.price;
      const sweptLow =
        swing.kind === 'low' && candle.low < swing.price && candle.close > swing.price;

      if (!sweptHigh && !sweptLow) continue;

      consumed.add(swing.index);
      sweeps.push({
        index: i,
        time: candle.time,
        direction: sweptHigh ? 'bearish' : 'bullish',
        price: swing.price,
        // Насколько глубоко ушли за уровень — мера решительности снятия.
        depth: sweptHigh ? candle.high - swing.price : swing.price - candle.low,
        sweptSwing: swing,
      });
      break;
    }
  }

  return sweeps;
}

/* ======================= Premium / Discount ======================= */

/**
 * Положение цены внутри торгового диапазона.
 *
 * Диапазон строится от последнего значимого минимума до максимума.
 * Выше середины — premium (дорого, méстo для продаж), ниже — discount.
 * OTE (Optimal Trade Entry) — зона 0.62–0.79 отката, её считают лучшей
 * для входа по тренду.
 *
 * @returns {{high, low, equilibrium, ote: {from, to}, zone: 'premium'|'discount'|'equilibrium', position: number}|null}
 */
export function premiumDiscount(candles, price, lookback = 100) {
  const window = candles.slice(-lookback);
  if (window.length === 0) return null;

  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const size = high - low;
  if (size <= 0) return null;

  // Доля пути от минимума к максимуму: 0 — на минимуме, 1 — на максимуме.
  const position = (price - low) / size;

  const zone = position > 0.55 ? 'premium' : position < 0.45 ? 'discount' : 'equilibrium';

  return {
    high,
    low,
    equilibrium: low + size / 2,
    // Зона оптимального входа отсчитывается от максимума вниз для покупок.
    ote: { from: high - size * 0.79, to: high - size * 0.62 },
    zone,
    position: Math.round(position * 1000) / 1000,
  };
}

/* ======================= Сводка ======================= */

/**
 * Полная разметка по свечам — то, что уходит на график и в стратегии.
 *
 * @param {Array} candles
 * @param {{swingStrength?: number}} [options]
 */
export function analyzeStructure(candles, options = {}) {
  const strength = options.swingStrength ?? 3;
  const swings = findSwings(candles, strength);
  const events = detectStructure(candles, swings, { strength });
  const price = candles.at(-1)?.close ?? null;

  return {
    swings,
    events,
    trend: currentTrend(events),
    fvg: findFairValueGaps(candles, options),
    orderBlocks: findOrderBlocks(candles, events, options),
    liquidityPools: findLiquidityPools(swings, options),
    sweeps: findLiquiditySweeps(candles, swings, { strength }),
    range: price === null ? null : premiumDiscount(candles, price),
  };
}

/* ======================= Подготовка к отрисовке ======================= */

/**
 * Сжимает разметку до того, что осмысленно показывать на графике.
 *
 * Полный разбор пяти тысяч свечей даёт сотни зон, большинство из них
 * давно отработаны и к торговле отношения не имеют. На график идут
 * незакрытые зоны и свежие события — остальное только зашумляет
 * картинку и раздувает ответ.
 *
 * @param {object} analysis - результат analyzeStructure
 * @param {Array} candles
 * @param {{maxZones?: number, maxEvents?: number, nearPercent?: number}} [options]
 */
export function summarizeForChart(analysis, candles, options = {}) {
  const maxZones = options.maxZones ?? 25;
  const maxEvents = options.maxEvents ?? 40;
  const nearPercent = options.nearPercent ?? 0.08;

  const price = candles.at(-1)?.close ?? 0;
  const lastTime = candles.at(-1)?.time ?? 0;
  const sec = (ms) => Math.floor(ms / 1000);

  /** Зона далеко от цены торгового смысла не имеет. */
  const isNear = (level) => price > 0 && Math.abs(level - price) / price <= nearPercent;

  const zones = [
    ...analysis.fvg
      .filter((g) => !g.mitigated && isNear(g.top))
      .slice(-maxZones)
      .map((g) => ({
        kind: 'fvg',
        direction: g.direction,
        top: g.top,
        bottom: g.bottom,
        from: sec(g.time),
        // Незакрытая зона тянется вправо до текущего момента.
        to: sec(lastTime),
      })),
    ...analysis.orderBlocks
      .filter((b) => !b.mitigated && isNear(b.top))
      .slice(-maxZones)
      .map((b) => ({
        kind: 'ob',
        direction: b.direction,
        top: b.top,
        bottom: b.bottom,
        from: sec(b.time),
        to: sec(lastTime),
      })),
  ];

  return {
    trend: analysis.trend,
    zones,
    events: analysis.events.slice(-maxEvents).map((e) => ({
      time: sec(e.time),
      type: e.type,
      direction: e.direction,
      price: e.price,
    })),
    sweeps: analysis.sweeps.slice(-maxEvents).map((s) => ({
      time: sec(s.time),
      direction: s.direction,
      price: s.price,
    })),
    // Пулов рядом с ценой бывают сотни. Оставляем самые плотные —
    // чем больше равных экстремумов, тем заметнее скопление заявок.
    pools: analysis.liquidityPools
      .filter((p) => isNear(p.price))
      .sort((a, b) => b.count - a.count || Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, options.maxPools ?? 8)
      .map((p) => ({ price: p.price, side: p.side, count: p.count }))
      .sort((a, b) => a.price - b.price),
    range: analysis.range,
  };
}
