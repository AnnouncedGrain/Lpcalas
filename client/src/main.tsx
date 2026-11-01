import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Desni klik meni browsera nam ne treba (osim u poljima za tekst).
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea, .message-content')) e.preventDefault();
});

// Bez StrictMode: u dev modu bi dvaput otvorio vezu prema serveru.
createRoot(document.getElementById('root')!).render(<App />);
