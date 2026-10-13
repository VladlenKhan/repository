import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Аккаунты в памяти вместо Blobs. */
const accounts = new Map();

vi.mock('../lib/storage.js', () => ({
  getAccount: vi.fn(async (login) => accounts.get(login) ?? null),
  saveAccount: vi.fn(async (account) => {
    accounts.set(account.login, account);
    return true;
  }),
  listAccounts: vi.fn(async () => [...accounts.values()]),
  deletePerson: vi.fn(async (id) => {
    accounts.delete(`tg${id}`);
    return { removed: ['accounts'], failed: [] };
  }),
  listUsers: vi.fn(async () => [{ chatId: 1, lang: 'ru', updatedAt: '2026-10-06T17:00:00Z' }]),
  listSubscribers: vi.fn(async () => [{ chatId: 1, lang: 'ru' }]),
  listAllAlerts: vi.fn(async () => [
    { chatId: 1, items: [{ id: 'a', price: 4200, direction: 'above', createdAt: '2026-10-06T17:42:00Z' }] },
  ]),
  pingStorage: vi.fn(async () => ({ ok: true })),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

vi.mock('../lib/telegram.js', () => ({
  createApi: () => ({
    getWebhookInfo: vi.fn(async () => ({ url: 'https://x/api/bot', pending_update_count: 0 })),
  }),
}));

const { ROLES, hasAtLeast } = await import('../lib/auth.js');
const authFn = (await import('../netlify/functions/auth.mjs')).default;
const dataFn = (await import('../netlify/functions/data.mjs')).default;
const peopleFn = (await import('../netlify/functions/people.mjs')).default;

const BOT_TOKEN = '1:T';
const OWNER_TG = 1345915209;

/** Подписывает данные так же, как Telegram. */
function signInitData(user, token = BOT_TOKEN) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  };
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const post = (url, body, token) =>
  new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const dataRequest = (token) =>
  new Request('https://x/api/data', { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** Входит через Telegram и возвращает ответ. */
const login = (user) => authFn(post('https://x/api/auth', { initData: signInitData(user) }));

const OWNER = { id: OWNER_TG, first_name: 'Влад', username: 'vlad' };
const VASYA = { id: 424242, first_name: 'Вася', username: 'vasya' };

beforeEach(() => {
  accounts.clear();
  vi.stubEnv('SESSION_SECRET', 'секрет-подписи');
  vi.stubEnv('OWNER_TELEGRAM_ID', String(OWNER_TG));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN);
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 's');
  vi.stubEnv('TWELVE_DATA_API_KEY', 'key');
  vi.stubEnv('FRED_API_KEY', 'fred');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('иерархия ролей', () => {
  it('владелец выше администратора, тот выше пользователя', () => {
    expect(hasAtLeast(ROLES.OWNER, ROLES.ADMIN)).toBe(true);
    expect(hasAtLeast(ROLES.ADMIN, ROLES.USER)).toBe(true);
    expect(hasAtLeast(ROLES.USER, ROLES.ADMIN)).toBe(false);
    expect(hasAtLeast(ROLES.GUEST, ROLES.USER)).toBe(false);
  });

  it('роль сама себе достаточна', () => {
    expect(hasAtLeast(ROLES.ADMIN, ROLES.ADMIN)).toBe(true);
  });

  it('неизвестная роль не даёт прав', () => {
    expect(hasAtLeast('superuser', ROLES.USER)).toBe(false);
  });
});

describe('вход через Telegram', () => {
  it('владелец получает роль owner', async () => {
    const body = await (await login(OWNER)).json();
    expect(body.account.role).toBe('owner');
  });

  it('новый пользователь получает роль user', async () => {
    const body = await (await login(VASYA)).json();
    expect(body.account.role).toBe('user');
  });

  it('имя пользователя Telegram попадает в аккаунт', async () => {
    const body = await (await login(VASYA)).json();
    expect(body.account.displayName).toBe('@vasya');
  });

  it('подмена Telegram ID не проходит', async () => {
    const tampered = signInitData(VASYA).replace('424242', String(OWNER_TG));
    const response = await authFn(post('https://x/api/auth', { initData: tampered }));
    expect(response.status).toBe(401);
  });

  it('подпись чужим токеном не проходит', async () => {
    const forged = signInitData(OWNER, '999:ЧУЖОЙ');
    expect((await authFn(post('https://x/api/auth', { initData: forged }))).status).toBe(401);
  });

  it('паролей в системе нет — вход по логину и паролю не работает', async () => {
    const response = await authFn(post('https://x/api/auth', { login: 'vlad', password: 'что-угодно' }));
    expect(response.status).toBe(401);
  });

  it('повторный вход не плодит аккаунты', async () => {
    await login(VASYA);
    await login(VASYA);
    expect(accounts.size).toBe(1);
  });

  it('в аккаунте не хранится пароль', async () => {
    await login(VASYA);
    const saved = accounts.get('tg424242');
    expect(saved.passwordHash).toBeUndefined();
    expect(saved.password).toBeUndefined();
  });
});

describe('назначение ролей', () => {
  it('владелец делает пользователя администратором', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);

    const response = await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));

    expect(response.status).toBe(200);
    expect(accounts.get('tg424242').role).toBe('admin');
  });

  it('повышенный пользователь входит уже администратором', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));

    const body = await (await login(VASYA)).json();
    expect(body.account.role).toBe('admin');
  });

  it('администратор не может назначать роли', async () => {
    // Иначе админ повысил бы себя или понизил других.
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));
    const adminToken = (await (await login(VASYA)).json()).token;

    const response = await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'user' }, adminToken));
    expect(response.status).toBe(403);
  });

  it('обычный пользователь не может назначать роли', async () => {
    const userToken = (await (await login(VASYA)).json()).token;
    const response = await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, userToken));
    expect(response.status).toBe(403);
  });

  it('гость не может назначать роли', async () => {
    expect((await peopleFn(post('https://x/api/people', { login: 'tg1', role: 'admin' }))).status).toBe(401);
  });

  it('роль владельца изменить нельзя', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    const response = await peopleFn(post('https://x/api/people', { login: `tg${OWNER_TG}`, role: 'user' }, ownerToken));

    expect(response.status).toBe(400);
    expect(accounts.get(`tg${OWNER_TG}`).role).toBe('owner');
  });

  it('роль owner назначить нельзя никому', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);

    const response = await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'owner' }, ownerToken));
    expect(response.status).toBe(400);
  });

  it('роль владельца не берётся из базы', async () => {
    // Даже если в хранилище подменить роль, окружение её перебьёт.
    await login(OWNER);
    accounts.set(`tg${OWNER_TG}`, { ...accounts.get(`tg${OWNER_TG}`), role: 'user' });

    const body = await (await login(OWNER)).json();
    expect(body.account.role).toBe('owner');
  });
});

