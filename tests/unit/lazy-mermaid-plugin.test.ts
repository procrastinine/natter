import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLazyMermaidPlugin } from '../../src/ui/chat/lazy-mermaid-plugin'

const initialize = vi.fn()
const render = vi.fn(async (id: string, source: string) => ({ svg: `${id}:${source}` }))
const getMermaid = vi.fn(() => ({ initialize, render }))
const createMermaidPlugin = vi.fn(() => ({ getMermaid }))

vi.mock('@streamdown/mermaid', () => ({ createMermaidPlugin }))

describe('createLazyMermaidPlugin', () => {
  beforeEach(() => {
    initialize.mockClear()
    render.mockClear()
    getMermaid.mockClear()
    createMermaidPlugin.mockClear()
  })

  it('loads Mermaid only on first render and shares the load across concurrent diagrams', async () => {
    const plugin = createLazyMermaidPlugin({ config: { securityLevel: 'strict' } })
    const instance = plugin.getMermaid()
    expect(createMermaidPlugin).not.toHaveBeenCalled()

    await expect(
      Promise.all([instance.render('a', 'graph TD'), instance.render('b', 'sequenceDiagram')]),
    ).resolves.toEqual([{ svg: 'a:graph TD' }, { svg: 'b:sequenceDiagram' }])
    expect(createMermaidPlugin).toHaveBeenCalledTimes(1)
    expect(createMermaidPlugin).toHaveBeenCalledWith({ config: { securityLevel: 'strict' } })
  })

  it('retains configuration supplied before the module is needed', async () => {
    const plugin = createLazyMermaidPlugin()
    const instance = plugin.getMermaid({ theme: 'dark' })
    await instance.render('a', 'graph TD')
    expect(createMermaidPlugin).toHaveBeenCalledWith({
      config: { securityLevel: 'strict', theme: 'dark' },
    })
  })

  it('allows a later render to retry when plugin construction fails', async () => {
    createMermaidPlugin.mockImplementationOnce(() => {
      throw new Error('load failed')
    })
    const instance = createLazyMermaidPlugin().getMermaid()
    await expect(instance.render('a', 'graph TD')).rejects.toThrow('load failed')
    await expect(instance.render('a', 'graph TD')).resolves.toEqual({ svg: 'a:graph TD' })
    expect(createMermaidPlugin).toHaveBeenCalledTimes(2)
  })
})
