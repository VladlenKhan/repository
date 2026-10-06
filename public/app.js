/* ===========================================================================
   Логика сайта: вход, роли и автообновление панели.

   Без фреймворков — HTML собирается строками, состояние лежит в одном
   объекте. Токен сессии хранится в localStorage, чтобы вход переживал
   перезагрузку страницы.
   =========================================================================== */

import { initChart, setChartToken, stopChart } from './chart.js';

const API_AUTH = '/api/auth';
const API_DATA = '/api/data';
const TOKEN_KEY = 'aurum-token';

/** Как часто панель перезапрашивает данные. */
const REFRESH_MS = 20000;

const $ = (id) => document.getElementById(id);

/** Единое состояние вместо разбросанных переменных. */
const state = {
  token: null,
  account: null,
  mode: 'login',
  timer: null,
  lastUpdate: null,
  tickTimer: null,
};

/* ======================= Хранение токена ======================= */

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Приватный режим браузера может запрещать доступ к хранилищу.
    return null;
  }
}

function writeToken(value) {
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* Не критично: вход просто не переживёт перезагрузку. */
  }
}

/* ======================= Переключение экранов ======================= */

function show(view) {
  for (const id of ['public-view', 'auth-view', 'panel-view']) {
    $(id).classList.toggle('hidden', id !== view);
  }
  window.scrollTo(0, 0);
}

/* ======================= Шапка с аккаунтом ======================= */

function renderAccount() {
  const area = $('account-area');

  if (!state.account) {
    area.innerHTML = '<button class="btn btn-sm" id="open-auth">Войти</button>';
    $('open-auth').addEventListener('click', () => openAuth('login'));
    return;
  }

  const isAdmin = state.account.role === 'admin';
  area.innerHTML = `
    <span class="user-name">${esc(state.account.login)}</span>
    <span class="role ${isAdmin ? 'role-admin' : 'role-user'}">${isAdmin ? 'Админ' : 'Пользователь'}</span>
    <button class="btn btn-sm" id="go-panel">Панель</button>
    <button class="btn btn-sm" id="logout">Выйти</button>`;

  $('go-panel').addEventListener('click', openPanel);
  $('logout').addEventListener('click', logout);
}

/* ======================= Вход и регистрация ======================= */

function openAuth(mode) {
  state.mode = mode;
  syncAuthMode();
  $('auth-error').textContent = '';
  show('auth-view');
  $('login').focus();
}

/** Приводит форму в соответствие выбранной вкладке. */
function syncAuthMode() {
  const isRegister = state.mode === 'register';

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.mode === state.mode);
  }

  $('submit-auth').textContent = isRegister ? 'Создать аккаунт' : 'Войти';
  $('auth-note').textContent = isRegister
    ? 'Создайте аккаунт, чтобы видеть рыночные данные.'
    : 'Войдите, чтобы видеть рыночные данные.';
  $('auth-hint').classList.toggle('hidden', !isRegister);
  $('password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
}

async function submitAuth() {
  const login = $('login').value.trim();
  const password = $('password').value;
  const button = $('submit-auth');

  if (!login || !password) {
    $('auth-error').textContent = 'Заполните оба поля';
    return;
  }

  button.disabled = true;
  button.textContent = 'Подождите…';
  $('auth-error').textContent = '';

  try {
    const response = await fetch(API_AUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: state.mode, login, password }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      $('auth-error').textContent = body.error ?? 'Не удалось войти';
      return;
    }

    state.token = body.token;
    state.account = body.account;
    writeToken(body.token);
    setChartToken(body.token);

    $('password').value = '';
    renderAccount();
    openPanel();
  } catch {
    $('auth-error').textContent = 'Сеть недоступна';
  } finally {
    button.disabled = false;
    syncAuthMode();
  }
}

function logout() {
  stopAutoRefresh();
  stopChart();
  state.token = null;
  state.account = null;
  writeToken(null);
  renderAccount();
  show('public-view');
}

/* ======================= Панель ======================= */

function openPanel() {
  show('panel-view');
  load();
  startAutoRefresh();
  initChart(state.token);
}

/**
 * Автообновление.
 *
 * Когда вкладка скрыта, опрос останавливается: обновлять то, чего никто
 * не видит, — впустую тратить запросы. При возвращении данные
 * подтягиваются сразу, без ожидания следующего интервала.
 */
