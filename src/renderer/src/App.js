export function createApp(root) {
  root.innerHTML = `
    <main>
      <h1>My Electrons</h1>
      <p>Platform: <code>${window.electron?.platform ?? 'web'}</code></p>
    </main>
  `
}
