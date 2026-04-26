import { describe, expect, it } from 'vitest'
import {
  attachmentHref,
  chatHref,
  homeHref,
  newChatHref,
  parseRoute,
  routeToHref,
  storageHref,
} from '../../src/app/router'

describe('parseRoute', () => {
  it('treats empty hash as home', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' })
    expect(parseRoute('#')).toEqual({ kind: 'home' })
    expect(parseRoute('#/')).toEqual({ kind: 'home' })
  })

  it('parses #/new', () => {
    expect(parseRoute('#/new')).toEqual({ kind: 'new' })
    expect(parseRoute('#new')).toEqual({ kind: 'new' })
  })

  it('parses chat with no pin', () => {
    expect(parseRoute('#/chat/abc123')).toEqual({
      kind: 'chat',
      chatId: 'abc123',
    })
  })

  it('parses chat with a message-id pin', () => {
    expect(parseRoute('#/chat/abc123/message/m9')).toEqual({
      kind: 'chat',
      chatId: 'abc123',
      pinnedMessageId: 'm9',
    })
  })

  it('marks unrecognized hashes as unknown (no crash)', () => {
    expect(parseRoute('#/banana')).toMatchObject({ kind: 'unknown' })
    expect(parseRoute('#/chat')).toMatchObject({ kind: 'unknown' })
  })

  it('parses storage management routes', () => {
    expect(parseRoute('#/storage')).toEqual({
      kind: 'storage',
      storage: { section: 'overview' },
    })
    expect(parseRoute('#/storage/attachments')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments' },
    })
    expect(parseRoute('#/storage/attachments/missing')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', filter: 'missing' },
    })
    expect(parseRoute('#/storage/attachments/unreferenced')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', filter: 'unreferenced' },
    })
    expect(parseRoute('#/storage/attachments/att%2F1')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', attachmentId: 'att/1' },
    })
    expect(parseRoute('#/storage/backups')).toEqual({
      kind: 'storage',
      storage: { section: 'backups' },
    })
  })
})

describe('routeToHref / convenience helpers', () => {
  it('round-trips home and new', () => {
    expect(routeToHref({ kind: 'home' })).toBe('#/')
    expect(routeToHref({ kind: 'new' })).toBe('#/new')
    expect(homeHref()).toBe('#/')
    expect(newChatHref()).toBe('#/new')
  })

  it('round-trips chat hrefs with and without pin', () => {
    expect(chatHref('xyz')).toBe('#/chat/xyz')
    expect(chatHref('xyz', 'm1')).toBe('#/chat/xyz/message/m1')
    expect(routeToHref({ kind: 'chat', chatId: 'xyz' })).toBe('#/chat/xyz')
    expect(routeToHref({ kind: 'chat', chatId: 'xyz', pinnedMessageId: 'm1' })).toBe(
      '#/chat/xyz/message/m1',
    )
  })

  it('round-trips storage hrefs', () => {
    expect(storageHref()).toBe('#/storage')
    expect(storageHref({ section: 'attachments' })).toBe('#/storage/attachments')
    expect(storageHref({ section: 'attachments', filter: 'missing' })).toBe(
      '#/storage/attachments/missing',
    )
    expect(storageHref({ section: 'attachments', filter: 'unreferenced' })).toBe(
      '#/storage/attachments/unreferenced',
    )
    expect(storageHref({ section: 'backups' })).toBe('#/storage/backups')
    expect(attachmentHref('att/1')).toBe('#/storage/attachments/att%2F1')
  })

  it('round-trips parse → render → parse', () => {
    const cases = [
      '#/',
      '#/new',
      '#/chat/A',
      '#/chat/A/message/B',
      '#/storage',
      '#/storage/attachments',
      '#/storage/attachments/missing',
      '#/storage/attachments/unreferenced',
      '#/storage/attachments/A',
      '#/storage/backups',
    ]
    for (const raw of cases) {
      const route = parseRoute(raw)
      expect(routeToHref(route)).toBe(raw)
    }
  })
})