function startAutoRefresh() {
  stopAutoRefresh();
  state.timer = setInterval(load, REFRESH_MS);
  state.tickTimer = setInterval(renderAge, 1000);
}

function stopAutoRefresh() {
  clearInterval(state.timer);
  clearInterval(state.tickTimer);
  state.timer = null;
  state.tickTimer = null;
}

document.addEventListener('visibilitychange', () => {
  const onPanel = !$('panel-view').classList.contains('hidden');
  if (!onPanel || !state.token) return;

  if (document.hidden) {
    stopAutoRefresh();
    stopChart();
  } else {
    load();
    startAutoRefresh();
    initChart(state.token);
  }
});

/** Надпись «обновлено N секунд назад», пересчитывается каждую секунду. */
function renderAge() {
  if (state.lastUpdate === null) return;

  const seconds = Math.round((Date.now() - state.lastUpdate) / 1000);
  $('updated-at').textContent =
    seconds < 5 ? 'данные актуальны' : `обновлено ${seconds} ${plural(seconds)} назад`;
}

function plural(n) {
  const last = n % 10;
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return 'секунд';
  if (last === 1) return 'секунду';
  if (last >= 2 && last <= 4) return 'секунды';
  return 'секунд';
}

async function load() {
  if (!state.token) return;

  let response;
  try {
    response = await fetch(API_DATA, { headers: { authorization: `Bearer ${state.token}` } });
  } catch {
    $('panel-error').textContent = 'Сеть недоступна, следующая попытка через 20 секунд';
    return;
  }

  if (response.status === 401) {
    // Сессия истекла или секрет подписи сменился — просим войти заново.
    stopAutoRefresh();
    stopChart();
    writeToken(null);
    state.token = null;
    state.account = null;
    renderAccount();
    openAuth('login');
    $('auth-error').textContent = 'Сессия истекла, войдите заново';
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $('panel-error').textContent = body.error ?? `Ошибка сервера (${response.status})`;
    return;
  }

  $('panel-error').textContent = '';
  render(await response.json());
}

/* ======================= Вспомогательные ======================= */

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

/** Экранирование: часть данных приходит от пользователей. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const dt = (ms) =>
  ms ? new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function statCard(label, value, sub = '', extra = '') {
  return `<div class="card stat">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
    ${extra}
  </div>`;
}

const dot = (s) => `<span class="dot dot-${s}"></span>`;

/** Подставляет разметку и мягко подсвечивает обновление. */
function put(id, html) {
  const node = $(id);
  node.innerHTML = html;
  node.classList.remove('fade-in');
  void node.offsetWidth; // перезапуск анимации
  node.classList.add('fade-in');
}

/* ======================= Отрисовка ======================= */

function render(data) {
  state.lastUpdate = Date.now();
  renderAge();

  // Роль могла измениться — обновляем шапку по данным сервера.
  if (state.account && data.role && state.account.role !== data.role) {
    state.account.role = data.role;
    renderAccount();
  }

  renderMarket(data);

  const isAdmin = data.role === 'admin';
  $('admin-only').classList.toggle('hidden', !isAdmin);

  if (isAdmin) {
    renderHealth(data);
    renderAlerts(data.alerts ?? []);
    renderBotUsers(data);
    renderAccounts(data.accounts ?? []);
  }

  if (data.errors?.length) {
    $('panel-error').textContent =
      'Недоступны разделы — ' + data.errors.map((e) => `${esc(e.section)}: ${esc(e.error)}`).join('; ');
  }
}

