import { ConfigurationPreferencesProvider } from '../hooks/useConfigurationPreferences'
import { Shell } from './Shell'

export function App() {
  return (
    <ConfigurationPreferencesProvider>
      <Shell />
    </ConfigurationPreferencesProvider>
  )
}
