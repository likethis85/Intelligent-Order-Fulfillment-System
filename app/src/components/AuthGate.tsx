import { useEffect, useRef, useState } from 'react';
import { Layers, LogIn, QrCode } from 'lucide-react';
import App from '@/App';
import { API_BASE, AUTH_REQUIRED_EVENT, authenticatedFetch } from '@/lib/api-client';
import type { AuthSession } from '@/lib/api-client';

const errors: Record<string, string> = {
  login_failed: '这次登录未完成或已超时，请重新登录。',
  service_config: '统一登录暂时不可用，请联系管理员。',
  service_unavailable: '暂时无法连接统一登录，请稍后重试。',
  dingtalk_unavailable: '暂时无法打开钉钉登录，请重试或使用统一账号登录。',
};

function getCleanReturnTo(): string {
  try {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('returnTo');
    const raw = explicit || (location.pathname + location.search + location.hash);
    const parsed = new URL(raw, 'http://application.invalid');
    parsed.searchParams.delete('logged_out');
    parsed.searchParams.delete('sso_error');
    parsed.searchParams.delete('returnTo');
    const clean = parsed.pathname + parsed.search + parsed.hash;
    return clean && clean !== '/' ? clean : '/';
  } catch {
    return '/';
  }
}

// 会话过期（部署重启、超过 8 小时）时自动回统一登录走一圈：SSO 侧通常仍是登录状态，
// 用户几乎看不到登录页。60 秒内只跳一次，SSO 故障时退回到手动登录按钮，避免死循环。
const AUTO_RELOGIN_KEY = 'marius:sso-auto-relogin-at';
const AUTO_RELOGIN_WINDOW_MS = 60_000;

let reloginInFlight = false;

function autoRelogin(notify: (message: string) => void): boolean {
  if (reloginInFlight) return true; // 已经在跳转，并发 401 别再改提示
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(AUTO_RELOGIN_KEY) || 0);
  } catch {
    last = 0; // 隐私模式禁用 storage：当作没跳过
  }
  if (Number.isFinite(last) && last > 0 && Date.now() - last < AUTO_RELOGIN_WINDOW_MS) return false;
  try {
    sessionStorage.setItem(AUTO_RELOGIN_KEY, String(Date.now()));
  } catch {
    // 写不进去也要跳，否则过期后只能停在登录页
  }
  reloginInFlight = true;
  notify('登录状态已过期，正在重新登录…');
  location.assign('/api/auth/sso/start?' + new URLSearchParams({
    origin: location.origin,
    returnTo: getCleanReturnTo(),
  }));
  return true;
}

