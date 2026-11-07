export function isFreeModel(model) {
  return /-free$/.test(model || '')
}

const isOpenAiCompat = (provider) => provider === 'openai'

export function buildHeaders({ model, apiKey }) {
  const headers = { 'Content-Type': 'application/json' }
  const key = isFreeModel(model) ? '' : (apiKey || '').trim()
  if (key) {
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 502, 503, 504])
const TRANSIENT_PATTERNS = /temporarily unavailable|rate limit|overloaded|timeout|busy|capacity|queue|service unavailable/i

function isTransientError(status, message) {
  if (TRANSIENT_STATUSES.has(status)) return true
  return TRANSIENT_PATTERNS.test(message)
}

const HTTP_STATUS_MESSAGES = {
  400: 'HTTP 400 Bad Request',
  401: 'HTTP 401 Unauthorized',
  403: 'HTTP 403 Forbidden',
  404: 'HTTP 404 Not Found',
  408: 'HTTP 408 Request Timeout',
  409: 'HTTP 409 Conflict',
  413: 'HTTP 413 Payload Too Large',
  415: 'HTTP 415 Unsupported Media Type',
  422: 'HTTP 422 Unprocessable Entity',
  429: 'HTTP 429 Too Many Requests',
  500: 'HTTP 500 Internal Server Error',
  501: 'HTTP 501 Not Implemented',
  502: 'HTTP 502 Bad Gateway',
  503: 'HTTP 503 Service Unavailable',
  504: 'HTTP 504 Gateway Timeout'
}

export function friendlyErrorMessage(raw, status) {
  const msg = String(raw || '').trim()
  
  const netMatch = msg.match(/net::(ERR_[A-Z_]+)_?$/i)
  if (netMatch) {
    const code = netMatch[1].toUpperCase().replace(/_$/, '')
    switch (code) {
      case 'ERR_CONNECTION_REFUSED': return 'Connection refused'
      case 'ERR_CONNECTION_TIMED_OUT': return 'Connection timed out'
      case 'ERR_CONNECTION_RESET': return 'Connection reset by peer'
      case 'ERR_CONNECTION_ABORTED': return 'Network connection lost'
      case 'ERR_INTERNET_DISCONNECTED':
      case 'ERR_NETWORK_CHANGED':
      case 'ERR_DISCONNECTED': return 'Network connection lost'
      case 'ERR_NAME_NOT_RESOLVED':
      case 'ERR_NAME_RESOLUTION_FAILED': return 'DNS resolution failed'
      case 'ERR_NETWORK_UNAVAILABLE':
      case 'ERR_ADDRESS_UNREACHABLE':
      case 'ERR_NO_NETWORK': return 'Network unavailable'
      case 'ERR_SSL_PROTOCOL_ERROR':
      case 'ERR_CERT_AUTHORITY_INVALID': return 'Failed to establish connection'
    }
  }
  if (/^Failed to fetch|ERR_(INTERNET_DISCONNECTED|NETWORK|NAME_|CONNECTION|ADDRESS_|NO_NETWORK)/i.test(msg)
    || /econnrefused|econnreset|etimedout|enotfound|eai_again|ehs\b|network|fetch failed|error in the http request|ssl|handshake|certificate/i.test(msg)) {
    if (/timed?[- ]?out|timeout/i.test(msg)) return 'Connection timed out'
    if (/refused/i.test(msg)) return 'Connection refused'
    if (/reset|peer/i.test(msg)) return 'Connection reset by peer'
    if (/dns|resolve|getaddrinfo|enotfound|eai_again/i.test(msg)) return 'DNS resolution failed'
    return 'Connection failed'
  }
  if (/socket hang ?up/i.test(msg)) return 'Socket hang up'
  if (/premature close|aborted|closed before the response/i.test(msg)) return 'Remote server disconnected'
  if (/unexpected end|end of stream|stream.*(?:interrupt|clos|lost|fail)|failed to (?:read|parse).*(?:stream|chunk)|(?:invalid|decod).*(?:stream|chunk)/i.test(msg)) {
    return 'Stream interrupted'
  }
  if (status && HTTP_STATUS_MESSAGES[status]) return HTTP_STATUS_MESSAGES[status]
  const httpMatch = msg.match(/^HTTP\s+(\d{3})/i)
  if (httpMatch && HTTP_STATUS_MESSAGES[httpMatch[1]]) return HTTP_STATUS_MESSAGES[httpMatch[1]]
  if (/overload/i.test(msg)) return 'Server overloaded'
  if (/temporarily unavailable/i.test(msg)) return 'Server temporarily unavailable'
  if (/upstream/i.test(msg)) return 'Upstream connection failure'
  if (/backend/i.test(msg)) return 'Backend service unavailable'
  if (/internal processing/i.test(msg)) return 'Internal processing error'
  
  return 'Something went wrong. An unexpected error occurred.'
}

function textFromValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFromValue).join('')
  if (value && typeof value === 'object') {
    for (const key of ['text', 'content', 'reasoning_content', 'reasoning', 'thinking', 'summary']) {
      const text = textFromValue(value[key])
      if (text) return text
    }
  }
  return ''
}

function collectReasoning(source) {
  const parts = []
  const add = (value) => {
    const text = textFromValue(value)
    if (text && !parts.includes(text)) parts.push(text)
  }
  add(source?.reasoning_content)
  add(source?.reasoning)
  add(source?.thinking)
  if (Array.isArray(source?.reasoning_details)) {
    source.reasoning_details.forEach((detail) => add(detail?.text ?? detail?.content ?? detail))
  }
  return parts.join('')
}

function mergeReasoning(...values) {
  const parts = []
  values.forEach((value) => {
    const text = textFromValue(value)
    if (text && !parts.includes(text)) parts.push(text)
  })
  return parts.join('')
}

function splitEmbeddedReasoning(value) {
  const text = textFromValue(value)
  const content = []
  const reasoning = []
  let cursor = 0
  let inReasoning = false
  const tagPattern = /<\/?(?:think|thinking|analysis|reasoning)>/gi
  let match
  while ((match = tagPattern.exec(text))) {
    ;(inReasoning ? reasoning : content).push(text.slice(cursor, match.index))
    inReasoning = match[0][1] !== '/'
    cursor = tagPattern.lastIndex
  }
  ;(inReasoning ? reasoning : content).push(text.slice(cursor))
  return { content: content.join(''), reasoning: reasoning.join('') }
}

function createContentRouter(onChunk, onReasoning) {
  const tagCandidates = [
    '<think>', '</think>', '<thinking>', '</thinking>',
    '<analysis>', '</analysis>', '<reasoning>', '</reasoning>'
  ]
  const tagPattern = /<\/?(?:think|thinking|analysis|reasoning)>/i
  let pending = ''
  let inReasoning = false

  const emit = (text) => {
    if (!text) return
    if (inReasoning) onReasoning?.(text)
    else onChunk?.(text)
  }

  const partialTagLength = (text) => {
    const lower = text.toLowerCase()
    for (let length = Math.min(lower.length, 12); length > 0; length -= 1) {
      const suffix = lower.slice(-length)
      if (tagCandidates.some((tag) => tag.startsWith(suffix))) return length
    }
    return 0
  }

  const feed = (value) => {
    const text = textFromValue(value)
    if (!text) return
    pending += text
    while (true) {
      const match = pending.match(tagPattern)
      if (!match) break
      emit(pending.slice(0, match.index))
      inReasoning = match[0][1] !== '/'
      pending = pending.slice(match.index + match[0].length)
    }
    const keep = partialTagLength(pending)
    emit(pending.slice(0, pending.length - keep))
    pending = pending.slice(pending.length - keep)
  }

  const flush = () => {
    emit(pending)
    pending = ''
  }

  return { feed, flush }
}

