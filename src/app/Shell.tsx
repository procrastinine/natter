export function Shell() {
  return (
    <div data-ui="app-shell">
      <aside data-ui="sidebar" aria-label="Chats" />
      <header data-ui="header" />
      <main data-ui="main-pane" />
      <div data-ui="settings-overlay" role="dialog" aria-hidden="true" hidden />
    </div>
  )
}
