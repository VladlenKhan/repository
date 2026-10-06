/* ===========================================================================
   Свечной график на Lightweight Charts — библиотеке самой TradingView.

   Важно про версию: в 5.x серии добавляются через chart.addSeries(Определение),
   а не методами вроде addCandlestickSeries(), как было в 4.x. Примеры из
   интернета часто написаны под старый API и работать не будут.
   =========================================================================== */

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
} from 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs';

/** Цвета берём из тех же переменных, что и остальное оформление. */
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const UP = '#26a69a';
const DOWN = '#ef5350';

const state = {
  chart: null,
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

  if (!pivots) return;

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

/* ======================= Загрузка данных ======================= */

async function load() {
  if (!state.token) return;

  const status = document.getElementById('chart-status');

  let response;
  try {
    response = await fetch(`/api/candles?timeframe=${encodeURIComponent(state.timeframe)}`, {
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

  state.candles.setData(data.candles);
  state.ema50.setData(data.ema50);
  state.ema200.setData(data.ema200);
  drawPivots(data.pivots);

  const last = data.candles.at(-1);
  if (status) {
    status.textContent = `${data.symbol} · ${data.candles.length} свечей · последняя ${last ? new Date(last.time * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'}`;
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

    // Переключатель таймфреймов.
    for (const button of document.querySelectorAll('.tf')) {
      button.addEventListener('click', () => {
        state.timeframe = button.dataset.tf;
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
  state.timer = setInterval(load, 60000);
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
