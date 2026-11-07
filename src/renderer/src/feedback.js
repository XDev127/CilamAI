let localeData = {}
let currentTheme = 'dark'

function applyTheme(themeName) {
  if (themeName) currentTheme = themeName
  const resolved = currentTheme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : currentTheme
  document.documentElement.dataset.theme = resolved
}

async function loadTheme() {
  try {
    const raw = localStorage.getItem('cilamai-settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.theme) currentTheme = parsed.theme
    }
  } catch {}

  if (window.electron?.getTheme) {
    try {
      const res = await window.electron.getTheme()
      if (res?.theme) currentTheme = res.theme
    } catch {}
  }
  applyTheme()
}

if (window.electron?.onThemeChange) {
  window.electron.onThemeChange((t) => applyTheme(t))
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme === 'system') applyTheme()
})

async function loadLocale() {
  let lang = 'en'
  try {
    const raw = localStorage.getItem('cilamai-settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.language) lang = parsed.language
    }
  } catch {}

  try {
    const res = await fetch(`./lang/${lang}.json`)
    localeData = res.ok ? await res.json() : {}
  } catch {
    localeData = {}
  }

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (localeData[key]) el.textContent = localeData[key]
  })

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder')
    if (localeData[key]) el.setAttribute('placeholder', localeData[key])
  })
}

function showToast(msg) {
  const toast = document.createElement('div')
  toast.className = 'notification-toast'
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 2500)
}

function init() {
  loadTheme()
  loadLocale()

  document.documentElement.dataset.theme = currentTheme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : currentTheme

  const typeRadios = document.querySelectorAll('input[name="feedback-type"]')
  const stepsGroup = document.querySelector('#feedback-steps-group')
  const msgInput = document.querySelector('#feedback-message')
  const attachTrigger = document.querySelector('#feedback-attach-trigger')
  const fileInput = document.querySelector('#feedback-file-input')
  const filePreview = document.querySelector('#feedback-file-preview')
  const removeFileBtn = document.querySelector('#feedback-file-remove')
  const previewFilename = document.querySelector('.preview-filename')
  const cancelBtn = document.querySelector('#feedback-cancel-btn')
  const githubBtn = document.querySelector('#feedback-github-btn')
  const form = document.querySelector('#feedback-form')
  const thanksPanel = document.querySelector('#feedback-thanks')
  const feedbackTitle = document.querySelector('.feedback-title')
  const titlebar = document.querySelector('.win11-titlebar')

  typeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.value === 'bug') {
        if (stepsGroup) stepsGroup.hidden = false
        if (msgInput) msgInput.placeholder = localeData?.feedbackDescPlaceholder || 'Describe the bug you encountered...'
      } else if (radio.value === 'feature') {
        if (stepsGroup) stepsGroup.hidden = true
        if (msgInput) msgInput.placeholder = 'Describe the feature you would like to see...'
      } else {
        if (stepsGroup) stepsGroup.hidden = true
        if (msgInput) msgInput.placeholder = 'Share your thoughts, suggestions, or experience...'
      }
    })
  })

  if (attachTrigger && fileInput) {
    attachTrigger.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file && filePreview && previewFilename) {
        previewFilename.textContent = file.name
        filePreview.hidden = false
        attachTrigger.hidden = true
      }
    })
  }

  if (removeFileBtn && fileInput && filePreview && attachTrigger) {
    removeFileBtn.addEventListener('click', () => {
      fileInput.value = ''
      filePreview.hidden = true
      attachTrigger.hidden = false
    })
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      window.electron?.closeWindow?.() || window.close()
    })
  }

  const win11Close = document.querySelector('#win11-close-btn')
  if (win11Close) {
    win11Close.addEventListener('click', () => {
      window.electron?.closeWindow?.() || window.close()
    })
  }

  if (githubBtn) {
    githubBtn.addEventListener('click', () => {
      window.electron?.openExternal?.('https://github.com/CilamAI/CilamAI/issues/new/choose')
    })
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const msg = msgInput?.value?.trim()
      if (!msg) return

      const typeRadio = [...typeRadios].find((r) => r.checked)
      const type = typeRadio?.value || 'general'
      const steps = document.querySelector('#feedback-steps')?.value?.trim() || ''
      const fileName = previewFilename?.textContent?.trim() || ''
      const hasScreenshot = !filePreview?.hidden && fileName

      const typeLabel = {
        bug: 'Bug Report',
        feature: 'Feature Request',
        general: 'General Feedback'
      }[type] || 'Feedback'

      let body = `**Type:** ${typeLabel}\n\n**Description:**\n${msg}`
      if (steps) body += `\n\n**Steps to reproduce:**\n${steps}`
      if (hasScreenshot) body += `\n\n**Attachment:** ${fileName}`

      const url = `https://github.com/CilamAI/CilamAI/issues/new?title=${encodeURIComponent(typeLabel)}&body=${encodeURIComponent(body)}`
      window.electron?.openExternal?.(url)

      form.reset()
      if (form) form.hidden = true
      if (feedbackTitle) feedbackTitle.hidden = true
      if (thanksPanel) thanksPanel.hidden = false
      if (titlebar) {
        const titleEl = titlebar.querySelector('.win11-titlebar-title')
        if (titleEl) titleEl.textContent = localeData?.feedbackThanksTitle || 'Thank you!'
      }
      window.electron?.resizeFeedbackWindow?.(500, 320)
    })
  }
}

document.addEventListener('DOMContentLoaded', init)
