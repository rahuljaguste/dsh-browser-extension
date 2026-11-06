const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const statusLine = document.getElementById('status')
const dot = document.getElementById('dot')

let loaded = false

function render(status) {
  dot.classList.toggle('on', Boolean(status.connected))
  if (status.connected) {
    statusLine.textContent = `Connected to DSH on port ${status.port} · v${status.version}`
    return
  }
  if (!status.hasToken) {
    statusLine.textContent = 'Not paired yet. Run browser_status in DSH and paste the token below.'
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
  if (!token) {
    statusLine.textContent = 'Paste the pairing token from browser_status first.'
    return
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    statusLine.textContent = 'The port must be a whole number between 1 and 65535.'
    return
  }
  await chrome.runtime.sendMessage({ type: 'config', token, port })
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
