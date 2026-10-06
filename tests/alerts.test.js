import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage.js', () => ({
  getAlerts: vi.fn(async () => []),
  saveAlerts: vi.fn(async () => true),
  listAllAlerts: vi.fn(async () => []),
}));

const storage = await import('../lib/storage.js');
const {
  MAX_ALERTS_PER_CHAT,
  addAlert,
  collectTriggeredAlerts,
  createAlert,
  parseAlertPrice,
  shouldFire,
  splitAlerts,
} = await import('../lib/alerts.js');

afterEach(() => vi.clearAllMocks());

describe('parseAlertPrice', () => {
  it('принимает целое и дробное число', () => {
    expect(parseAlertPrice('2400')).toBe(2400);
    expect(parseAlertPrice('2400.55')).toBe(2400.55);
  });

  it('принимает запятую как десятичный разделитель', () => {
    expect(parseAlertPrice('2400,5')).toBe(2400.5);
  });

  it('не принимает мусор', () => {
    expect(parseAlertPrice('дорого')).toBeNull();
    expect(parseAlertPrice('')).toBeNull();
    expect(parseAlertPrice(undefined)).toBeNull();
    expect(parseAlertPrice('2400abc')).toBeNull();
  });

  it('отсекает значения вне разумных границ для золота', () => {
    expect(parseAlertPrice('24')).toBeNull();       // явная опечатка
    expect(parseAlertPrice('999999')).toBeNull();
    expect(parseAlertPrice('100')).toBe(100);       // граница включительно
  });

  it('не принимает отрицательные значения', () => {
    expect(parseAlertPrice('-2400')).toBeNull();
  });
});

describe('createAlert', () => {
  it('ставит направление вверх, если цель выше цены', () => {
    expect(createAlert(2400, 2350).direction).toBe('above');
  });

  it('ставит направление вниз, если цель ниже цены', () => {
    expect(createAlert(2300, 2350).direction).toBe('below');
  });

  it('отказывается создавать алерт на текущей цене', () => {
    expect(createAlert(2350, 2350)).toBeNull();
  });

  it('выдаёт уникальные идентификаторы', () => {
    const a = createAlert(2400, 2350);
    const b = createAlert(2400, 2350);
    expect(a.id).not.toBe(b.id);
  });
});

describe('shouldFire', () => {
  const up = { price: 2400, direction: 'above' };
  const down = { price: 2300, direction: 'below' };

  it('срабатывает при достижении уровня снизу', () => {
    expect(shouldFire(up, 2399.99)).toBe(false);
    expect(shouldFire(up, 2400)).toBe(true);
    expect(shouldFire(up, 2450)).toBe(true);
  });

  it('срабатывает при достижении уровня сверху', () => {
    expect(shouldFire(down, 2300.01)).toBe(false);
    expect(shouldFire(down, 2300)).toBe(true);
    expect(shouldFire(down, 2250)).toBe(true);
  });

  it('срабатывает на гэпе, перепрыгнувшем уровень', () => {
    // После выходных цена может открыться сразу выше цели.
    expect(shouldFire(up, 2500)).toBe(true);
  });

  it('не срабатывает на некорректной цене', () => {
    expect(shouldFire(up, Number.NaN)).toBe(false);
  });
});

describe('splitAlerts', () => {
  it('делит список на сработавшие и оставшиеся', () => {
    const items = [
      { price: 2400, direction: 'above' },
      { price: 2500, direction: 'above' },
      { price: 2300, direction: 'below' },
    ];
    const { fired, remaining } = splitAlerts(items, 2420);

    expect(fired).toHaveLength(1);
    expect(fired[0].price).toBe(2400);
    expect(remaining).toHaveLength(2);
  });

  it('на пустом списке возвращает пустые наборы', () => {
    expect(splitAlerts([], 2400)).toEqual({ fired: [], remaining: [] });
  });
});

describe('addAlert', () => {
  it('сохраняет новый алерт', async () => {
    storage.getAlerts.mockResolvedValueOnce([]);
    const result = await addAlert(42, 2400, 2350);

    expect(result.ok).toBe(true);
    expect(storage.saveAlerts).toHaveBeenCalledWith(42, [expect.objectContaining({ price: 2400 })]);
  });

  it('не превышает лимит на чат', async () => {
    storage.getAlerts.mockResolvedValueOnce(
      Array.from({ length: MAX_ALERTS_PER_CHAT }, () => ({ price: 2400, direction: 'above' })),
    );

    const result = await addAlert(42, 2500, 2350);

    expect(result).toEqual({ ok: false, reason: 'limit' });
    expect(storage.saveAlerts).not.toHaveBeenCalled();
  });

  it('сообщает, если цель совпала с текущей ценой', async () => {
    storage.getAlerts.mockResolvedValueOnce([]);
    expect(await addAlert(42, 2350, 2350)).toEqual({ ok: false, reason: 'same_price' });
  });

  it('сообщает о сбое хранилища', async () => {
    storage.getAlerts.mockResolvedValueOnce([]);
    storage.saveAlerts.mockResolvedValueOnce(false);
    expect(await addAlert(42, 2400, 2350)).toEqual({ ok: false, reason: 'storage' });
  });
});

describe('collectTriggeredAlerts', () => {
  it('собирает срабатывания по всем чатам', async () => {
    storage.listAllAlerts.mockResolvedValueOnce([
      { chatId: 1, items: [{ id: 'a', price: 2400, direction: 'above' }] },
      { chatId: 2, items: [{ id: 'b', price: 2500, direction: 'above' }] },
    ]);

    const triggered = await collectTriggeredAlerts(2450);

    expect(triggered).toHaveLength(1);
    expect(triggered[0].chatId).toBe(1);
  });

  it('удаляет сработавшие алерты и сохраняет остальные', async () => {
    storage.listAllAlerts.mockResolvedValueOnce([
      {
        chatId: 1,
        items: [
          { id: 'a', price: 2400, direction: 'above' },
          { id: 'b', price: 2600, direction: 'above' },
        ],
      },
    ]);

    await collectTriggeredAlerts(2450);

    expect(storage.saveAlerts).toHaveBeenCalledWith(1, [
      expect.objectContaining({ id: 'b' }),
    ]);
  });

  it('не уведомляет повторно, если запись в хранилище не удалась', async () => {
    // Иначе на следующем запуске тот же алерт сработал бы снова.
    storage.listAllAlerts.mockResolvedValueOnce([
      { chatId: 1, items: [{ id: 'a', price: 2400, direction: 'above' }] },
    ]);
    storage.saveAlerts.mockResolvedValueOnce(false);

    expect(await collectTriggeredAlerts(2450)).toHaveLength(0);
  });

  it('ничего не делает, когда алертов нет', async () => {
    storage.listAllAlerts.mockResolvedValueOnce([]);
    expect(await collectTriggeredAlerts(2450)).toEqual([]);
    expect(storage.saveAlerts).not.toHaveBeenCalled();
  });
});
