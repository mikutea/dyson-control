import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AlertCircle, Check, LoaderCircle, RefreshCw, X } from 'lucide-react'

export function Button({ variant = 'secondary', busy, disabled, icon, children, className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'quiet'; busy?: boolean; icon?: ReactNode }) {
  return (
    <button className={`button button-${variant} ${className}`} aria-label={typeof children === 'string' ? children : undefined} {...props} disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? <LoaderCircle className="spin" aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function Panel({ title, icon, action, className = '', children }: {
  title?: string; icon?: ReactNode; action?: ReactNode; className?: string; children: ReactNode
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && <header className="panel-header"><div>{icon}<h2>{title}</h2></div>{action}</header>}
      {children}
    </section>
  )
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="skeleton-list" aria-label="正在载入">{Array.from({ length: rows }, (_, index) => <div className="skeleton" key={index} />)}</div>
}

export function ErrorBlock({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="state-block state-error" role="alert">
      <AlertCircle aria-hidden />
      <div><strong>暂时无法显示</strong><p>{message}</p></div>
      <Button variant="quiet" icon={<RefreshCw />} onClick={retry}>重试</Button>
    </div>
  )
}

export function EmptyBlock({ title, description }: { title: string; description: string }) {
  return <div className="state-block"><Check aria-hidden /><div><strong>{title}</strong><p>{description}</p></div></div>
}

export function MetricBar({ value, tone = 'blue' }: { value: number | null; tone?: 'blue' | 'green' | 'amber' }) {
  return <div className={`metric-bar metric-${tone}`}><span style={{ width: value === null ? '0%' : `${Math.max(2, Math.min(100, value))}%` }} /></div>
}

export function StatusDot({ state }: { state: 'good' | 'warning' | 'bad' | 'muted' }) {
  return <span className={`status-dot status-${state}`} aria-hidden />
}

export function ConfirmDialog({ title, description, confirmLabel, danger = false, busy = false, onConfirm, onCancel }: {
  title: string; description: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}>
      <div ref={dialog} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description" onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel() }
        if (event.key !== 'Tab') return
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <button className="icon-button dialog-close" aria-label="关闭" disabled={busy} onClick={onCancel}><X /></button>
        <div className={`dialog-icon ${danger ? 'dialog-danger' : ''}`}><AlertCircle /></div>
        <h2 id="dialog-title">{title}</h2>
        <p id="dialog-description">{description}</p>
        <div className="dialog-actions">
          <Button onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

export function Toast({ message, tone = 'success', onDismiss }: { message: string; tone?: 'success' | 'error'; onDismiss: () => void }) {
  return <div className={`toast toast-${tone}`} role="status">{tone === 'success' ? <Check /> : <AlertCircle />}<span>{message}</span><button aria-label="关闭" onClick={onDismiss}><X /></button></div>
}
