import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = { settings: null, positions: [] };

vi.mock('../lib/storage.js', () => ({
  getTradingSettings: vi.fn(async () => store.settings),
  saveTradingSettings: vi.fn(async (s) => { store.settings = s; return true; }),
  getPositions: vi.fn(async () => store.positions),
  savePositions: vi.fn(async (items) => { store.positions = items; return true; }),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

const { ROLES, issueToken } = await import('../lib/auth.js');
const tradingFn = (await import('../netlify/functions/trading.mjs')).default;

const SECRET = 'секрет';
const tokenFor = (role) => issueToken({ login: 'tg1', role }, SECRET);

const get = (token) =>
  new Request('https://x/api/trading', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const post = (token, body) =>
  new Request('https://x/api/trading', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  store.settings = null;
  store.positions = [];
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('TWELVE_DATA_API_KEY', 'key');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ price: '4100' }) })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('доступ', () => {
  it('гостю отказано', async () => {
    expect((await tradingFn(get())).status).toBe(401);
  });

  it('пользователь видит журнал', async () => {
    const response = await tradingFn(get(tokenFor(ROLES.USER)));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.stats).toBeDefined();
    expect(body.canEdit).toBe(false);
  });

  it('пользователь не может менять настройки', async () => {
    const response = await tradingFn(post(tokenFor(ROLES.USER), { settings: { enabled: true } }));
    expect(response.status).toBe(403);
  });

  it('администратор тоже не может — торговля это деньги владельца', async () => {
    const response = await tradingFn(post(tokenFor(ROLES.ADMIN), { settings: { enabled: true } }));
    expect(response.status).toBe(403);
  });

  it('владелец может', async () => {
    const response = await tradingFn(post(tokenFor(ROLES.OWNER), { settings: { enabled: true } }));
    expect(response.status).toBe(200);
    expect((await response.json()).settings.enabled).toBe(true);
  });
});

describe('настройки', () => {
  it('по умолчанию торговля выключена', async () => {
    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();
    expect(body.settings.enabled).toBe(false);
  });

  it('сохранённые настройки возвращаются', async () => {
    await tradingFn(post(tokenFor(ROLES.OWNER), { settings: { deposit: 5000, riskPercent: 2 } }));
    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();

    expect(body.settings.deposit).toBe(5000);
    expect(body.settings.riskPercent).toBe(2);
  });

  it('мусор в настройках не проходит', async () => {
    await tradingFn(post(tokenFor(ROLES.OWNER), { settings: { deposit: -999, lot: 'много' } }));
    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();

    expect(body.settings.deposit).toBeGreaterThan(0);
    expect(body.settings.lot).toBe(0.1);
  });
});

describe('журнал', () => {
  const closed = (pnl) => ({
    id: String(Math.random()), strategy: 'fvgRetest', direction: 'bullish',
    status: 'closed', pnlMoney: pnl, pnlPoints: pnl / 10, entry: 4100, closePrice: 4110,
  });

  it('считает статистику по закрытым сделкам', async () => {
    store.positions = [closed(100), closed(-50), closed(200)];

    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();

    expect(body.stats.total).toBe(3);
    expect(body.stats.wins).toBe(2);
    expect(body.stats.pnlMoney).toBe(250);
  });

  it('у открытых позиций показывает плавающий результат', async () => {
    store.positions = [{
      id: 'a', strategy: 'fvgRetest', direction: 'bullish',
      status: 'open', entry: 4000, lot: 0.1,
    }];

    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();
    // Цена 4100, вход 4000 → сто пунктов в плюс.
    expect(body.positions[0].floating.pnlMoney).toBe(100 * 0.1 * 100);
  });

  it('свежие сделки идут первыми', async () => {
    store.positions = [closed(1), closed(2), closed(3)];
    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();
    expect(body.positions[0].pnlMoney).toBe(3);
  });

  it('владелец может очистить журнал', async () => {
    store.positions = [closed(100)];
    await tradingFn(post(tokenFor(ROLES.OWNER), { action: 'reset' }));

    expect(store.positions).toEqual([]);
  });

  it('журнал отдаётся даже без цены', async () => {
    // Поставщик данных мог отвалиться — это не повод прятать историю.
    fetch.mockRejectedValue(new Error('сеть'));
    store.positions = [closed(100)];

    const body = await (await tradingFn(get(tokenFor(ROLES.OWNER)))).json();
    expect(body.price).toBeNull();
    expect(body.stats.total).toBe(1);
  });
});
