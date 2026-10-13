import { describe, expect, it } from 'vitest';
import { mergePeople } from '../lib/admin.js';

describe('объединение пользователей бота и сайта', () => {
  const data = {
    users: [
      { chatId: 1, lang: 'ru', username: 'vlad', name: 'Влад', updatedAt: '2026-10-08T10:00:00Z' },
      { chatId: 2, lang: 'en', username: null, name: 'Вася', updatedAt: '2026-10-07T10:00:00Z' },
    ],
    accounts: [
      {
        login: 'tg1', telegramId: 1, role: 'owner', username: 'vlad',
        displayName: '@vlad', createdAt: '2026-10-01T10:00:00Z', lastLoginAt: '2026-10-09T10:00:00Z',
      },
    ],
    subscribers: [{ chatId: 1 }],
    alerts: [{ chatId: 1 }, { chatId: 1 }, { chatId: 2 }],
  };

  it('соединяет записи одного человека по идентификатору Telegram', () => {
    // В личном чате идентификатор чата и пользователя совпадают,
    // поэтому две таблицы описывали одних и тех же людей.
    const people = mergePeople(data);
    expect(people).toHaveLength(2);
  });

  it('показывает и идентификатор, и имя через собачку', () => {
    const vlad = mergePeople(data).find((p) => p.telegramId === 1);

    expect(vlad.telegramId).toBe(1);
    expect(vlad.username).toBe('vlad');
  });

  it('отмечает, где человек присутствует', () => {
    const people = mergePeople(data);
    const vlad = people.find((p) => p.telegramId === 1);
    const vasya = people.find((p) => p.telegramId === 2);

    expect(vlad.usesBot && vlad.usesSite).toBe(true);
    expect(vasya.usesBot).toBe(true);
    expect(vasya.usesSite).toBe(false);
  });

  it('у пользователя без аккаунта роли нет', () => {
    const vasya = mergePeople(data).find((p) => p.telegramId === 2);
    expect(vasya.role).toBeNull();
  });

  it('считает подписку и число уведомлений', () => {
    const people = mergePeople(data);
    const vlad = people.find((p) => p.telegramId === 1);

    expect(vlad.subscribed).toBe(true);
    expect(vlad.alerts).toBe(2);
    expect(people.find((p) => p.telegramId === 2).subscribed).toBe(false);
  });

  it('берёт самую позднюю активность из обоих источников', () => {
    // Бот писал 8-го, на сайт заходили 9-го — берём 9-е.
    const vlad = mergePeople(data).find((p) => p.telegramId === 1);
    expect(vlad.lastSeen).toBe('2026-10-09T10:00:00Z');
  });

  it('владелец и админы идут первыми', () => {
    const people = mergePeople({
      ...data,
      accounts: [
        { login: 'tg2', telegramId: 2, role: 'owner', createdAt: '2026-10-01', lastLoginAt: '2026-10-01' },
        { login: 'tg1', telegramId: 1, role: 'user', createdAt: '2026-10-01', lastLoginAt: '2026-10-09' },
      ],
    });

    expect(people[0].role).toBe('owner');
  });

  it('имя из аккаунта точнее имени из бота', () => {
    // Профиль аккаунта приходит подписанным от Telegram.
    const people = mergePeople({
      users: [{ chatId: 1, username: 'старое' }],
      accounts: [{ login: 'tg1', telegramId: 1, role: 'user', username: 'новое' }],
    });

    expect(people[0].username).toBe('новое');
  });

  it('не падает на пустых данных', () => {
    expect(mergePeople({})).toEqual([]);
  });

  it('пропускает записи без идентификатора', () => {
    expect(mergePeople({ users: [{ chatId: null }, { chatId: 'мусор' }] })).toEqual([]);
  });
});
