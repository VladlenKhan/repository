/* ===========================================================================
   Вкладка «Сделки»: журнал бумажной торговли, статистика и настройки.

   Данные приходят отдельным запросом, а не вместе с панелью: журнал
   обновляется реже и нужен не на каждой вкладке.
   =========================================================================== */

const API = '/api/trading';
const $ = (id) => document.getElementById(id);

const state = { token: null, data: null };

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const dt = (iso) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Знак и цвет для денежного результата. */
function money(value) {
  if (!Number.isFinite(value)) return '<span class="muted">—</span>';
  const css = value > 0 ? 'win' : value < 0 ? 'loss' : 'muted';
  return `<span class="${css}">${value > 0 ? '+' : ''}${value.toFixed(2)} $</span>`;
}

function statCard(label, value, sub = '') {
  return `<div class="card stat">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
  </div>`;
}

/* ======================= Загрузка ======================= */

export function setTradingToken(token) {
  state.token = token;
}

export async function loadTrading() {
  if (!state.token) return;

  try {
    const response = await fetch(API, { headers: { authorization: `Bearer ${state.token}` } });
    if (!response.ok) return;

    state.data = await response.json();
    render(state.data);
  } catch {
    /* Сеть недоступна — оставляем прошлые данные на экране. */
  }
}

/* ======================= Отрисовка ======================= */

function render(data) {
  renderStats(data);
  renderOpen(data);
  renderHistory(data);
  renderByStrategy(data);
  renderLlmValue(data);

  // Настройки видит и меняет только владелец.
  $('trade-settings').classList.toggle('hidden', !data.canEdit);
  if (data.canEdit) fillSettings(data);
}

function renderStats({ stats, settings, price }) {
  const state_ = settings.enabled
    ? '<span class="win">включена</span>'
    : '<span class="muted">выключена</span>';

  $('trade-stats').innerHTML = [
    statCard('Результат', money(stats.pnlMoney),
      stats.pnlPercent === null ? '' : `${stats.pnlPercent > 0 ? '+' : ''}${stats.pnlPercent}% от депозита`),
    statCard('Сделок', stats.total,
      `прибыльных ${stats.wins}, убыточных ${stats.losses}`),
    statCard('Доля побед', stats.winRate === null ? '—' : `${stats.winRate}%`,
      stats.profitFactor === null ? '' : `профит-фактор ${stats.profitFactor}`),
    statCard('Открыто', stats.open,
      `торговля ${state_}${price ? ` · цена ${num(price)}` : ''}`),
    statCard('Худшая просадка', money(stats.maxDrawdown),
      'по нарастающему итогу'),
    statCard('Средние', `${num(stats.averageWin)} / ${num(stats.averageLoss)}`,
      'прибыль / убыток на сделку'),
  ].join('');
}

