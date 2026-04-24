import { describe, expect, it } from 'vitest'
import { createInlineReasoningLifter } from '../../src/core/reasoning-inline'

function drain(
  lifter: ReturnType<typeof createInlineReasoningLifter>,
  inputs: string[],
): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = []
  for (const chunk of inputs) out.push(...lifter.feed(chunk))
  out.push(...lifter.finish())
  return out
}

describe('InlineReasoningLifter', () => {
  it('passes through plain content unchanged', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['Hello, ', 'world!'])
    expect(out.every((e) => e.kind === 'text')).toBe(true)
    expect(out.map((e) => e.text).join('')).toBe('Hello, world!')
  })

  it('lifts a complete <think> block in a single chunk', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<think>I should add 2+2</think>The answer is 4.'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'I should add 2+2' },
      { kind: 'text', text: 'The answer is 4.' },
    ])
  })

  it('lifts <thought> variant (Gemma)', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<thought>pondering</thought>Yes.'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'pondering' },
      { kind: 'text', text: 'Yes.' },
    ])
  })

  it('handles open tag split across chunks', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<thi', 'nk>hidden</think>answer'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'hidden' },
      { kind: 'text', text: 'answer' },
    ])
  })

  it('handles close tag split across chunks', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<think>hid', 'den</thi', 'nk>ans'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'hid' },
      { kind: 'reasoning', text: 'den' },
      { kind: 'text', text: 'ans' },
    ])
  })

  it('leaves content alone when tag appears mid-content (auto-detect safety)', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['Here is a literal <think> tag</think>.'])
    expect(out).toEqual([
      { kind: 'text', text: 'Here is a literal <think> tag</think>.' },
    ])
  })

  it('auto-detects reasoning after leading whitespace', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['  \n<think>abc</think>def'])
    expect(out[0]).toEqual({ kind: 'reasoning', text: 'abc' })
    expect(out[out.length - 1]).toEqual({ kind: 'text', text: 'def' })
  })

  it('flushes unclosed <think> at end of stream to reasoning lane', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<think>truncated mid-reason'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'truncated mid-reason' },
    ])
  })

  it('respects custom tag set (no auto-detect via registry)', () => {
    const lifter = createInlineReasoningLifter({ tags: ['analysis'], autoDetect: false })
    const out = drain(lifter, ['prefix <analysis>stuff</analysis> suffix'])
    expect(out).toEqual([
      { kind: 'text', text: 'prefix ' },
      { kind: 'reasoning', text: 'stuff' },
      { kind: 'text', text: ' suffix' },
    ])
  })

  it('disabled mode (empty tag list) is pure pass-through', () => {
    const lifter = createInlineReasoningLifter({ tags: [] })
    const out = drain(lifter, ['<think>hello</think>'])
    expect(out).toEqual([{ kind: 'text', text: '<think>hello</think>' }])
  })

  it('handles multiple sequential reasoning blocks (non-auto-detect mode)', () => {
    const lifter = createInlineReasoningLifter({ tags: ['think'], autoDetect: false })
    const out = drain(lifter, [
      '<think>one</think>mid<think>two</think>end',
    ])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'one' },
      { kind: 'text', text: 'mid' },
      { kind: 'reasoning', text: 'two' },
      { kind: 'text', text: 'end' },
    ])
  })

  it('handles char-by-char streaming', () => {
    const lifter = createInlineReasoningLifter()
    const input = '<think>ab</think>cd'
    const out = drain(lifter, input.split(''))
    const reasoning = out
      .filter((e) => e.kind === 'reasoning')
      .map((e) => e.text)
      .join('')
    const text = out
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('')
    expect(reasoning).toBe('ab')
    expect(text).toBe('cd')
  })

  it('stays in content mode when stream starts with a non-< character', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['hello ', '<think>not lifted</think>'])
    expect(out.map((e) => e.text).join('')).toBe('hello <think>not lifted</think>')
    expect(out.every((e) => e.kind === 'text')).toBe(true)
  })

  it('handles partial open tag that turns out to be something else', () => {
    const lifter = createInlineReasoningLifter()
    // `<hello>` isn't a reasoning tag; the lifter should demote to content.
    const out = drain(lifter, ['<hello>world</hello>'])
    expect(out).toEqual([{ kind: 'text', text: '<hello>world</hello>' }])
  })

  it('auto-detect mode lifts MULTIPLE sequential <think> blocks (not just the first)', () => {
    // Regression: previously auto-detect locked into 'content' after the
    // first close, so a model emitting two reasoning sections would leak
    // the second into the answer lane. After arming on the first block,
    // the lifter scans for further open tags.
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, [
      '<think>step 1</think>partial answer<think>step 2</think>final',
    ])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'step 1' },
      { kind: 'text', text: 'partial answer' },
      { kind: 'reasoning', text: 'step 2' },
      { kind: 'text', text: 'final' },
    ])
  })

  it('auto-detect mode does NOT lift mid-stream <think> when the stream did not start with one', () => {
    // Symmetry: arming only happens after a real open at start. A model
    // that quotes `<think>` mid-answer (e.g. explaining the syntax) keeps
    // those characters in the content lane verbatim.
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, [
      'Tags like <think>example</think> are used by DeepSeek.',
    ])
    expect(out).toEqual([
      { kind: 'text', text: 'Tags like <think>example</think> are used by DeepSeek.' },
    ])
  })

  it('handles three sibling reasoning blocks in auto-detect (chunked across feeds)', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, [
      '<think>a</think>x',
      '<think>b</think>y',
      '<think>c</think>z',
    ])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'a' },
      { kind: 'text', text: 'x' },
      { kind: 'reasoning', text: 'b' },
      { kind: 'text', text: 'y' },
      { kind: 'reasoning', text: 'c' },
      { kind: 'text', text: 'z' },
    ])
  })

  it('empty <think></think> emits nothing for reasoning, content continues', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<think></think>just an answer'])
    expect(out).toEqual([{ kind: 'text', text: 'just an answer' }])
  })

  it('nested-looking tags: first </think> closes the outer block', () => {
    // The lifter does NOT recurse on nested opens — first `</think>` ends
    // the block. The inner `<think>` and trailing text become reasoning;
    // the orphan `</think>` after the close is plain content.
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['<think>outer<think>inner</think>tail</think>done'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'outer<think>inner' },
      { kind: 'text', text: 'tail</think>done' },
    ])
  })

  it('orphan </think> with no preceding open is plain content (auto-detect)', () => {
    const lifter = createInlineReasoningLifter()
    const out = drain(lifter, ['answer with stray </think> in it'])
    expect(out).toEqual([
      { kind: 'text', text: 'answer with stray </think> in it' },
    ])
  })

  it('explicit-mode also handles three sibling blocks (regression guard)', () => {
    const lifter = createInlineReasoningLifter({ tags: ['think'], autoDetect: false })
    const out = drain(lifter, ['<think>a</think>x<think>b</think>y<think>c</think>z'])
    expect(out).toEqual([
      { kind: 'reasoning', text: 'a' },
      { kind: 'text', text: 'x' },
      { kind: 'reasoning', text: 'b' },
      { kind: 'text', text: 'y' },
      { kind: 'reasoning', text: 'c' },
      { kind: 'text', text: 'z' },
    ])
  })
})
