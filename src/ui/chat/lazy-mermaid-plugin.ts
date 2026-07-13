import type {
  DiagramPlugin,
  MermaidConfig,
  MermaidInstance,
  MermaidPluginOptions,
} from '@streamdown/mermaid'

export function createLazyMermaidPlugin(options: MermaidPluginOptions = {}): DiagramPlugin {
  let config: MermaidConfig = { securityLevel: 'strict', ...options.config }
  let loading: Promise<MermaidInstance> | null = null
  let loaded: MermaidInstance | null = null

  const load = (): Promise<MermaidInstance> => {
    if (loading) return loading
    loading = import('@streamdown/mermaid')
      .then(({ createMermaidPlugin }) => {
        loaded = createMermaidPlugin({ config }).getMermaid()
        return loaded
      })
      .catch((error: unknown) => {
        loading = null
        loaded = null
        throw error
      })
    return loading
  }

  const instance: MermaidInstance = {
    initialize(nextConfig) {
      config = { ...config, ...nextConfig }
      loaded?.initialize(nextConfig)
    },
    async render(id, source) {
      return (await load()).render(id, source)
    },
  }

  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid(nextConfig) {
      if (nextConfig) instance.initialize(nextConfig)
      return instance
    },
  }
}
