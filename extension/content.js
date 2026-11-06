/**
 * Injected page agent. Runs in an isolated world, so `__dshAgent` is invisible to
 * page scripts and page scripts cannot reach the refs or rewrite the outline.
 *
 * The visible surface is a handful of synchronous/async operations the service
 * worker calls through chrome.scripting. Refs are page-scoped and are rebuilt by
 * every snapshot, which keeps stale-ref failures obvious.
 */
(() => {
  if (globalThis.__dshAgent) return

  const MAX_VISITED = 6000
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link'])
  const ACTIONABLE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'tab', 'switch', 'option', 'spinbutton', 'slider', 'treeitem'
  ])

  const refs = new Map()
  let nextRef = 1

  function tagOf(el) {
    return el.tagName ? el.tagName.toLowerCase() : ''
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().toLowerCase()
    const tag = tagOf(el)
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'file') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'hidden') return null
      return 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    return null
  }

  function labelFromIds(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    if (ids.length === 0) return ''
    return ids.map((id) => document.getElementById(id)?.innerText || '').join(' ').replace(/\s+/g, ' ').trim()
  }

  function labelFromElement(el) {
    if (el.labels && el.labels.length > 0) {
      return [...el.labels].map((label) => label.innerText || '').join(' ').replace(/\s+/g, ' ').trim()
    }
    return ''
  }

  function clean(text, max = 120) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    return value.length > max ? value.slice(0, max - 1) + '…' : value
  }

  function accessibleName(el, role) {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clean(aria)
    const labelled = labelFromIds(el)
    if (labelled) return clean(labelled)
    const label = labelFromElement(el)
    if (label) return clean(label)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return clean(placeholder)
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return clean(alt)
    const tag = tagOf(el)
    if (role === 'button' && (tag === 'input')) {
      const value = el.getAttribute('value')
      if (value && value.trim()) return clean(value)
    }
    const title = el.getAttribute('title')
    if (title && title.trim()) return clean(title)
    const text = el.innerText || el.textContent
    if (text && text.trim()) return clean(text, 100)
    return ''
  }

  function isVisible(el) {
    if (!el.isConnected) return false
    if (el.hidden) return false
    if (el.closest('[aria-hidden="true"]')) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function stateFlags(el) {
    const flags = []
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled')
    if (roleOf(el) === 'checkbox' || roleOf(el) === 'radio' || roleOf(el) === 'switch') {
      if (el.checked || el.getAttribute('aria-checked') === 'true') flags.push('checked')
    }
    const expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true' || expanded === 'false') flags.push('expanded=' + expanded)
    const pressed = el.getAttribute('aria-pressed')
    if (pressed === 'true') flags.push('pressed')
    return flags
  }

  function valueOf(el) {
    const tag = tagOf(el)
    if (tag !== 'input' && tag !== 'textarea') return ''
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'password') return ''
    const value = el.value
    if (!value) return ''
    return `value="${clean(value, 60)}"`
  }

  function hrefOf(el) {
    if (tagOf(el) !== 'a') return ''
    const href = el.getAttribute('href')
    if (!href || href.startsWith('javascript:')) return ''
    return `href="${clean(href, 100)}"`
  }

  function describeLine(el, role) {
    const name = accessibleName(el, role)
    const parts = []
    if (name) parts.push(JSON.stringify(name))
    if (role === 'heading') parts.push(`level=${el.tagName.slice(1)}`)
    const value = valueOf(el)
    if (value) parts.push(value)
    const href = hrefOf(el)
    if (href) parts.push(href)
    parts.push(...stateFlags(el))
    return parts.join(' ').trim()
  }

  function walk(el, level, lines, budget, visited) {
    for (const child of el.children) {
      if (lines.lines.length >= budget) return
      visited.count += 1
      if (visited.count > MAX_VISITED) return
      const tag = tagOf(child)
      if (SKIP_TAGS.has(tag)) continue

      const role = roleOf(child)
      let childLevel = level
      if (role) {
        if (!isVisible(child)) {
          // Hidden subtrees cannot be interacted with; skip them wholesale.
          continue
        }
        const actionable = ACTIONABLE.has(role)
        const ref = actionable ? `e${nextRef++}` : ''
        if (actionable) refs.set(ref, child)
        const description = describeLine(child, role)
        const indent = '  '.repeat(level)
        lines.lines.push(`${indent}- ${role}${description ? ' ' + description : ''}${ref ? ` [ref=${ref}]` : ''}`)
        lines.chars += lines.lines[lines.lines.length - 1].length + 1
        childLevel = level + 1
      }
      walk(child, childLevel, lines, budget, visited)
    }
  }

  function snapshot(args = {}) {
    refs.clear()
    nextRef = 1
    const budget = Number.isInteger(args.maxLines) ? args.maxLines : 400
    const lines = { lines: [], chars: 0 }
    const visited = { count: 0 }
    walk(document.body || document.documentElement, 0, lines, budget, visited)
    let text = lines.lines.join('\n')
    let truncated = false
    const maxChars = Number.isInteger(args.maxChars) ? args.maxChars : 20000
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n… (truncated)'
      truncated = true
    }
    if (lines.lines.length >= budget) truncated = true
    const scroll = {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewport: window.innerHeight
    }
    const header = [
      `url: ${location.href}`,
      `title: ${document.title || '(untitled)'}`,
      `viewport: ${window.innerWidth}x${window.innerHeight} scroll ${scroll.y}/${scroll.height}`,
      `nodes: ${lines.lines.length}${truncated ? ' (truncated)' : ''}`
    ].join('\n')
    return {
      url: location.href,
      title: document.title,
      text: header + '\n\n' + text,
      nodes: lines.lines.length,
      truncated
    }
  }

  function read(args = {}) {
    const maxChars = Number.isInteger(args.maxChars) ? args.maxChars : 20000
    const raw = (document.body ? document.body.innerText : '') || ''
    const normalized = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    const truncated = normalized.length > maxChars
    return {
      url: location.href,
      title: document.title,
      text: truncated ? normalized.slice(0, maxChars) + '\n… (truncated)' : normalized,
      length: normalized.length,
      truncated
    }
  }

  function elementFor(target) {
    if (target && target.ref) {
      const el = refs.get(target.ref)
      if (!el) {
        throw new Error(`Ref ${target.ref} is not available. Take a new browser_snapshot; refs are rebuilt by every snapshot.`)
      }
      return el
    }
    if (target && target.selector) {
      let el = null
      try {
        el = document.querySelector(target.selector)
      } catch {
        throw new Error(`"${target.selector}" is not a valid CSS selector.`)
      }
      if (!el) throw new Error(`No element matches "${target.selector}".`)
      return el
    }
    throw new Error('No target element: pass a ref from browser_snapshot or a CSS selector.')
  }

  function summarize(el) {
    const role = roleOf(el) || tagOf(el)
    const name = accessibleName(el, role)
    return name ? `${role} "${name}"` : role
  }

  function click(args) {
    const el = elementFor(args)
    if (el.disabled) throw new Error(`Cannot click a disabled ${summarize(el)}.`)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    el.click()
    return { ok: true, matched: summarize(el), url: location.href, title: document.title }
  }

  function type(args) {
    const el = elementFor(args)
    if (el.disabled || el.readOnly) throw new Error(`Cannot type into a disabled or read-only ${summarize(el)}.`)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    el.focus({ preventScroll: true })
    const text = String(args.text ?? '')

    if (el.isContentEditable) {
      if (args.clear !== false) {
        el.textContent = ''
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      const inserted = document.execCommand('insertText', false, text)
      if (!inserted) el.textContent = (args.clear === false ? el.textContent : '') + text
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const next = args.clear === false ? String(el.value ?? '') + text : text
      if (setter) setter.call(el, next)
      else el.value = next
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    if (args.submit) submitFrom(el)
    return { ok: true, matched: summarize(el), value: 'value' in el ? el.value : el.textContent, url: location.href }
  }

  function submitFrom(el) {
    const form = el.form || el.closest('form')
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit()
      return
    }
    press({ key: 'Enter' })
  }

  function press(args) {
    const key = String(args.key || '')
    if (!key) throw new Error('browser_press needs a key.')
    const init = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true }
    const el = document.activeElement || document.body
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keypress', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
    if (key === 'Enter') {
      const form = el.form || el.closest?.('form')
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
    }
    return { ok: true, key, url: location.href }
  }

  async function scroll(args) {
    const amount = Number.isInteger(args.amount) ? args.amount : 600
    const direction = args.direction || 'down'
    const y = window.scrollY
    if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' })
    else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
    else if (direction === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' })
    else window.scrollBy({ top: amount, behavior: 'smooth' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    return {
      ok: true,
      direction,
      from: Math.round(y),
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewport: window.innerHeight
    }
  }

  async function waitFor(args) {
    const timeoutMs = Number.isInteger(args.timeoutMs) ? args.timeoutMs : 10000
    const deadline = Date.now() + timeoutMs
    const text = args.text ? String(args.text) : ''
    const selector = args.selector ? String(args.selector) : ''
    while (Date.now() < deadline) {
      if (selector) {
        try {
          if (document.querySelector(selector)) return { found: true, what: selector, elapsedMs: timeoutMs - (deadline - Date.now()) }
        } catch {
          throw new Error(`"${selector}" is not a valid CSS selector.`)
        }
      } else if (text) {
        const body = document.body ? document.body.innerText : ''
        if (body.includes(text)) return { found: true, what: text, elapsedMs: timeoutMs - (deadline - Date.now()) }
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { found: false, what: selector || text, elapsedMs: timeoutMs }
  }

  globalThis.__dshAgent = { version: 1, snapshot, read, click, type, press, scroll, waitFor }
})()
