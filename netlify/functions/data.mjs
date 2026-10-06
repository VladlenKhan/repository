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
import { ROLES, verifyToken } from '../../lib/auth.js';
import { collectAdminData } from '../../lib/admin.js';
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
      market: full.market,
      macro: full.macro,
      errors: full.errors.filter((e) => ['market', 'macro'].includes(e.section)),
    };

    if (session.role !== ROLES.ADMIN) {
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
      errors: full.errors,
    });
  } catch (error) {
    console.error('[data] сбой сбора данных:', error);
    return json({ error: 'Не удалось собрать данные' }, 500);
  }
};

export const config = { path: '/api/data' };
