import { onMounted, onBeforeUnmount } from 'vue'
/** Layout-only keyboard accommodation; never used for authority or game timers. */
export function useVisualViewport() {
  const update = () => {
    const viewport = window.visualViewport
    document.documentElement.style.setProperty(
      '--visual-height',
      `${viewport?.height ?? window.innerHeight}px`,
    )
    document.documentElement.style.setProperty('--visual-top', `${viewport?.offsetTop ?? 0}px`)
  }
  onMounted(() => {
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
  })
}
