import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MacroError,
  describeRealYield,
  getRealYield,
  parseObservationValue,
  pickLatestObservations,
} from '../lib/macro.js';

describe('parseObservationValue', () => {
  it('разбирает обычное число', () => {
    expect(parseObservationValue('1.85')).toBe(1.85);
  });

  it('понимает отрицательные значения', () => {
    expect(parseObservationValue('-0.42')).toBe(-0.42);
  });

  it('считает точку пропуском — так FRED помечает отсутствие данных', () => {
    expect(parseObservationValue('.')).toBeNull();
  });

  it('считает пропуском пустую строку, null и мусор', () => {
    expect(parseObservationValue('')).toBeNull();
    expect(parseObservationValue(null)).toBeNull();
    expect(parseObservationValue(undefined)).toBeNull();
    expect(parseObservationValue('n/a')).toBeNull();
  });
});

describe('pickLatestObservations', () => {
  it('берёт два последних числовых значения', () => {
    const result = pickLatestObservations([
      { date: '2026-10-05', value: '1.90' },
      { date: '2026-10-04', value: '1.85' },
      { date: '2026-10-03', value: '1.80' },
    ]);
    expect(result.value).toBe(1.9);
    expect(result.previousValue).toBe(1.85);
    expect(result.date).toBe('2026-10-05');
  });

  it('пропускает выходные и праздники, помеченные точкой', () => {
    const result = pickLatestObservations([
      { date: '2026-10-11', value: '.' }, // воскресенье
      { date: '2026-10-10', value: '.' }, // суббота
      { date: '2026-10-09', value: '1.88' },
      { date: '2026-10-08', value: '1.84' },
    ]);
    expect(result.value).toBe(1.88);
    expect(result.date).toBe('2026-10-09');
    expect(result.change).toBe(0.04);
  });

  it('считает изменение к предыдущему значению', () => {
    const result = pickLatestObservations([
      { date: '2026-10-05', value: '1.75' },
      { date: '2026-10-04', value: '1.90' },
    ]);
    expect(result.change).toBe(-0.15);
  });

  it('не падает, если есть только одно значение', () => {
    const result = pickLatestObservations([
      { date: '2026-10-05', value: '1.75' },
      { date: '2026-10-04', value: '.' },
    ]);
    expect(result.value).toBe(1.75);
    expect(result.previousValue).toBeNull();
    expect(result.change).toBeNull();
  });

  it('возвращает null, когда числовых значений нет совсем', () => {
    expect(pickLatestObservations([{ value: '.' }, { value: '.' }])).toBeNull();
    expect(pickLatestObservations([])).toBeNull();
    expect(pickLatestObservations(undefined)).toBeNull();
  });

  it('не накапливает ошибку округления в изменении', () => {
    const result = pickLatestObservations([
      { date: '2026-10-05', value: '0.3' },
      { date: '2026-10-04', value: '0.1' },
    ]);
    expect(result.change).toBe(0.2); // без округления получилось бы 0.19999999999999998
  });
});

describe('describeRealYield', () => {
  it('отрицательная доходность — отдельный случай', () => {
    expect(describeRealYield({ value: -0.3, change: 0.1 })).toBe('negative');
  });

  it('видит рост и снижение', () => {
    expect(describeRealYield({ value: 1.9, change: 0.08 })).toBe('rising');
    expect(describeRealYield({ value: 1.9, change: -0.08 })).toBe('falling');
  });

  it('не объявляет движение на дневном шуме', () => {
    expect(describeRealYield({ value: 1.9, change: 0.01 })).toBe('stable');
    expect(describeRealYield({ value: 1.9, change: -0.02 })).toBe('stable');
  });

  it('без предыдущего значения считает фон спокойным', () => {
    expect(describeRealYield({ value: 1.9, change: null })).toBe('stable');
  });
});

describe('getRealYield', () => {
  beforeEach(() => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('запрашивает серию по убыванию даты', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ observations: [{ date: '2026-10-05', value: '1.9' }] }),
    });

    const result = await getRealYield();

    const url = fetch.mock.calls[0][0].toString();
    expect(url).toContain('series_id=DFII10');
    expect(url).toContain('sort_order=desc');
    expect(url).toContain('file_type=json');
    expect(result.seriesId).toBe('DFII10');
  });

  it('сообщает о недоступности при сетевом сбое', async () => {
    fetch.mockRejectedValue(new Error('network down'));
    await expect(getRealYield()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('сообщает о недоступности при ошибке HTTP', async () => {
    fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(getRealYield()).rejects.toBeInstanceOf(MacroError);
  });

  it('сообщает об отсутствии данных, если все наблюдения пустые', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ observations: [{ date: '2026-10-05', value: '.' }] }),
    });
    await expect(getRealYield()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});
