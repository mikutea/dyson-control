export function downloadText(fileName: string, contents: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', contents], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