describe('вход по ссылке из бота', () => {
  it('код обменивается на сессию', async () => {
    await login(VASYA);
    const { createLoginLink } = await import('../lib/accounts.js');

    const link = await createLoginLink(VASYA, 'https://example.app');
    const code = link.split('#login=')[1];

    const response = await authFn(post('https://x/api/auth', { loginCode: code }));
    expect(response.status).toBe(200);
    expect((await response.json()).account.role).toBe('user');
  });

  it('владелец получает роль owner и по ссылке', async () => {
    await login(OWNER);
    const { createLoginLink } = await import('../lib/accounts.js');

    const link = await createLoginLink(OWNER, 'https://example.app');
    const body = await (await authFn(post('https://x/api/auth', { loginCode: link.split('#login=')[1] }))).json();

    expect(body.account.role).toBe('owner');
  });

  it('аккаунт создаётся сразу, если его ещё не было', async () => {
    // Иначе получался бы замкнутый круг: ссылка нужна для входа,
    // а аккаунт — для ссылки.
    const { createLoginLink } = await import('../lib/accounts.js');

    const link = await createLoginLink({ id: 555000, username: 'novichok' }, 'https://example.app');

    expect(link).toContain('#login=');
    expect(accounts.get('tg555000').displayName).toBe('@novichok');
  });

  it('код из ссылки нельзя использовать как сессию', async () => {
    // Иначе короткоживущий код работал бы как полноценный доступ.
    await login(VASYA);
    const { createLoginLink } = await import('../lib/accounts.js');
    const code = (await createLoginLink(VASYA, 'https://example.app')).split('#login=')[1];

    expect((await dataFn(dataRequest(code))).status).toBe(401);
  });

  it('сессию нельзя предъявить как код из ссылки', async () => {
    const token = (await (await login(VASYA)).json()).token;
    const response = await authFn(post('https://x/api/auth', { loginCode: token }));
    expect(response.status).toBe(401);
  });

  it('подделанный код не проходит', async () => {
    await login(VASYA);
    const { issueLoginCode } = await import('../lib/auth.js');
    const forged = issueLoginCode({ login: 'tg424242', role: 'owner' }, 'чужой-секрет');

    expect((await authFn(post('https://x/api/auth', { loginCode: forged }))).status).toBe(401);
  });

  it('роль из кода не повышает права', async () => {
    // Даже если код выпущен с ролью owner, итоговая роль берётся
    // из аккаунта и окружения, а не из самого кода.
    await login(VASYA);
    const { issueLoginCode } = await import('../lib/auth.js');
    const code = issueLoginCode({ login: 'tg424242', role: 'owner' }, 'секрет-подписи');

    const body = await (await authFn(post('https://x/api/auth', { loginCode: code }))).json();
    expect(body.account.role).toBe('user');
  });
});