export async function chatSend({ url, model, messages, provider, apiKey, envConfig }) {
  const headers = buildHeaders({ model, apiKey, envConfig })
  const isOpenAI = isOpenAiCompat(provider)
  let attempt = 0
  const maxAttempts = 5
  while (true) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, stream: false })
      })
    } catch (err) {
      const msg = err.message || 'Network error'
      if (attempt < maxAttempts - 1 && /ssl|handshake|certificate|network|econnreset|etimedout|enotfound/i.test(msg)) {
        attempt += 1
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      return { ok: false, error: friendlyErrorMessage(msg) }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const error = data?.error?.message || data?.error || `HTTP ${res.status}`
      if (attempt < maxAttempts - 1 && isTransientError(res.status, error)) {
        attempt += 1
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      return { ok: false, error: friendlyErrorMessage(error, res.status), status: res.status }
    }
    const data = await res.json().catch(() => null)
    const error = data?.error?.message || data?.error || null
    if (error && isTransientError(res.status, error) && attempt < maxAttempts - 1) {
      attempt += 1
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      continue
    }
    if (error) return { ok: false, error: friendlyErrorMessage(error, res.status), status: res.status }
    const responseMessage = isOpenAI ? data?.choices?.[0]?.message : data?.message
    const embedded = splitEmbeddedReasoning(responseMessage?.content)
    const content = embedded.content
    const reasoning = mergeReasoning(collectReasoning(responseMessage), embedded.reasoning)
    return { ok: true, data: { message: { content }, reasoning } }
  }
}

export async function chatSendStream({ url, model, messages, provider, apiKey, envConfig }, { signal, onChunk, onReasoning }) {
  const headers = buildHeaders({ model, apiKey, envConfig })
  const isOpenAI = isOpenAiCompat(provider)
  let attempt = 0
  const maxAttempts = 5
  let res
  while (true) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, stream: true })
      })
    } catch (err) {
      const msg = err.message || 'Network error'
      if (attempt < maxAttempts - 1 && /ssl|handshake|certificate|network|econnreset|etimedout|enotfound/i.test(msg)) {
        attempt += 1
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      return { ok: false, error: friendlyErrorMessage(msg) }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      const error = data?.error?.message || data?.error || `HTTP ${res.status}`
      if (attempt < maxAttempts - 1 && isTransientError(res.status, error)) {
        attempt += 1
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      return { ok: false, error: friendlyErrorMessage(error, res.status), status: res.status }
    }
    break
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const contentRouter = createContentRouter(onChunk, onReasoning)

  let aborted = false
  if (signal) {
    if (signal.aborted) aborted = true
    signal.addEventListener('abort', () => { aborted = true })
  }

  const routeContent = (text) => contentRouter.feed(text)

  try {
    while (true) {
      if (aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf(isOpenAI ? '\n\n' : '\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + (isOpenAI ? 2 : 1))
        if (!block.trim()) continue
        if (isOpenAI) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let chunk
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }
            const delta = chunk.choices?.[0]?.delta
            const reasoning = collectReasoning(delta)
            if (reasoning) onReasoning(reasoning)
            routeContent(delta?.content)
          }
        } else {
          let chunk
          try {
            chunk = JSON.parse(block)
          } catch {
            continue
          }
          const reasoning = collectReasoning(chunk.message)
          if (reasoning) onReasoning(reasoning)
          routeContent(chunk.message?.content)
        }
      }
    }
  } catch (err) {
    
    if (err.name !== 'AbortError') {
      contentRouter.flush()
      return { ok: false, error: friendlyErrorMessage(err.message) }
    }
    aborted = true
  }
  contentRouter.flush()
  if (aborted) {
    return { ok: true, aborted: true }
  }
  return { ok: true }
}

export async function webFetchStream(url, { signal, onChunk, onReasoning }) {
  let res
  try {
    res = await fetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
  } catch (err) {
    return { ok: false, error: friendlyErrorMessage(err.message) }
  }
  if (!res.ok) return { ok: false, error: friendlyErrorMessage(null, res.status) }

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('text') && !contentType.includes('json')) {
    return { ok: false, error: `Unsupported content type: ${contentType}` }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const contentRouter = createContentRouter(onChunk, onReasoning)

  const routeContent = (text) => contentRouter.feed(text)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      routeContent(decoder.decode(value, { stream: true }))
    }
  } catch (err) {
    contentRouter.flush()
    if (err.name === 'AbortError') return { ok: true, aborted: true }
    return { ok: false, error: friendlyErrorMessage(err.message) }
  }
  contentRouter.flush()
  return { ok: true }
}

export async function googleSearch(query, apiKey, cx) {
  const params = new URLSearchParams({ key: apiKey, cx, q: query, num: '8' })
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`)
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    return { ok: false, error: friendlyErrorMessage(data?.error?.message || data?.error, res.status) }
  }
  const results = (data.items || []).map((item) => ({
    title: item.title || '',
    snippet: item.snippet || '',
    link: item.link || ''
  }))
  return { ok: true, results }
}