function renderOpen({ positions, strategies }) {
  const open = positions.filter((p) => p.status === 'open');

  if (open.length === 0) {
    $('open-table').innerHTML = '<tbody><tr><td class="muted">Открытых позиций нет</td></tr></tbody>';
    return;
  }

  const rows = open.map((p) => `<tr>
    <td>${p.direction === 'bullish' ? '🔼 покупка' : '🔽 продажа'}</td>
    <td>${esc(strategies[p.strategy] ?? p.strategy)}</td>
    <td class="mono">${num(p.entry)}</td>
    <td class="mono loss">${num(p.stopLoss)}</td>
    <td class="mono win">${num(p.takeProfit)}</td>
    <td class="mono">${num(p.lot)}</td>
    <td>${money(p.floating?.pnlMoney)}</td>
    <td class="muted">${dt(p.openedAt)}</td>
  </tr>`).join('');

  $('open-table').innerHTML =
    `<thead><tr><th>Направление</th><th>Стратегия</th><th>Вход</th><th>Стоп</th><th>Цель</th><th>Лот</th><th>Сейчас</th><th>Открыта</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderHistory({ positions, strategies }) {
  const closed = positions.filter((p) => p.status === 'closed').slice(0, 50);

  if (closed.length === 0) {
    $('history-table').innerHTML = '<tbody><tr><td class="muted">Закрытых сделок пока нет</td></tr></tbody>';
    return;
  }

  const rows = closed.map((p) => `<tr>
    <td>${p.direction === 'bullish' ? '🔼' : '🔽'}</td>
    <td>${esc(strategies[p.strategy] ?? p.strategy)}</td>
    <td class="mono">${num(p.entry)} → ${num(p.closePrice)}</td>
    <td>${
      p.outcome === 'tp' ? '<span class="win">цель</span>'
      : p.outcome === 'partial' ? '<span class="win">частично</span>'
      : p.outcome === 'time' ? '<span class="muted">по времени</span>'
      : '<span class="loss">стоп</span>'
    }</td>
    <td class="mono">${num(p.pnlPoints)}</td>
    <td>${money(p.pnlMoney)}</td>
    <td class="muted">${dt(p.closedAt)}</td>
  </tr>`).join('');

  $('history-table').innerHTML =
    `<thead><tr><th></th><th>Стратегия</th><th>Цена</th><th>Исход</th><th>Пункты</th><th>Результат</th><th>Закрыта</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderByStrategy({ stats, strategies }) {
  const entries = Object.entries(stats.byStrategy ?? {});

  if (entries.length === 0) {
    $('strategy-table').innerHTML = '<tbody><tr><td class="muted">Нет данных</td></tr></tbody>';
    return;
  }

  const rows = entries.map(([name, group]) => `<tr>
    <td>${esc(strategies[name] ?? name)}</td>
    <td class="mono">${group.total}</td>
    <td class="mono">${group.winRate}%</td>
    <td>${money(group.pnlMoney)}</td>
  </tr>`).join('');

  $('strategy-table').innerHTML =
    `<thead><tr><th>Стратегия</th><th>Сделок</th><th>Побед</th><th>Результат</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ======================= Настройки ======================= */

function fillSettings({ settings, strategies }) {
  $('set-enabled').checked = settings.enabled;
  $('set-llm').checked = settings.llmShadow === true;
  $('set-deposit').value = settings.deposit;
  $('set-risk').value = settings.riskPercent;
  $('set-lot').value = settings.lot;
  $('set-reward').value = settings.rewardRatio;
  $('set-max').value = settings.maxOpenPositions;
  $('set-timeframe').value = settings.timeframe;
  $('set-stopmode').value = settings.stopMode;
  $('set-atr').value = settings.stopAtrMultiple;
  $('set-partial').value = settings.exits?.partialAt ?? 0;
  $('set-breakeven').value = settings.exits?.breakevenAt ?? 0;
  $('set-trail').value = settings.exits?.trailAtr ?? 0;

  $('strategy-toggles').innerHTML = Object.entries(strategies)
    .map(([name, label]) => {
      const on = settings.strategies[name] !== false;
      return `<button class="layer strategy-toggle ${on ? 'active' : ''}" data-strategy="${name}">${esc(label)}</button>`;
    })
    .join('');

  for (const button of document.querySelectorAll('.strategy-toggle')) {
    button.addEventListener('click', () => button.classList.toggle('active'));
  }
}

async function saveSettings() {
  const strategies = {};
  for (const button of document.querySelectorAll('.strategy-toggle')) {
    strategies[button.dataset.strategy] = button.classList.contains('active');
  }

  const settings = {
    enabled: $('set-enabled').checked,
    llmShadow: $('set-llm').checked,
    deposit: $('set-deposit').value,
    riskPercent: $('set-risk').value,
    lot: $('set-lot').value,
    rewardRatio: $('set-reward').value,
    maxOpenPositions: $('set-max').value,
    timeframe: $('set-timeframe').value,
    stopMode: $('set-stopmode').value,
    stopAtrMultiple: $('set-atr').value,
    exits: {
      partialAt: $('set-partial').value,
      breakevenAt: $('set-breakeven').value,
      trailAtr: $('set-trail').value,
    },
    strategies,
  };

  await post({ settings }, 'Настройки сохранены');
}

async function post(body, successNote) {
  const button = $('save-settings');
  button.disabled = true;
  $('trade-error').textContent = '';

  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      $('trade-error').textContent = error.error ?? 'Не удалось сохранить';
      return;
    }

    $('trade-error').textContent = successNote;
    await loadTrading();
  } catch {
    $('trade-error').textContent = 'Сеть недоступна';
  } finally {
    button.disabled = false;
  }
}

/* ======================= События ======================= */

$('save-settings').addEventListener('click', saveSettings);

$('reset-journal').addEventListener('click', async () => {
  // Журнал — основа статистики, поэтому спрашиваем подтверждение.
  if (!confirm('Удалить все сделки? Статистика обнулится.')) return;
  await post({ action: 'reset' }, 'Журнал очищен');
});

/**
 * Сравнение сделок, одобренных и отклонённых моделью.
 *
 * Главное число всего слоя: если у одобренных результат не лучше,
 * модель добавляет только объяснения.
 */
function renderLlmValue({ llmValue }) {
  const box = $('llm-value');
  if (!box) return;

  if (!llmValue) {
    box.innerHTML = `<p class="muted" style="margin:0">
      Теневая оценка выключена или сделок с вердиктом ещё нет.
      Включите её в настройках — модель будет оценивать каждый сигнал,
      но на открытие это не повлияет. Через несколько десятков сделок
      здесь появится сравнение.
    </p>`;
    return;
  }

  const row = (name, g) => `<tr>
    <td>${name}</td>
    <td class="mono">${g.trades}</td>
    <td class="mono">${g.winRate === null ? '—' : g.winRate + '%'}</td>
    <td>${money(g.pnlMoney)}</td>
    <td class="mono">${g.profitFactor ?? '—'}</td>
  </tr>`;

  const verdict =
    llmValue.edge === null ? 'Данных пока недостаточно для вывода.'
    : llmValue.edge > 0.15 ? `✅ Одобренные сделки лучше на ${llmValue.edge} профит-фактора — отбор что-то даёт.`
    : llmValue.edge < -0.15 ? `❌ Отклонённые сделки оказались лучше на ${Math.abs(llmValue.edge)}. Отбор вредит.`
    : '➖ Разницы нет: модель не улучшает отбор, только объясняет.';

  box.innerHTML = `
    <table style="margin-bottom:12px">
      <thead><tr><th>Группа</th><th>Сделок</th><th>Побед</th><th>Результат</th><th>ПФ</th></tr></thead>
      <tbody>
        ${row('Модель одобрила', llmValue.approved)}
        ${row('Модель отклонила', llmValue.rejected)}
      </tbody>
    </table>
    <p style="margin:0">${verdict}</p>`;
}
