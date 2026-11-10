const dot = document.getElementById('dot')
const statusLine = document.getElementById('status')
const versionChip = document.getElementById('version')
const errorBar = document.getElementById('error')
const approvalsBar = document.getElementById('approvals')
const transcript = document.getElementById('transcript')
const emptyState = document.getElementById('empty')
const jumpButton = document.getElementById('jump')
const pendingBar = document.getElementById('pending')
const form = document.getElementById('composer')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const stopButton = document.getElementById('stop')
const attachButton = document.getElementById('attach')
const fileInput = document.getElementById('file')

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const MAX_ATTACHMENTS = 6
// Must stay under the bridge's 64 MiB frame cap after base64 inflation.
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const MAX_SHOTS = 4

let entries = []
let shots = []
let pending = []
let previewQueue = []
const previewsByEntry = new Map()
let approvals = []
let connected = false
let agentStatus = 'idle'
let port = null
let awaitingReply = null
let shotWatch = null

/* ─────────────────────────────── helpers ─────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function showError(text) {
  if (!text) {
    errorBar.hidden = true
    errorBar.textContent = ''
    return
  }
  errorBar.hidden = false
  errorBar.textContent = text
}

function armReplyWatchdog() {
  clearTimeout(awaitingReply)
  awaitingReply = setTimeout(() => {
    showError('The Harness did not answer. If you just updated the companion, restart the desktop app so the Host plugin reloads, then reload this extension.')
  }, 9000)
}

function disarmReplyWatchdog() {
  if (awaitingReply) clearTimeout(awaitingReply)
  awaitingReply = null
}

/* ────────────────────────────── transcript ───────────────────────────── */

function toDisplay(list) {
  const out = []
  const byCall = new Map()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.role === 'tool') {
      const row = { ...entry, state: 'running', result: null }
      out.push(row)
      if (entry.callId) byCall.set(entry.callId, row)
      continue
    }
    if (entry.role === 'tool-result') {
      const target = entry.callId ? byCall.get(entry.callId) : undefined
      if (target) {
        target.state = entry.isError ? 'bad' : 'ok'
        target.result = entry.detail
      } else {
        out.push({ id: entry.id, role: 'tool', name: 'tool', detail: entry.detail, state: entry.isError ? 'bad' : 'ok' })
      }
      continue
    }
    out.push(entry)
  }
  return out
}

function toolRow(row) {
  const node = el('div', `tool ${row.state}`)
  node.append(el('span', 'mark'), el('span', 'name', row.name), el('span', 'detail', row.result || row.detail || ''))
  const detail = node.lastChild
  if (detail.textContent) detail.title = detail.textContent
  return node
}

function messageNode(entry) {
  const node = el('div', `msg ${entry.role}`)
  if (entry.text) {
    const lines = String(entry.text).split('\n')
    let paragraph = []
    const flush = () => {
      if (paragraph.length === 0) return
      node.append(el('div', null, paragraph.join('\n')))
      paragraph = []
    }
    for (const line of lines) {
      const match = /^\[Attached file: (.*?) — saved at (.*)\]$/.exec(line)
      if (match) {
        flush()
        const chip = el('div', 'file-chip', `📎 ${match[1]}`)
        chip.title = match[2]
        node.append(chip)
      } else {
        paragraph.push(line)
      }
    }
    flush()
  }
  if (entry.role === 'user' && Array.isArray(entry.attachments) && entry.attachments.length > 0) {
    const previews = previewsByEntry.get(entry.id) ?? []
    const thumbs = el('div', 'thumbs')
    entry.attachments.forEach((attachment, index) => {
      const preview = previews[index]
      if (attachment.kind === 'image' && preview?.dataUrl) {
        const image = document.createElement('img')
        image.src = preview.dataUrl
        image.alt = attachment.name || 'attachment'
        thumbs.append(image)
      } else {
        thumbs.append(el('div', 'file-chip', `📎 ${attachment.name || preview?.name || 'file'}`))
      }
    })
    node.append(thumbs)
  }
  return node
}

function renderTranscript() {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
  // Clearing the DOM resets scrollTop to 0. Keep the reader's place when they
  // are reading history; appended rows below cannot shift it.
  const previousScrollTop = transcript.scrollTop
  transcript.textContent = ''
  const display = toDisplay(entries)
  if (display.length === 0 && shots.length === 0) {
    transcript.append(emptyState)
    jumpButton.hidden = true
    return
  }
  for (const entry of display) {
    if (entry.role === 'user' || entry.role === 'assistant') transcript.append(messageNode(entry))
    else if (entry.role === 'error') transcript.append(el('div', 'msg error', entry.text))
    else transcript.append(toolRow(entry))
  }
  for (const shot of shots) {
    const figure = el('figure', 'shot')
    const image = document.createElement('img')
    image.src = shot.dataUrl
    image.alt = 'Page screenshot'
    figure.append(image, el('figcaption', null, shot.path || ''))
    transcript.append(figure)
  }
  if (nearBottom || shots.length > 0) {
    transcript.scrollTop = transcript.scrollHeight
    jumpButton.hidden = true
  } else {
    transcript.scrollTop = previousScrollTop
    jumpButton.hidden = false
  }
}

