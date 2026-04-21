import { Shell } from './Shell'
import { RenderingPreferencesProvider } from '../ui/settings/RenderingSettings'

export function App() {
  return (
    <RenderingPreferencesProvider>
      <Shell />
    </RenderingPreferencesProvider>
  )
}
