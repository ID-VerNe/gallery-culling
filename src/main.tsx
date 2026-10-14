import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {/* 渲染期抛错时兜底：白屏必须有「重新加载」出口，而不是无提示空白窗口。 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
