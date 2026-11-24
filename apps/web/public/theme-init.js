// Run before app styles/modules to avoid painting the wrong initial theme.
;(() => {
  let preference
  try {
    preference = localStorage.getItem('driver-guess:theme')
  } catch {
    /* Browser storage can be unavailable. */
  }
  const manual = preference === 'light' || preference === 'dark'
  const dark = manual
    ? preference === 'dark'
    : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
