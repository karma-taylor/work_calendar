import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
          <h1 style={{ color: '#b42318' }}>页面运行出错</h1>
          <p>请把下面信息截图或复制发给我，便于排查。</p>
          <pre
            style={{
              background: '#f8fafc',
              padding: 16,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {String(this.state.error?.message || this.state.error)}
            {this.state.error?.stack ? `\n\n${this.state.error.stack}` : ''}
          </pre>
          <button
            type="button"
            style={{ marginTop: 16, padding: '10px 16px', cursor: 'pointer' }}
            onClick={() => window.location.reload()}
          >
            刷新重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
