import { useEffect, useState } from 'react'
import { getCloudAuthClient, isCloudEnabled, requestLoginLink } from './lib/cloudStore'

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined)
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!isCloudEnabled()) return undefined
    const client = getCloudAuthClient()
    client.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  if (!isCloudEnabled() || session) return children
  const signIn = async (event) => {
    event.preventDefault()
    setMessage('')
    try {
      const preflight = await requestLoginLink(email)
      if (!preflight.shouldSend) {
        setMessage('如果该邮箱获准访问，登录链接将会发送；请稍后查看邮箱。')
        return
      }
    } catch {
      setMessage('暂时无法请求登录链接，请稍后再试。')
      return
    }
    const { error } = await getCloudAuthClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    setMessage(error ? `登录链接发送失败：${error.message}` : '登录链接已发送，请在邮箱中打开链接后返回此页面。')
  }
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark" aria-hidden="true">日</div>
        <p className="auth-kicker">WORK CALENDAR</p>
        <h1 id="auth-title">登录排班日历</h1>
        <p className="auth-description">请输入已加入白名单的邮箱，我们会发送一个一次性登录链接。</p>
        <form className="auth-form" onSubmit={signIn}>
          <label htmlFor="email">工作邮箱</label>
          <input id="email" type="email" autoComplete="email" placeholder="name@company.com" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <button className="auth-submit" type="submit">发送登录链接</button>
        </form>
        {message && <p className="auth-message" role="status">{message}</p>}
        <p className="auth-note">仅限已获授权的团队成员访问</p>
      </section>
    </main>
  )
}
