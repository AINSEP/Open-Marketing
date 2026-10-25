import { Component } from 'react';
import type { ReactNode } from 'react';
import type { StudioNavigationTarget } from '@open-marketing/contracts';
import type { StudioTrack } from '../../shared/api/index.js';

/** React's class lifecycle ABI is required for render errors; exception text is never captured. */
export class StudioErrorBoundary extends Component<{ track: StudioTrack; screen(): StudioNavigationTarget; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() {
    try { this.props.track('studio.render_crash', { screen: this.props.screen(), errorCode: 'render_crash' }); }
    catch { /* A diagnostic destination cannot crash the fallback. */ }
  }
  override render() { return this.state.failed ? <div role="alert" className="error-notice">Studio could not display this screen. Reload to reopen the workspace.</div> : this.props.children; }
}
