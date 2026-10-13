import { useEffect, useRef, useState } from 'react';
import { Layers, LogIn, QrCode } from 'lucide-react';
import { toast } from 'sonner';
import App from '@/App';
import { API_BASE, AUTH_REQUIRED_EVENT, authenticatedFetch } from '@/lib/api-client';
import type { AuthSession } from '@/lib/api-client';

const errors: Record<string, string> = {
  login_failed: '这次登录未完成或已超时，请重新登录。',
  service_config: '统一登录暂时不可用，请联系管理员。',
  service_unavailable: '暂时无法连接统一登录，请稍后重试。',
  dingtalk_unavailable: '暂时无法打开钉钉登录，请重试或使用统一账号登录。',
};

export default function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const [message, setMessage] = useState(() => {
    const url = new URL(location.href);
    const error = url.searchParams.get('sso_error');
    return error ? errors[error] || errors.login_failed : '';
  });

  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.has('sso_error')) {
      url.searchParams.delete('sso_error');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    const controller = new AbortController();
    let alive = true;
    const check = async () => {
      const checkedVersion = version.current;
      try {
        const response = await authenticatedFetch(API_BASE + '/auth/session', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('session_unavailable');
        const next = await response.json() as AuthSession;
        if (alive && checkedVersion === version.current) {
          setSession(next);
          if (!next.ssoConfigured) setMessage('统一登录尚未配置，请联系管理员。');
          else setMessage((current) => ['暂时无法连接系统，请稍后重试。', '统一登录尚未配置，请联系管理员。'].includes(current) ? '' : current);
        }
      } catch {
        if (alive && checkedVersion === version.current) {
          setSession((current) => current?.authenticated ? current : null);
          setMessage('暂时无法连接系统，请稍后重试。');
        }
      } finally { if (alive) setLoading(false); }
    };
    const expired = () => {
      version.current++;
      setSession((current) => current ? { ...current, authenticated: false, user: null, expiresAt: null } : null);
      setMessage('登录已过期，请重新登录。');
    };
    const focused = () => { void check(); };
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    window.addEventListener('focus', focused);
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => {
      alive = false; controller.abort(); clearInterval(timer);
      window.removeEventListener('focus', focused);
      window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
    };
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    const timer = setTimeout(() => {
      version.current++;
      setSession((current) => current ? { ...current, authenticated: false, user: null, expiresAt: null } : null);
      setMessage('登录已过期，请重新登录。');
    }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session?.authenticated, session?.expiresAt]);

  const logout = async () => {
    if (busy) return;
    version.current++;
    setBusy(true);
    try {
      const response = await authenticatedFetch(API_BASE + '/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('logout_failed');
      setSession((current) => current ? { ...current, authenticated: false, user: null, expiresAt: null } : null);
      setMessage('已退出登录。');
    } catch { toast.error('退出失败，请稍后重试。'); }
    finally { setBusy(false); }
  };

  if (!loading && session?.authenticated && session.user) {
    return <App key={session.user.id} user={session.user} onLogout={logout} logoutPending={busy} />;
  }

  const loginUrl = '/api/auth/sso/start?' + new URLSearchParams({ origin: location.origin, returnTo: location.pathname + location.search + location.hash });
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-bg px-4 py-10 text-ink-primary">
      <section className="w-full max-w-[420px] rounded-2xl border border-edge bg-white p-6 shadow-sm sm:p-8" aria-labelledby="login-title">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-subtle"><Layers size={23} aria-hidden="true" /></div>
          <div><div className="text-xl font-extrabold tracking-[0.12em]">Marius</div><p className="text-xs text-ink-muted">智慧货盘选款系统</p></div>
        </div>
        <h1 id="login-title" className="text-xl font-semibold">登录工作台</h1>
        <p className="mt-3 text-sm leading-6 text-ink-secondary">使用钉钉或公司统一账号，继续管理货盘与直播排品。</p>
        {message && <p role="alert" className="mt-5 rounded-lg bg-surface-subtle px-3 py-3 text-sm leading-6 text-ink-secondary">{message}</p>}
        {loading ? <p role="status" className="mt-7 text-sm text-ink-muted">正在检查登录状态…</p> : session?.ssoConfigured ? (
          <div className="mt-7 space-y-3">
            <a href={loginUrl + '&provider=dingtalk'} className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-action-primary px-4 py-3 text-sm font-semibold text-white hover:bg-action-primary-hover"><QrCode size={18} aria-hidden="true" />钉钉登录</a>
            <a href={loginUrl} className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-edge px-4 py-3 text-sm font-medium hover:bg-surface-subtle"><LogIn size={18} aria-hidden="true" />统一账号登录</a>
          </div>
        ) : (
          <button type="button" onClick={() => location.reload()} className="mt-7 min-h-12 w-full rounded-lg border border-edge px-4 py-3 text-sm font-medium">重新检查</button>
        )}
        <p className="mt-5 text-center text-xs leading-5 text-ink-muted">使用公司统一账号安全登录</p>
      </section>
    </main>
  );
}
