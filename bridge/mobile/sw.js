// The phone page's service worker: it shows the notifications the bridge sends (bridge/push.ts)
// and opens the page on the right tab when one is tapped. Browsers run it only over HTTPS,
// which the page has when it is opened at the Tailscale HTTPS address.

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // A message without JSON still says that something waits.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Switchboard', {
      body: data.body || '',
      tag: data.tag || 'switchboard',
      icon: 'icon.png',
      badge: 'icon.png',
      data: { tab: data.tab || '' },
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const tab = event.notification.data?.tab || ''
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (open[0]) {
        open[0].postMessage({ tab })
        return open[0].focus()
      }
      return self.clients.openWindow(tab ? `./#tab=${tab}` : './')
    })(),
  )
})