describe('доступ к данным по ролям', () => {
  it('гостю отказано', async () => {
    expect((await dataFn(dataRequest())).status).toBe(401);
  });

  it('пользователь видит рынок, но не чужие данные', async () => {
    const token = (await (await login(VASYA)).json()).token;
    const body = await (await dataFn(dataRequest(token))).json();

    expect(body).toHaveProperty('market');
    for (const key of ['users', 'alerts', 'accounts', 'subscribers', 'usage', 'webhook']) {
      expect(body[key]).toBeUndefined();
    }
  });

  it('чужие данные не уезжают в браузер пользователя', async () => {
    const token = (await (await login(VASYA)).json()).token;
    const raw = await (await dataFn(dataRequest(token))).text();
    expect(raw).not.toContain('chatId');
  });

  it('администратор видит пользователей и систему', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));
    const adminToken = (await (await login(VASYA)).json()).token;

    const body = await (await dataFn(dataRequest(adminToken))).json();
    expect(body.users).toBeDefined();
    expect(body.alerts).toBeDefined();
  });

  it('администратор не получает права на смену ролей', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));
    const adminToken = (await (await login(VASYA)).json()).token;

    const body = await (await dataFn(dataRequest(adminToken))).json();
    expect(body.canManageRoles).toBe(false);
  });

  it('владелец получает права на смену ролей', async () => {
    const token = (await (await login(OWNER)).json()).token;
    const body = await (await dataFn(dataRequest(token))).json();
    expect(body.canManageRoles).toBe(true);
  });

  it('смена секрета подписи аннулирует сессии', async () => {
    const token = (await (await login(VASYA)).json()).token;
    vi.stubEnv('SESSION_SECRET', 'новый-секрет');
    expect((await dataFn(dataRequest(token))).status).toBe(401);
  });
});

describe('удаление человека', () => {
  /** Отдельное хранилище: удаление чистит сразу несколько стораджей. */
  const removed = [];

  it('владелец удаляет пользователя', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    expect(accounts.has('tg424242')).toBe(true);

    const response = await peopleFn(
      post('https://x/api/people', { action: 'delete', telegramId: 424242 }, ownerToken),
    );

    expect(response.status).toBe(200);
  });

  it('администратор удалять не может', async () => {
    // Иначе один администратор мог бы вычистить других.
    const ownerToken = (await (await login(OWNER)).json()).token;
    await login(VASYA);
    await peopleFn(post('https://x/api/people', { login: 'tg424242', role: 'admin' }, ownerToken));
    const adminToken = (await (await login(VASYA)).json()).token;

    const response = await peopleFn(
      post('https://x/api/people', { action: 'delete', telegramId: 777 }, adminToken),
    );
    expect(response.status).toBe(403);
  });

  it('гость удалять не может', async () => {
    const response = await peopleFn(post('https://x/api/people', { action: 'delete', telegramId: 777 }));
    expect(response.status).toBe(401);
  });

  it('владельца удалить нельзя', async () => {
    // Роль задана окружением: запись пересоздалась бы при входе,
    // а подписки и уведомления пропали бы без причины.
    const ownerToken = (await (await login(OWNER)).json()).token;

    const response = await peopleFn(
      post('https://x/api/people', { action: 'delete', telegramId: OWNER_TG }, ownerToken),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Владельца');
  });

  it('некорректный идентификатор отвергается', async () => {
    const ownerToken = (await (await login(OWNER)).json()).token;

    for (const bad of [null, 'мусор', undefined]) {
      const response = await peopleFn(
        post('https://x/api/people', { action: 'delete', telegramId: bad }, ownerToken),
      );
      expect(response.status).toBe(400);
    }
  });
});
