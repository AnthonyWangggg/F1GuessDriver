import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import RevealDialog from './RevealDialog.vue'
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false
    },
  })
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = false
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
it('focuses cancel, confirms only on click, supports Escape and returns focus', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const wrapper = mount(RevealDialog, {
    props: { open: true, busy: false },
    attachTo: document.body,
  })
  await flushPromises()
  const dialog = document.querySelector('dialog')!
  expect(dialog.open).toBe(true)
  const buttons = dialog.querySelectorAll('button')
  expect(document.activeElement).toBe(buttons[0])
  expect(wrapper.emitted('confirm')).toBeUndefined()
  buttons[0]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
  )
  expect(document.activeElement).toBe(buttons[1])
  buttons[1]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  )
  expect(document.activeElement).toBe(buttons[0])
  buttons[0]!.click()
  expect(wrapper.emitted('update:open')).toEqual([[false]])
  await wrapper.setProps({ open: false })
  await flushPromises()
  expect(document.activeElement).toBe(trigger)
  await wrapper.setProps({ open: true })
  await flushPromises()
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(wrapper.emitted('update:open')).toHaveLength(2)
  buttons[1]!.click()
  expect(wrapper.emitted('confirm')).toHaveLength(1)
  await wrapper.setProps({ busy: true })
  buttons[1]!.click()
  expect(wrapper.emitted('confirm')).toHaveLength(1)
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(wrapper.emitted('update:open')).toHaveLength(2)
  wrapper.unmount()
})