function renderMarket(data) {
  const market = data.market;

  if (!market) {
    put('market', statCard('Рынок', '—', 'данные недоступны'));
    put('pivots-table', '');
    return;
  }

  const trendText = { up: 'восходящий', down: 'нисходящий', flat: 'боковик', unknown: 'не определён' };
  const trendClass = market.trend === 'up' ? 'up' : market.trend === 'down' ? 'down' : '';
  const names = { asia: 'Азия', london: 'Лондон', newyork: 'Нью-Йорк' };
  const sessions = market.sessions.length ? market.sessions.map((s) => names[s] ?? s).join(' + ') : 'затишье';

  put('market', [
    statCard(esc(market.symbol), num(market.price), `свеча от ${dt(market.candleTime)}${market.marketOpen ? '' : ' · рынок закрыт'}`),
    statCard('Тренд', `<span class="${trendClass}">${trendText[market.trend]}</span>`,
      `EMA 50 / 200: ${num(market.indicators.ema50)} / ${num(market.indicators.ema200)}`),
    statCard('RSI(14)', num(market.indicators.rsi14, 1), `ATR(14): ${num(market.indicators.atr14)}`),
    statCard('Сессия', sessions, market.marketOpen ? 'торги идут' : 'торги закрыты'),
  ].join(''));

  if (!market.pivots) return;

  const rows = ['r3', 'r2', 'r1', 'pp', 's1', 's2', 's3']
    .map((key) => {
      const value = market.pivots[key];
      const above = value > market.price;
      const diff = value - market.price;
      return `<tr>
        <td class="mono">${key.toUpperCase()}</td>
        <td class="mono">${num(value)}</td>
        <td class="mono ${above ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${num(diff)}</td>
        <td class="muted">${above ? 'сопротивление' : 'поддержка'}</td>
      </tr>`;
    })
    .join('');

  put('pivots-table', `<thead><tr><th>Уровень</th><th>Цена</th><th>От текущей</th><th></th></tr></thead><tbody>${rows}</tbody>`);
}

function renderHealth(data) {
  const cards = [];

  if (data.usage) {
    const { dailyUsed, dailyLimit, minuteUsed, minuteLimit, plan } = data.usage;
    const percent = dailyLimit ? Math.round((dailyUsed / dailyLimit) * 100) : 0;
    const level = percent > 85 ? 'high' : percent > 60 ? 'mid' : '';
    cards.push(statCard('Кредиты Twelve Data', `${dailyUsed} / ${dailyLimit}`,
      `${percent}% дневного лимита · тариф ${esc(plan ?? '—')} · ${minuteUsed}/${minuteLimit} в минуту`,
      `<div class="bar"><div class="bar-fill ${level}" style="width:${Math.min(percent, 100)}%"></div></div>`));
  } else {
    cards.push(statCard('Кредиты Twelve Data', '—', 'данные недоступны'));
  }

  if (data.webhook) {
    const bad = Boolean(data.webhook.lastError);
    cards.push(statCard('Вебхук Telegram', `${dot(bad ? 'bad' : 'ok')}${bad ? 'ошибка' : 'работает'}`,
      bad ? `${esc(data.webhook.lastError)} · ${dt(data.webhook.lastErrorAt)}` : `в очереди ${data.webhook.pending} апдейтов`));
  } else {
    cards.push(statCard('Вебхук Telegram', `${dot('bad')}недоступен`));
  }

  cards.push(statCard('Хранилище', `${dot(data.storage?.ok ? 'ok' : 'bad')}${data.storage?.ok ? 'доступно' : 'ошибка'}`,
    data.storage?.ok ? 'чтение и запись' : esc(data.storage?.error ?? '')));

  if (data.macro) {
    cards.push(statCard('Реальная доходность', `${num(data.macro.value)}%`,
      `${esc(data.macro.seriesId)} · на ${esc(data.macro.date)}` +
      (data.macro.change === null ? '' : ` · ${data.macro.change > 0 ? '+' : ''}${data.macro.change} п.п.`)));
  }

  put('health', cards.join(''));
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    put('alerts-table', '<tbody><tr><td class="muted">Активных уведомлений нет</td></tr></tbody>');
    return;
  }

  const rows = alerts.map((a) => `<tr>
    <td class="mono">${esc(a.chatId)}</td>
    <td>${a.direction === 'above' ? '🔼 вверх' : '🔽 вниз'}</td>
    <td class="mono">${num(a.price)}</td>
    <td class="mono ${a.distance > 0 ? 'up' : 'down'}">${a.distance === null ? '—' : `${a.distance > 0 ? '+' : ''}${num(a.distance)}`}</td>
    <td class="mono muted">${a.distancePercent === null ? '—' : `${num(a.distancePercent)}%`}</td>
    <td class="muted">${dt(Date.parse(a.createdAt))}</td>
  </tr>`).join('');

  put('alerts-table', `<thead><tr><th>Чат</th><th>Направление</th><th>Уровень</th><th>До цели</th><th>%</th><th>Создан</th></tr></thead><tbody>${rows}</tbody>`);
}

