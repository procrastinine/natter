import { RenderingPreferencesProvider } from '../ui/settings/RenderingSettings'
import { Shell } from './Shell'

export function App() {
  return (
    <RenderingPreferencesProvider>
      <Shell />
    </RenderingPreferencesProvider>
  )
}
