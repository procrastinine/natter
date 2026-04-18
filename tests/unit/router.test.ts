import { describe, expect, it } from 'vitest'
import {
  chatHref,
  homeHref,
  newChatHref,
  parseRoute,
  routeToHref,
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
    expect(
      routeToHref({ kind: 'chat', chatId: 'xyz', pinnedMessageId: 'm1' }),
    ).toBe('#/chat/xyz/message/m1')
  })

  it('round-trips parse → render → parse', () => {
    const cases = ['#/', '#/new', '#/chat/A', '#/chat/A/message/B']
    for (const raw of cases) {
      const route = parseRoute(raw)
      expect(routeToHref(route)).toBe(raw)
    }
  })
})
