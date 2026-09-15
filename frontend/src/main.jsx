import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import DeckApp from './DeckApp.jsx'
import './index.css'

// Route guard: `?classic=1` renders the earlier, simpler page untouched, as a fallback if
// the deck UI misbehaves.
// Everything else renders the new deck. No router dependency — one query-string check.
const useClassic = new URLSearchParams(window.location.search).get('classic') === '1'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {useClassic ? <App /> : <DeckApp />}
  </React.StrictMode>,
)
