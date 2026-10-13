/**
 * Данные для панели с учётом роли.
 *
 * Гость не получает ничего, пользователь — рыночные данные,
 * администратор — всё, включая аккаунты, пользователей бота
 * и их уведомления.
 *
 * Фильтрация делается на сервере, а не в браузере: иначе чужие данные
 * уезжали бы клиенту и их было бы видно в инструментах разработчика.
 */
import { ROLES, hasAtLeast, verifyToken } from '../../lib/auth.js';
import { collectAdminData, mergePeople } from '../../lib/admin.js';
import { ConfigError, getSessionSecret } from '../../lib/config.js';
import { listAccounts } from '../../lib/storage.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Токен приходит в заголовке: он всегда из base64url, то есть латиница. */
function extractToken(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export default async (request) => {
  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  const session = verifyToken(extractToken(request), secret);
  if (!session) {
    return json({ error: 'Нужно войти' }, 401);
  }

  try {
    const full = await collectAdminData();

    // Общая часть: рынок и макрофон видят все, кто вошёл.
    const payload = {
      generatedAt: full.generatedAt,
      role: session.role,
      login: session.login,
      // Имя для шапки: иначе там остаётся технический логин вида tg123.
      displayName: (await listAccounts()).find((a) => a.login === session.login)?.displayName
        ?? session.login,
      market: full.market,
      macro: full.macro,
      errors: full.errors.filter((e) => ['market', 'macro'].includes(e.section)),
    };

    // Раздел с персональными данными — от администратора и выше.
    if (!hasAtLeast(session.role, ROLES.ADMIN)) {
      return json(payload);
    }

    // Админская часть.
    return json({
      ...payload,
      storage: full.storage,
      users: full.users,
      subscribers: full.subscribers,
      alerts: full.alerts,
      usage: full.usage,
      webhook: full.webhook,
      accounts: await listAccounts(),
      // Один список вместо двух: это одни и те же люди.
      people: mergePeople({
        users: full.users,
        accounts: await listAccounts(),
        subscribers: full.subscribers,
        alerts: full.alerts,
      }),
      // Назначать роли может только владелец — панель рисует кнопки
      // по этому признаку, но решение всё равно принимает сервер.
      canManageRoles: session.role === ROLES.OWNER,
      errors: full.errors,
    });
  } catch (error) {
    console.error('[data] сбой сбора данных:', error);
    return json({ error: 'Не удалось собрать данные' }, 500);
  }
};

export const config = { path: '/api/data' };