/* ─────────────────────────────── status ──────────────────────────────── */

function renderStatus() {
  dot.className = 'dot'
  if (!connected) {
    statusLine.textContent = 'Offline'
  } else if (agentStatus === 'working') {
    dot.classList.add('working')
    statusLine.textContent = 'Working…'
  } else {
    dot.classList.add('on')
    statusLine.textContent = 'Connected'
  }
  if (port) statusLine.title = `Port ${port}`
  stopButton.hidden = !(connected && agentStatus === 'working')
  sendButton.hidden = !stopButton.hidden
  sendButton.disabled = !connected
  stopButton.disabled = !connected
}

/* ─────────────────────────────── approvals ───────────────────────────── */

function renderApprovals() {
  approvalsBar.textContent = ''
  approvalsBar.hidden = approvals.length === 0
  for (const approval of approvals) {
    const card = el('div', 'approval')
    const head = el('div', 'approval-head')
    head.append(el('span', 'approval-title', 'Approval needed'), el('span', 'approval-tool', approval.toolName))
    const reason = el('p', 'approval-reason', approval.reason || 'This action needs your permission before it runs.')
    const actions = el('div', 'approval-actions')
    const allow = el('button', null, 'Allow once')
    allow.type = 'button'
    allow.addEventListener('click', () => answerApproval(approval.id, 'allow'))
    const deny = el('button', 'ghost', 'Deny')
    deny.type = 'button'
    deny.addEventListener('click', () => answerApproval(approval.id, 'deny'))
    actions.append(allow, deny)
    card.append(head, reason, actions)
    approvalsBar.append(card)
  }
}

function answerApproval(id, decision) {
  approvals = approvals.filter((entry) => entry.id !== id)
  renderApprovals()
  void chrome.runtime.sendMessage({ type: 'chat/approval', id, decision })
}

/* ─────────────────────────────── files ──────────────────────────────── */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read the file.'))
    reader.readAsDataURL(file)
  })
}

function pendingBytes() {
  return pending.reduce((total, attachment) => total + (attachment.size ?? 0), 0)
}

async function addFiles(fileList) {
  for (const file of [...(fileList ?? [])]) {
    if (pending.length >= MAX_ATTACHMENTS) {
      showError(`Up to ${MAX_ATTACHMENTS} attachments per message.`)
      break
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showError(`${file.name} is larger than 12 MB.`)
      continue
    }
    if (pendingBytes() + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      showError('Attachments are limited to 40 MB per message.')
      continue
    }
    try {
      const dataUrl = await readAsDataUrl(file)
      const comma = dataUrl.indexOf(',')
      if (comma < 0) continue
      pending.push({
        name: file.name || 'attachment',
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        data: dataUrl.slice(comma + 1),
        dataUrl
      })
    } catch (error) {
      showError(String(error?.message ?? error))
    }
  }
  renderPending()
}

function renderPending() {
  pendingBar.textContent = ''
  pendingBar.hidden = pending.length === 0
  pending.forEach((attachment, index) => {
    const chip = el('span', 'chip')
    if (attachment.mediaType.startsWith('image/')) {
      const image = document.createElement('img')
      image.src = attachment.dataUrl
      image.alt = attachment.name
      chip.append(image)
    }
    const remove = el('button', null, '×')
    remove.type = 'button'
    remove.title = 'Remove'
    remove.addEventListener('click', () => {
      pending.splice(index, 1)
      renderPending()
    })
    chip.append(el('span', 'name', attachment.name), remove)
    pendingBar.append(chip)
  })
}

/* ────────────────────────── screenshot fallback ──────────────────────── */

function watchForCapture(entry) {
  if (entry?.role !== 'tool' || entry.name !== 'browser_screenshot') return
  const before = shots.filter((shot) => !shot.local).length
  clearTimeout(shotWatch)
  shotWatch = setTimeout(async () => {
    if (shots.filter((shot) => !shot.local).length > before) return
    try {
      const result = await chrome.runtime.sendMessage({ type: 'capture' })
      if (result?.ok && result.dataUrl) {
        shots = [...shots, { path: 'captured by the panel', dataUrl: result.dataUrl, local: true }].slice(-MAX_SHOTS)
        renderTranscript()
      }
    } catch {
      // The worker may be restarting.
    }
  }, 2000)
}

