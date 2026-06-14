import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false } }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(err, info) { console.error('App crash:', err, info) }
  render() {
    if (this.state.hasError) {
      return React.createElement('div', { style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, fontFamily: 'system-ui' } },
        React.createElement('div', { style: { fontSize: 18, fontWeight: 700, color: '#1e293b' } }, 'Something went wrong'),
        React.createElement('div', { style: { fontSize: 13, color: '#64748b' } }, 'Please refresh the page to continue.'),
        React.createElement('button', { onClick: () => window.location.reload(), style: { padding: '8px 20px', borderRadius: 8, border: 'none', background: '#f97316', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 } }, 'Refresh')
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
