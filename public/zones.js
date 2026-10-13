/* ===========================================================================
   Отрисовка зон на канве графика.

   Lightweight Charts не умеет прямоугольники из коробки — для своей
   графики есть механизм примитивов: объект с методом paneViews(),
   который библиотека вызывает при каждой перерисовке.

   Координаты приходится считать самим: цену переводит в пиксели серия
   (priceToCoordinate), время — шкала времени (timeToCoordinate).
   =========================================================================== */

/** Цвета зон. Полупрозрачные — под ними должны быть видны свечи. */
const STYLE = {
  fvg: {
    bullish: { fill: 'rgba(38, 166, 154, 0.14)', border: 'rgba(38, 166, 154, 0.5)' },
    bearish: { fill: 'rgba(239, 83, 80, 0.14)', border: 'rgba(239, 83, 80, 0.5)' },
  },
  ob: {
    bullish: { fill: 'rgba(96, 165, 250, 0.16)', border: 'rgba(96, 165, 250, 0.6)' },
    bearish: { fill: 'rgba(232, 179, 57, 0.16)', border: 'rgba(232, 179, 57, 0.6)' },
  },
};

const LABEL = { fvg: 'FVG', ob: 'OB' };

class ZoneRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { series, chart, zones, showLabels } = this._source;
    if (!series || !chart || zones.length === 0) return;

    const timeScale = chart.timeScale();

    // Рисуем в координатах пикселей устройства: на экранах с высокой
    // плотностью логические координаты нужно домножить на коэффициент,
    // иначе всё съедет вдвое.
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const kx = scope.horizontalPixelRatio;
      const ky = scope.verticalPixelRatio;

      ctx.save();

      for (const zone of zones) {
        const yTop = series.priceToCoordinate(zone.top);
        const yBottom = series.priceToCoordinate(zone.bottom);
        if (yTop === null || yBottom === null) continue;

        let xFrom = timeScale.timeToCoordinate(zone.from);
        let xTo = timeScale.timeToCoordinate(zone.to);

        // За пределами загруженного диапазона шкала возвращает null.
        // Для зоны, уходящей за край экрана, берём сам край.
        if (xFrom === null) xFrom = 0;
        if (xTo === null) xTo = scope.mediaSize.width;
        if (xTo <= xFrom) xTo = scope.mediaSize.width;

        const style = STYLE[zone.kind]?.[zone.direction];
        if (!style) continue;

        const x = xFrom * kx;
        const y = Math.min(yTop, yBottom) * ky;
        const width = (xTo - xFrom) * kx;
        const height = Math.abs(yBottom - yTop) * ky;

        ctx.fillStyle = style.fill;
        ctx.fillRect(x, y, width, height);

        ctx.strokeStyle = style.border;
        ctx.lineWidth = Math.max(1, Math.floor(ky));
        ctx.strokeRect(x, y, width, height);

        // Подпись помещается, только если зона достаточно высокая.
        if (showLabels && height > 14 * ky) {
          ctx.fillStyle = style.border;
          ctx.font = `${Math.round(10 * ky)}px ui-monospace, monospace`;
          ctx.textBaseline = 'top';
          ctx.fillText(LABEL[zone.kind], x + 4 * kx, y + 3 * ky);
        }
      }

      ctx.restore();
    });
  }
}

class ZonePaneView {
  constructor(source) {
    this._renderer = new ZoneRenderer(source);
  }

  renderer() {
    return this._renderer;
  }

  /** Зоны лежат под свечами, чтобы не перекрывать их. */
  zOrder() {
    return 'bottom';
  }
}

/**
 * Примитив зон: подключается к серии через attachPrimitive.
 *
 * Данные меняются через setZones — библиотека перерисует канву сама,
 * если попросить её об этом через requestUpdate.
 */
export class ZonesPrimitive {
  constructor() {
    this.zones = [];
    this.showLabels = true;
    this.series = null;
    this.chart = null;
    this._views = [new ZonePaneView(this)];
    this._requestUpdate = null;
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
  }

  paneViews() {
    return this._views;
  }

  setZones(zones) {
    this.zones = Array.isArray(zones) ? zones : [];
    this._requestUpdate?.();
  }
}