export default function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  // 主动退出登录时，退出请求前后的 401 不能触发自动重新登录，否则刚退出又被拉回来
  const loggingOut = useRef(false);
  // 只是「以前登录过」，用来区分「会话过期」和「第一次打开页面」
  const wasAuthenticated = useRef(false);
  const [message, setMessage] = useState(() => {
    const url = new URL(location.href);
    if (url.searchParams.has('logged_out')) return '已退出登录。';
    const error = url.searchParams.get('sso_error');
    return error ? errors[error] || errors.login_failed : '';
  });

  useEffect(() => {
    const url = new URL(location.href);
    let urlChanged = false;
    if (url.searchParams.has('sso_error')) {
      url.searchParams.delete('sso_error');
      urlChanged = true;
    }
    if (url.searchParams.has('logged_out')) {
      url.searchParams.delete('logged_out');
      setMessage('已退出登录。');
      urlChanged = true;
    }
    if (urlChanged) {
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    const controller = new AbortController();
    let alive = true;
    const check = async () => {
      if (busy) return;
      const checkedVersion = version.current;
      try {
        const response = await authenticatedFetch(API_BASE + '/auth/session', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('session_unavailable');
        const next = await response.json() as AuthSession;
        if (alive && checkedVersion === version.current) {
          const wasSignedIn = wasAuthenticated.current;
          wasAuthenticated.current = next.authenticated;
          setSession(next);
          if (!next.ssoConfigured) {
            setMessage('统一登录尚未配置，请联系管理员。');
          } else if (!next.authenticated && wasSignedIn && !loggingOut.current) {
            // 轮询发现掉线（后端重启/会话到期）也自动续登录，不用等用户点按钮
            if (!autoRelogin(setMessage)) setMessage('登录已过期，请重新登录。');
          } else {
            setMessage((current) => ['暂时无法连接系统，请稍后重试。', '统一登录尚未配置，请联系管理员。'].includes(current) ? '' : current);
          }
        }
      } catch {
        if (alive && checkedVersion === version.current) {
          setSession((current) => current?.authenticated ? current : { authenticated: false, ssoConfigured: true, user: null, expiresAt: null });
          setMessage('暂时无法连接系统，请稍后重试。');
        }
      } finally {
        if (alive) setLoading(false);
      }
    };

    const expired = () => {
      if (loggingOut.current) return;
      version.current++;
      setSession((current) => current ? { ...current, authenticated: false, user: null, expiresAt: null } : { authenticated: false, ssoConfigured: true, user: null, expiresAt: null });
      // 能进到这里说明之前是登录状态（只是会话过期），直接回 SSO 续上
      if (!autoRelogin(setMessage)) setMessage('登录已过期，请重新登录。');
    };

    const focused = () => { void check(); };
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    window.addEventListener('focus', focused);
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', focused);
      window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
    };
  }, [busy]);

  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt || !session.ssoConfigured) return;
    const timer = setTimeout(() => {
      version.current++;
      setSession((current) => current ? { ...current, authenticated: false, user: null, expiresAt: null } : null);
      if (!autoRelogin(setMessage)) setMessage('登录已过期，请重新登录。');
    }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session?.authenticated, session?.expiresAt, session?.ssoConfigured]);

  const logout = async () => {
    if (busy) return;
    loggingOut.current = true;
    version.current++;
    setBusy(true);
    try {
      await authenticatedFetch(API_BASE + '/auth/logout', { method: 'POST' }).catch(() => {});
    } catch {
      // 即使网络出现短暂抖动，也必须完成退出，不阻断用户
    }
    setSession(null);
    setMessage('已退出登录。');
    // 强制完整重置跳转至根路径，带时间戳避免浏览器缓存当前页面，确保完全退出
    window.location.replace('/?logged_out=' + Date.now());
  };

  if (!loading && session?.authenticated && session.user) {
    return <App key={session.user.id} user={session.user} onLogout={logout} logoutPending={busy} />;
  }

  const targetReturnTo = getCleanReturnTo();
  const loginUrl = '/api/auth/sso/start?' + new URLSearchParams({
    origin: location.origin,
    returnTo: targetReturnTo,
  });

  const showLoginButtons = !loading && (session?.ssoConfigured ?? true);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-bg px-4 py-10 text-ink-primary">
      <section className="w-full max-w-[420px] rounded-2xl border border-edge bg-white p-6 shadow-sm sm:p-8" aria-labelledby="login-title">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-subtle"><Layers size={23} aria-hidden="true" /></div>
          <div><div className="text-xl font-extrabold tracking-[0.12em]">Marius</div><p className="text-xs text-ink-muted">智慧货盘</p></div>
        </div>
        <h1 id="login-title" className="text-xl font-semibold">登录工作台</h1>
        <p className="mt-3 text-sm leading-6 text-ink-secondary">使用钉钉或公司统一账号，继续管理货盘与直播排品。</p>
        {message && <p role="alert" className="mt-5 rounded-lg bg-surface-subtle px-3 py-3 text-sm leading-6 text-ink-secondary">{message}</p>}
        {loading ? (
          <p role="status" className="mt-7 text-sm text-ink-muted">正在检查登录状态…</p>
        ) : showLoginButtons ? (
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
