import { useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import { Button } from './components'

export function Login({ source, onLogin }: { source: 'demo' | 'windows'; onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password) { setError('请输入管理员密码'); return }
    setBusy(true)
    setError(null)
    try { await onLogin(password) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法登录，请稍后重试') }
    finally { setBusy(false) }
  }

  return (
    <main className="login-page">
      <div className="login-space" aria-hidden><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="planet" /></div>
      <section className="login-panel">
        <div className="login-brand"><span className="brand-mark"><i /><i /></span><span>Dyson Control</span></div>
        {source === 'demo' && <div className="login-demo">演示环境</div>}
        <div className="login-copy"><h1>欢迎回来</h1><p>登录后管理服务器、存档和客户端。</p></div>
        <form onSubmit={submit}>
          <label htmlFor="password">管理员密码</label>
          <div className={`password-field ${error ? 'field-error' : ''}`}>
            <LockKeyhole aria-hidden />
            <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" />
            <button type="button" aria-label={show ? '隐藏密码' : '显示密码'} onClick={() => setShow((value) => !value)}>{show ? <EyeOff /> : <Eye />}</button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" variant="primary" busy={busy} icon={<ArrowRight />}>登录</Button>
        </form>
        <footer><ShieldCheck />管理员专用入口</footer>
      </section>
    </main>
  )
}
