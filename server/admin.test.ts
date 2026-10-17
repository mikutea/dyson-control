import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PasswordReader } from './admin.js'

describe('administrator CLI password input', () => {
  it('reads two piped password lines without consuming the second one early', async () => {
    const input = Readable.from(['correct horse battery staple\ncorrect horse battery staple\n'])
    const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const reader = new PasswordReader({}, input, output)
    expect(await reader.read('Password: ')).toBe('correct horse battery staple')
    expect(await reader.read('Confirm: ')).toBe('correct horse battery staple')
  })
})