function renderBotUsers(data) {
  const users = data.users ?? [];
  const subscribed = new Set((data.subscribers ?? []).map((s) => s.chatId));

  if (!users.length) {
    put('users-table', '<tbody><tr><td class="muted">Пользователей пока нет</td></tr></tbody>');
    return;
  }

  const rows = users.map((u) => `<tr>
    <td class="mono">${esc(u.chatId)}</td>
    <td>${u.lang === 'en' ? '🇬🇧 English' : '🇷🇺 Русский'}</td>
    <td>${subscribed.has(u.chatId) ? '✅ подписан' : '—'}</td>
    <td class="muted">${dt(Date.parse(u.updatedAt))}</td>
  </tr>`).join('');

  put('users-table',
    `<thead><tr><th>Чат</th><th>Язык</th><th>Сводка</th><th>Активность</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><td colspan="4" class="muted">Всего ${users.length}, подписано ${subscribed.size}</td></tr></tfoot>`);
}

function renderAccounts(accounts) {
  if (!accounts.length) {
    put('accounts-table', '<tbody><tr><td class="muted">Зарегистрированных аккаунтов нет</td></tr></tbody>');
    return;
  }

  const rows = accounts.map((a) => `<tr>
    <td>${esc(a.login)}</td>
    <td><span class="role role-${a.role === 'admin' ? 'admin' : 'user'}">${a.role === 'admin' ? 'Админ' : 'Пользователь'}</span></td>
    <td class="muted">${dt(Date.parse(a.createdAt))}</td>
    <td class="muted">${dt(Date.parse(a.lastLoginAt))}</td>
  </tr>`).join('');

  put('accounts-table',
    `<thead><tr><th>Логин</th><th>Роль</th><th>Регистрация</th><th>Последний вход</th></tr></thead><tbody>${rows}</tbody>`);
}

/* ======================= События ======================= */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    syncAuthMode();
    $('auth-error').textContent = '';
  });
}

$('submit-auth').addEventListener('click', submitAuth);
$('hero-register').addEventListener('click', () => openAuth('register'));

for (const id of ['login', 'password']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAuth();
  });
}

/* ======================= Вход через Telegram ======================= */

/**
 * Страница, открытая кнопкой из бота, получает от Telegram строку
 * initData с подписанным профилем. Её наличие и означает, что мы
 * внутри мини-приложения.
 */
function telegramInitData() {
  const webApp = window.Telegram?.WebApp;
  return webApp?.initData && webApp.initData.length > 0 ? webApp.initData : null;
}

/** Автоматический вход внутри Telegram — пароль не нужен. */
async function loginWithTelegram(initData) {
  try {
    const response = await fetch(API_AUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'telegram', initData }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('auth-error').textContent = body.error ?? 'Telegram не подтвердил вход';
      show('auth-view');
      return;
    }

    state.token = body.token;
    state.account = body.account;
    writeToken(body.token);
    setChartToken(body.token);

    renderAccount();
    openPanel();
  } catch {
    $('auth-error').textContent = 'Сеть недоступна';
    show('auth-view');
  }
}

/* ======================= Запуск ======================= */

(function init() {
  renderAccount();
  syncAuthMode();

  // Внутри Telegram: разворачиваем окно, прячем форму с паролем
  // и входим по подписанному профилю.
  const initData = telegramInitData();
  if (initData) {
    document.body.classList.add('in-telegram');
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();

    $('auth-note').textContent = 'Входим через Telegram…';
    show('auth-view');
    loginWithTelegram(initData);
    return;
  }

  // Токен из прошлой сессии: пробуем сразу открыть панель.
  // Если он протух, сервер ответит 401 и нас вернёт на форму входа.
  const saved = readToken();
  if (saved) {
    state.token = saved;
    fetch(API_DATA, { headers: { authorization: `Bearer ${saved}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        state.account = { login: data.login, role: data.role };
        renderAccount();
      })
      .catch(() => {
        writeToken(null);
        state.token = null;
      });
  }
})();
