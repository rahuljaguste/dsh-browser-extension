const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const statusLine = document.getElementById('status')
const dot = document.getElementById('dot')

let loaded = false
let hasToken = false

function compareVersions(a, b) {
  const left = String(a ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function render(status) {
  dot.classList.toggle('on', Boolean(status.connected))
  if (status.connected) {
    const hostVersion = status.hostVersion
    if (!hostVersion || hostVersion === 'unknown' || compareVersions(hostVersion, status.version) !== 0) {
      const hostLabel = hostVersion && hostVersion !== 'unknown' ? hostVersion : 'unknown'
      const staleHost = !hostVersion || hostVersion === 'unknown' || compareVersions(hostVersion, status.version) < 0
      statusLine.textContent = `Host ${hostLabel} · extension ${status.version} — ${staleHost ? 'restart DSH' : 'reload the extension'}`
      return
    }
    statusLine.textContent = `Connected to DSH on port ${status.port} · v${status.version}`
    return
  }
  if (!status.hasToken) {
    statusLine.textContent = 'Not paired yet. Read the token from <DSH_HOME>/storages/browser-companion.json (browser_status gives the port) and paste it below.'
    return
  }
  const parts = [
    status.lastError || `Waiting for DSH on port ${status.port}. Is the desktop app running?`
  ]
  if (status.lastClose) {
    const reason = status.lastClose.reason ? ` — ${status.lastClose.reason}` : ''
    parts.push(`(last close ${status.lastClose.code}${reason})`)
  }
  if (status.attempts > 1) parts.push(`attempt ${status.attempts}`)
  statusLine.textContent = parts.join(' ')
}

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'status' })
    if (!status) {
      statusLine.textContent = 'The extension is waking up…'
      return
    }
    render(status)
    hasToken = Boolean(status.hasToken)
    if (!loaded) {
      portInput.value = status.port
      loaded = true
    }
  } catch {
    statusLine.textContent = 'No service worker yet. Click Reload on the extension card in chrome://extensions.'
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value)
  const token = tokenInput.value.trim()
  if (!token && !hasToken) {
    statusLine.textContent = 'Read the pairing token from <DSH_HOME>/storages/browser-companion.json first.'
    return
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    statusLine.textContent = 'The port must be a whole number between 1 and 65535.'
    return
  }
  // An empty token means "keep the saved one" (the worker treats it that way),
  // so a port-only change does not require pasting the token again.
  await chrome.runtime.sendMessage({ type: 'config', port, ...(token ? { token } : {}) })
  if (token) hasToken = true
  tokenInput.value = ''
  tokenInput.placeholder = 'Saved — leave blank to keep the current token'
  setTimeout(refresh, 400)
})

document.getElementById('panel').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent()
    await chrome.sidePanel.open({ windowId: win.id })
    window.close()
  } catch (error) {
    statusLine.textContent = `Side panel unavailable: ${error?.message ?? error}`
  }
})

document.getElementById('again').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' })
  setTimeout(refresh, 400)
})

refresh()
setInterval(refresh, 1500)
