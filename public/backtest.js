/* ===========================================================================
   Вкладка «Бэктест»: прогон стратегий по истории.

   Результат намеренно показывается двумя наборами цифр — по части, на
   которой подбирались параметры, и по отложенной. Разрыв между ними
   и есть мера подгонки, а её легко не заметить, если видеть только
   общий итог.
   =========================================================================== */

const API = '/api/backtest';
const $ = (id) => document.getElementById(id);

const state = { token: null };

export function setBacktestToken(token) {
  state.token = token;
}

const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value) {
  if (!Number.isFinite(value)) return '<span class="muted">—</span>';
  const css = value > 0 ? 'win' : value < 0 ? 'loss' : 'muted';
  return `<span class="${css}">${value > 0 ? '+' : ''}${value.toFixed(0)} $</span>`;
}

function statCard(label, value, sub = '') {
  return `<div class="card stat">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
  </div>`;
}

/* ======================= Запуск ======================= */

function collect() {
  const active = (selector, attr) =>
    [...document.querySelectorAll(selector)]
      .filter((b) => b.classList.contains('active'))
      .map((b) => b.dataset[attr]);

  const chosen = active('#bt-strategies .layer', 'st');
  const filters = active('#bt-filters .layer', 'f');

  return {
    symbol: $('bt-symbol').value || undefined,
    settings: {
      timeframe: $('bt-timeframe').value,
      deposit: $('bt-deposit').value,
      riskPercent: $('bt-risk').value,
      rewardRatio: $('bt-reward').value,
      spread: $('bt-spread').value,
      maxOpenPositions: $('bt-max').value,
      exits: {
        partialAt: $('bt-partial').value,
        breakevenAt: $('bt-breakeven').value,
        trailAtr: $('bt-trail').value,
      },
      strategies: {
        fvgRetest: chosen.includes('fvgRetest'),
        obRetest: chosen.includes('obRetest'),
        sweepReversal: chosen.includes('sweepReversal'),
      },
    },
    filters: {
      premiumDiscount: filters.includes('premiumDiscount'),
      trendAlign: filters.includes('trendAlign'),
      sessions: filters.includes('london') ? ['london', 'newyork'] : null,
      minStopAtr: $('bt-minstop').value,
      maxBars: $('bt-maxbars').value,
    },
  };
}

async function run() {
  const button = $('run-backtest');
  button.disabled = true;
  button.textContent = 'Считаю…';
  $('bt-error').textContent = '';

  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify(collect()),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('bt-error').textContent = data.error ?? 'Не удалось прогнать';
      return;
    }

    render(data);
    $('bt-results').classList.remove('hidden');
  } catch {
    $('bt-error').textContent = 'Сеть недоступна';
  } finally {
    button.disabled = false;
    button.textContent = 'Прогнать';
  }
}

/* ======================= Отрисовка ======================= */

function render(data) {
  renderWalkForward(data);
  renderSignificance(data);
  renderSplit(data);
  renderStats(data);
  renderEquity(data.equity);
  renderStrategies(data);
}

/** Скользящая проверка: сводка и окна. */
function renderWalkForward({ walkForward: wf }) {
  if (!wf || wf.summary.windowCount === 0) {
    $('bt-wf-summary').innerHTML = statCard('Окон', '—', 'мало истории для скользящей проверки');
    $('bt-windows').innerHTML = '';
    return;
  }

  const { summary } = wf;
  const combined = summary.combined;

  $('bt-wf-summary').innerHTML = [
    statCard('Прибыльных окон', `${summary.positiveWindows} / ${summary.windowCount}`,
      `${summary.consistency}% периодов в плюсе`),
    statCard('Сводно по проверкам', money(combined.pnlMoney),
      `${combined.total} сделок, ПФ ${combined.profitFactor ?? '—'}`),
    statCard('Доля побед', combined.winRate === null ? '—' : `${combined.winRate}%`,
      'на данных, не участвовавших в подборе'),
  ].join('');

  const rows = wf.windows.map((w, i) => {
    const d = (t) => new Date(t).toLocaleDateString('ru-RU');
    const good = w.test.pnlMoney > 0;
    return `<tr>
      <td class="mono">${i + 1}</td>
      <td class="muted">${d(w.from)} — ${d(w.to)}</td>
      <td class="mono muted">${w.train.profitFactor ?? '—'}</td>
      <td class="mono">${w.test.total}</td>
      <td>${money(w.test.pnlMoney)}</td>
      <td class="mono ${good ? 'win' : 'loss'}">${w.test.profitFactor ?? '—'}</td>
    </tr>`;
  }).join('');

  $('bt-windows').innerHTML =
    `<thead><tr><th>#</th><th>Проверочный период</th><th>ПФ подбора</th><th>Сделок</th><th>Результат</th><th>ПФ</th></tr></thead><tbody>${rows}</tbody>`;
}

/** Доверительный интервал по сделкам проверочных окон. */
function renderSignificance({ significance }) {
  const box = $('bt-significance');

  if (!significance) {
    box.innerHTML = '<p class="muted" style="margin:0">Слишком мало сделок для оценки значимости (нужно хотя бы 20).</p>';
    return;
  }

  const { pnl, profitFactor, trades, lossProbability } = significance;
  const significant = pnl.low > 0;

  box.innerHTML = `
    <p style="margin:0 0 12px">
      По ${trades} сделкам проверочных окон составлено ${significance.iterations} случайных
      наборов того же размера. Разброс их итогов показывает, в каких пределах мог бы
      оказаться результат при том же качестве сделок.
    </p>
    <table style="margin-bottom:12px">
      <tbody>
        <tr><td>Результат, медиана</td><td>${money(pnl.median)}</td></tr>
        <tr><td>Интервал 95%</td><td class="mono">${pnl.low} … ${pnl.high} $</td></tr>
        <tr><td>Профит-фактор</td><td class="mono">${profitFactor.median} (${profitFactor.low} … ${profitFactor.high})</td></tr>
        <tr><td>Вероятность убытка</td><td class="mono ${lossProbability > 20 ? 'loss' : ''}">${lossProbability}%</td></tr>
      </tbody>
    </table>
    <p class="${significant ? 'win' : 'muted'}" style="margin:0">
      ${significant
        ? '✅ Нижняя граница интервала выше нуля — результат отличим от случайности.'
        : '⚠️ Нижняя граница ниже нуля: на таком числе сделок отличить результат от случайности нельзя. Нужно больше данных.'}
    </p>`;
}