/* ─────────────────────────────── composer ───────────────────────────── */

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text && pending.length === 0) return
  showError(null)
  if (pendingBytes() > MAX_TOTAL_ATTACHMENT_BYTES) {
    showError('Attachments are limited to 40 MB per message.')
    return
  }
  const attachments = pending.map((attachment) => ({
    name: attachment.name,
    mediaType: attachment.mediaType,
    data: attachment.data
  }))
  const previews = pending.map((attachment) => ({ name: attachment.name, dataUrl: attachment.dataUrl }))
  const reply = await chrome.runtime.sendMessage({ type: 'chat/send', text, attachments })
  if (!reply?.ok) {
    showError(reply?.error || 'Cannot send: the companion is not connected.')
    return
  }
  input.value = ''
  input.style.height = 'auto'
  previewQueue.push(...previews)
  pending = []
  renderPending()
  armReplyWatchdog()
})

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true
  await chrome.runtime.sendMessage({ type: 'chat/cancel' })
  setTimeout(() => {
    stopButton.disabled = false
  }, 800)
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    form.requestSubmit()
  }
})

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`
})

attachButton.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  await addFiles(fileInput.files)
  fileInput.value = ''
})

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length > 0) {
    event.preventDefault()
    void addFiles(files)
  }
})

document.addEventListener?.('dragover', (event) => event.preventDefault())
document.addEventListener?.('drop', (event) => {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length > 0) {
    event.preventDefault()
    void addFiles(files)
  }
})

for (const chipButton of document.querySelectorAll('.suggestion')) {
  chipButton.addEventListener('click', () => {
    input.value = chipButton.dataset.prompt || ''
    input.focus()
  })
}

jumpButton.addEventListener('click', () => {
  transcript.scrollTop = transcript.scrollHeight
  jumpButton.hidden = true
})

transcript.addEventListener('scroll', () => {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
  jumpButton.hidden = nearBottom
})

/* ──────────────────────────────── wiring ─────────────────────────────── */

async function refreshConnection() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'panel/state' })
    if (!state) return
    connected = Boolean(state.connected)
    port = state.port
    versionChip.textContent = `v${state.version}`
    if (!connected) statusLine.textContent = state.lastError || 'Offline'
    renderStatus()
  } catch {
    statusLine.textContent = 'Reload the extension'
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'chat/state') {
    disarmReplyWatchdog()
    entries = Array.isArray(message.entries) ? message.entries : []
    agentStatus = message.status || 'idle'
    // Approvals survive a worker restart because the Host includes them in
    // every snapshot; replacing the list keeps cards from leaking across turns.
    if (Array.isArray(message.approvals)) {
      approvals = message.approvals
      renderApprovals()
    }
    renderTranscript()
    renderStatus()
    return false
  }
  if (message?.type === 'chat/entry') {
    disarmReplyWatchdog()
    const entry = message.entry
    if (entry?.role === 'user' && Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      previewsByEntry.set(entry.id, previewQueue.splice(0, entry.attachments.length))
    }
    entries = [...entries, entry].slice(-300)
    watchForCapture(entry)
    renderTranscript()
    return false
  }
  if (message?.type === 'chat/status') {
    disarmReplyWatchdog()
    agentStatus = message.status || 'idle'
    renderStatus()
    return false
  }
  if (message?.type === 'chat/approval' && message.approval) {
    approvals = [...approvals.filter((entry) => entry.id !== message.approval.id), message.approval]
    renderApprovals()
    return false
  }
  if (message?.type === 'chat/approval/clear') {
    approvals = approvals.filter((entry) => entry.id !== message.id)
    renderApprovals()
    return false
  }
  if (message?.type === 'screenshot' && message.dataUrl) {
    shots = [...shots.filter((shot) => !shot.local), { path: message.path, dataUrl: message.dataUrl }].slice(-MAX_SHOTS)
    renderTranscript()
    return false
  }
  if (message?.type === 'chat/error') {
    disarmReplyWatchdog()
    previewQueue = []
    // Use the Host's status when present: a rejected send is idle, but a
    // failed cancel leaves the turn running and the user needs Stop back.
    agentStatus = typeof message.status === 'string' ? message.status : 'idle'
    showError(message.message)
    renderStatus()
    return false
  }
  return false
})

async function boot() {
  renderStatus()
  await refreshConnection()
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'chat/open' })
    if (reply?.ok) {
      if (Array.isArray(reply.entries)) entries = reply.entries
      if (Array.isArray(reply.approvals)) approvals = reply.approvals
      if (reply.screenshot?.dataUrl) shots = [reply.screenshot]
      agentStatus = reply.status || 'idle'
      renderTranscript()
      renderApprovals()
      renderStatus()
    }
  } catch {
    // The worker is starting; polling recovers.
  }
}

void boot()
setInterval(refreshConnection, 2500)
