import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Same global styles the Next.js app/layout.tsx pulls in.
import './index.css';
import './styles/home/index.css';

import { App } from './App';
import { I18nProvider } from './i18n';
import { AnalyticsProvider } from './analytics/provider';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <AnalyticsProvider>
        <App />
      </AnalyticsProvider>
    </I18nProvider>
  </StrictMode>,
);