function renderSplit({ train, test, full, period }) {
  const row = (name, s, bars, highlight = false) => `<tr class="${highlight ? 'highlight' : ''}">
    <td>${name}</td>
    <td class="mono muted">${bars} свечей</td>
    <td class="mono">${s.total}</td>
    <td class="mono">${s.winRate === null ? '—' : s.winRate + '%'}</td>
    <td>${money(s.pnlMoney)}</td>
    <td class="mono">${s.profitFactor ?? '—'}</td>
  </tr>`;

  $('bt-split').innerHTML =
    `<thead><tr><th>Часть истории</th><th></th><th>Сделок</th><th>Побед</th><th>Результат</th><th>ПФ</th></tr></thead>` +
    `<tbody>
      ${row('Подбор параметров', train, period.trainBars)}
      ${row('Проверка (не видел)', test, period.testBars, true)}
      ${row('Вся история', full, period.bars)}
    </tbody>`;

  // Вывод словами: разрыв между частями важнее абсолютных чисел.
  const trainPf = train.profitFactor ?? 0;
  const testPf = test.profitFactor ?? 0;
  const verdict = $('bt-verdict');

  if (test.total < 30) {
    verdict.innerHTML = '⚠️ На проверочной части слишком мало сделок — выводы делать рано.';
  } else if (testPf < 1) {
    verdict.innerHTML =
      `❌ На проверочной части система теряет (ПФ ${testPf}). Результат на подборе (${trainPf}) — подгонка.`;
  } else if (trainPf - testPf > 0.3) {
    verdict.innerHTML =
      `⚠️ Заметный разрыв: ${trainPf} на подборе против ${testPf} на проверке. Часть результата — подгонка.`;
  } else {
    verdict.innerHTML =
      `✅ Результат переносится: ${trainPf} на подборе, ${testPf} на проверке. Преимущество выглядит устойчивым.`;
  }
}

function renderStats({ full, period, symbol }) {
  const from = new Date(period.from).toLocaleDateString('ru-RU');
  const to = new Date(period.to).toLocaleDateString('ru-RU');

  $('bt-stats').innerHTML = [
    statCard('Результат', money(full.pnlMoney), `${esc(symbol)} · ${from} — ${to}`),
    statCard('Сделок', full.total, `прибыльных ${full.wins}, убыточных ${full.losses}`),
    statCard('Доля побед', full.winRate === null ? '—' : `${full.winRate}%`,
      `профит-фактор ${full.profitFactor ?? '—'}`),
    statCard('Худшая просадка', money(full.maxDrawdown), 'по нарастающему итогу'),
    statCard('Средние', `${num(full.averageWin, 0)} / ${num(full.averageLoss, 0)}`,
      'прибыль / убыток на сделку'),
    statCard('В процентах', full.pnlPercent === null ? '—' : `${full.pnlPercent}%`, 'от депозита'),
  ].join('');
}

/**
 * Кривая капитала.
 *
 * Рисуем SVG вручную: отдельная библиотека ради одной ломаной линии —
 * лишний вес, а масштабирование здесь тривиальное.
 */
function renderEquity(points) {
  const svg = $('bt-equity');
  if (!points || points.length < 2) {
    svg.innerHTML = '<text x="12" y="24" fill="#8792a6" font-size="13">Недостаточно сделок</text>';
    return;
  }

  const width = 1000;
  const height = 220;
  const pad = 10;

  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;

  const x = (i) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
  const positive = values.at(-1) >= 0;
  const color = positive ? '#26a69a' : '#ef5350';

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <line x1="${pad}" y1="${y(0).toFixed(1)}" x2="${width - pad}" y2="${y(0).toFixed(1)}"
          stroke="#242c3a" stroke-dasharray="4 4" />
    <path d="${area}" fill="${color}" opacity="0.12" />
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" />`;
}

function renderStrategies({ full, strategies }) {
  const entries = Object.entries(full.byStrategy ?? {});

  if (entries.length === 0) {
    $('bt-strategy-table').innerHTML = '<tbody><tr><td class="muted">Сделок не было</td></tr></tbody>';
    return;
  }

  const rows = entries
    .sort((a, b) => b[1].pnlMoney - a[1].pnlMoney)
    .map(([name, g]) => `<tr>
      <td>${esc(strategies[name] ?? name)}</td>
      <td class="mono">${g.total}</td>
      <td class="mono">${g.winRate}%</td>
      <td>${money(g.pnlMoney)}</td>
    </tr>`).join('');

  $('bt-strategy-table').innerHTML =
    `<thead><tr><th>Стратегия</th><th>Сделок</th><th>Побед</th><th>Результат</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ======================= События ======================= */

for (const button of document.querySelectorAll('#bt-strategies .layer, #bt-filters .layer')) {
  button.addEventListener('click', () => button.classList.toggle('active'));
}

$('run-backtest').addEventListener('click', run);
