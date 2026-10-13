/* ===========================================================================
   Свечной график на Lightweight Charts — библиотеке самой TradingView.

   Важно про версию: в 5.x серии добавляются через chart.addSeries(Определение),
   а не методами вроде addCandlestickSeries(), как было в 4.x. Примеры из
   интернета часто написаны под старый API и работать не будут.
   =========================================================================== */

import { ZonesPrimitive } from './zones.js';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs';

/** Цвета берём из тех же переменных, что и остальное оформление. */
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const UP = '#26a69a';
const DOWN = '#ef5350';

/** Сколько свечей видно при открытии. Остальное — прокруткой. */
const VISIBLE_BARS = 180;

/** Какие слои разметки показывать. Переключается кнопками. */
const layers = {
  zones: true,
  events: true,
  liquidity: true,
  pivots: true,
};

const state = {
  chart: null,
  loadedTimeframe: null,
  zonesPrimitive: null,
  markers: null,
  liquidityLines: [],
  structure: null,
  candles: null,
  ema50: null,
  ema200: null,
  priceLines: [],
  timeframe: '1h',
  token: null,
  timer: null,
};

/* ======================= Создание графика ======================= */

function build(container) {
  const chart = createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: css('--surface', '#141922') },
      textColor: css('--muted', '#8792a6'),
      fontFamily: getComputedStyle(document.body).fontFamily,
      // Штатная опция библиотеки: убирает логотип TradingView с канвы.
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: css('--border', '#242c3a') },
      horzLines: { color: css('--border', '#242c3a') },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { labelBackgroundColor: css('--gold', '#e8b339') },
      horzLine: { labelBackgroundColor: css('--gold', '#e8b339') },
    },
    rightPriceScale: { borderColor: css('--border', '#242c3a') },
    timeScale: {
      borderColor: css('--border', '#242c3a'),
      // На внутридневных таймфреймах нужны часы и минуты, а не только даты.
      timeVisible: true,
      secondsVisible: false,
    },
    localization: {
      locale: 'ru-RU',
      priceFormatter: (price) => price.toFixed(2),
    },
    autoSize: true,
  });

  state.chart = chart;

  state.candles = chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    borderUpColor: UP,
    borderDownColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
  });

  state.ema50 = chart.addSeries(LineSeries, {
    color: '#60a5fa',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.ema200 = chart.addSeries(LineSeries, {
    color: '#e8b339',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  // Зоны рисуются своим примитивом: прямоугольников в библиотеке нет.
  state.zonesPrimitive = new ZonesPrimitive();
  state.candles.attachPrimitive(state.zonesPrimitive);

  // Метки событий — штатный механизм маркеров.
  state.markers = createSeriesMarkers(state.candles, []);

  // Подпись с ценами под курсором — как в терминале.
  chart.subscribeCrosshairMove((param) => {
    const bar = param.seriesData?.get(state.candles);
    renderLegend(bar);
  });

  return chart;
}

/** Строка со значениями свечи под курсором. */
function renderLegend(bar) {
  const legend = document.getElementById('chart-legend');
  if (!legend) return;

  if (!bar) {
    legend.innerHTML = '';
    return;
  }

  const rising = bar.close >= bar.open;
  const pair = (label, value) =>
    `<span class="leg"><i>${label}</i>${value.toFixed(2)}</span>`;

  legend.innerHTML =
    `<span style="color:${rising ? UP : DOWN}">` +
    pair('О', bar.open) + pair('В', bar.high) + pair('Н', bar.low) + pair('З', bar.close) +
    '</span>';
}

/* ======================= Уровни ======================= */

/**
 * Горизонтальные линии пивот-уровней.
 *
 * Старые линии нужно снимать явно: без этого при каждом обновлении
 * они накладывались бы друг на друга.
 */
function drawPivots(pivots) {
  for (const line of state.priceLines) state.candles.removePriceLine(line);
  state.priceLines = [];

  if (!pivots || !layers.pivots) return;

  const levels = [
    ['R3', pivots.r3, DOWN], ['R2', pivots.r2, DOWN], ['R1', pivots.r1, DOWN],
    ['PP', pivots.pp, css('--gold', '#e8b339')],
    ['S1', pivots.s1, UP], ['S2', pivots.s2, UP], ['S3', pivots.s3, UP],
  ];

  for (const [title, price, color] of levels) {
    if (!Number.isFinite(price)) continue;
    state.priceLines.push(
      state.candles.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: title === 'PP' ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      }),
    );
  }
}

/* ======================= Разметка структуры ======================= */

/**
 * Метки событий структуры и снятий ликвидности.
 *
 * Маркеры требуют строго возрастающего времени, иначе библиотека
 * выбрасывает ошибку — поэтому сортируем перед передачей.
 */
function drawEvents(structure) {
  if (!state.markers) return;

  if (!layers.events) {
    state.markers.setMarkers([]);
    return;
  }

  const markers = [];

  for (const event of structure.events ?? []) {
    const bullish = event.direction === 'bullish';
    markers.push({
      time: event.time,
      position: bullish ? 'belowBar' : 'aboveBar',
      // Смена характера важнее продолжения — выделяем её формой и цветом.
      shape: event.type === 'CHoCH' ? 'circle' : 'arrowUp',
      color: event.type === 'CHoCH' ? '#e8b339' : bullish ? '#26a69a' : '#ef5350',
      text: event.type,
    });
  }

  for (const sweep of structure.sweeps ?? []) {
    markers.push({
      time: sweep.time,
      position: sweep.direction === 'bullish' ? 'belowBar' : 'aboveBar',
      shape: 'square',
      color: '#a78bfa',
      text: '↯',
    });
  }

  markers.sort((a, b) => a.time - b.time);
  state.markers.setMarkers(markers);
}

/** Уровни скоплений ликвидности — горизонтальными линиями. */
function drawLiquidity(structure) {
  for (const line of state.liquidityLines) state.candles.removePriceLine(line);
  state.liquidityLines = [];

  if (!layers.liquidity) return;

  for (const pool of structure.pools ?? []) {
    state.liquidityLines.push(
      state.candles.createPriceLine({
        price: pool.price,
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: `${pool.side === 'buy-side' ? 'BSL' : 'SSL'} ×${pool.count}`,
      }),
    );
  }
}

/** Применяет всю разметку целиком. */
function drawStructure(structure) {
  if (!structure) return;
  state.structure = structure;

  state.zonesPrimitive?.setZones(layers.zones ? structure.zones ?? [] : []);
  drawEvents(structure);
  drawLiquidity(structure);

  const info = document.getElementById('structure-info');
  if (info) {
    const names = { bullish: 'восходящая', bearish: 'нисходящая', null: 'не определена' };
    const zones = structure.zones?.length ?? 0;
    info.textContent =
      `структура: ${names[structure.trend] ?? '—'} · ` +
      `зон: ${zones} · ${structure.range?.zone ?? '—'}`;
  }
}

/* ======================= Загрузка данных ======================= */

/**
 * Загружает данные графика.
 *
 * Первый раз — всю историю. Дальше только хвост: при обновлении меняется
 * одна свеча, а полная серия весит под мегабайт. Хвост дорисовывается
 * через update(), который для того и предназначен.
 */
async function load({ tail = false } = {}) {
  if (!state.token) return;

  const status = document.getElementById('chart-status');
  const query = new URLSearchParams({ timeframe: state.timeframe });
  if (tail) query.set('tail', '1');

  let response;
  try {
    response = await fetch(`/api/candles?${query}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
  } catch {
    if (status) status.textContent = 'сеть недоступна';
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (status) status.textContent = body.error ?? 'не удалось загрузить';
    return;
  }

  const data = await response.json();

  if (data.tail) {
    // update() принимает бары по одному и требует неубывающего времени.
    for (const candle of data.candles) state.candles.update(candle);
    for (const point of data.ema50) state.ema50.update(point);
    for (const point of data.ema200) state.ema200.update(point);
    drawPivots(data.pivots);
    drawStructure(data.structure);
    renderLegend(data.candles.at(-1));
    return;
  }

  const firstLoad = state.loadedTimeframe !== data.timeframe;

  state.candles.setData(data.candles);
  state.ema50.setData(data.ema50);
  state.ema200.setData(data.ema200);
  drawPivots(data.pivots);
  drawStructure(data.structure);

  // Показываем последние свечи, а не весь загруженный диапазон: иначе
  // пять тысяч баров сожмутся в нечитаемую полоску. Прокруткой и
  // колесом доступна вся история.
  if (firstLoad) {
    state.chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, data.candles.length - VISIBLE_BARS),
      to: data.candles.length + 5,
    });
    state.loadedTimeframe = data.timeframe;
  }

  const last = data.candles.at(-1);
  if (status) {
    const first = data.candles[0];
    const span = first
      ? `${new Date(first.time * 1000).toLocaleDateString('ru-RU')} — ${new Date(last.time * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
      : '—';
    status.textContent = `${data.symbol} · ${data.candles.length} свечей · ${span}`;
  }
  renderLegend(last);
}

/* ======================= Публичный интерфейс ======================= */

/** Создаёт график и запускает обновление. */
export function initChart(token) {
  state.token = token;

  const container = document.getElementById('chart');
  if (!container) return;

  if (!state.chart) {
    build(container);

    // Разворот графика на весь экран.
    const expand = document.getElementById('chart-expand');
    if (expand) {
      expand.addEventListener('click', () => {
        const box = document.querySelector('.chart-box');
        const full = box.classList.toggle('fullscreen');
        document.body.classList.toggle('chart-open', full);
        expand.textContent = full ? '✕ Свернуть' : '⤢ На весь экран';

        // Библиотека пересчитывает размер сама (autoSize), но ей нужен
        // кадр, чтобы увидеть новые размеры контейнера.
        requestAnimationFrame(() => state.chart?.timeScale().fitContent());
      });
    }

    // Выход из полноэкранного режима по Escape.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const box = document.querySelector('.chart-box');
      if (box?.classList.contains('fullscreen')) expand?.click();
    });

    // Переключатели слоёв разметки.
    for (const button of document.querySelectorAll('.layer')) {
      button.addEventListener('click', () => {
        const name = button.dataset.layer;
        layers[name] = !layers[name];
        button.classList.toggle('active', layers[name]);

        // Перерисовываем из уже загруженных данных, без запроса к серверу.
        if (state.structure) drawStructure(state.structure);
        if (name === 'pivots') load();
      });
    }

    // Переключатель таймфреймов.
    for (const button of document.querySelectorAll('.tf')) {
      button.addEventListener('click', () => {
        state.timeframe = button.dataset.tf;
        state.loadedTimeframe = null;
        for (const other of document.querySelectorAll('.tf')) {
          other.classList.toggle('active', other === button);
        }
        load();
      });
    }
  }

  load();

  // Свечи обновляются реже показателей: кэш живёт четверть таймфрейма,
  // поэтому частый опрос всё равно вернул бы то же самое.
  clearInterval(state.timer);
  state.timer = setInterval(() => load({ tail: true }), 60000);
}

/** Останавливает обновление — при выходе и когда вкладка скрыта. */
export function stopChart() {
  clearInterval(state.timer);
  state.timer = null;
}

/** Обновляет токен после повторного входа. */
export function setChartToken(token) {
  state.token = token;
}
