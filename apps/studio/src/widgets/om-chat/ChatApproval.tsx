import { ApprovalCard } from '../../features/approve/index.js';
import type { ApprovalCardProps } from '../../features/approve/index.js';
import { useChatApproval } from './ChatApproval.hooks.js';

/** Presentation wrapper only: the original card owns choices, expiry, digest and submission. */
export function ChatApproval(props: ApprovalCardProps) {
  const summary = useChatApproval(props);
  return <section className="om-chat-approval" aria-label={summary.title}>
    <header><strong>{summary.title}</strong><p>{summary.description}</p></header>
    <details><summary>Exact arguments</summary><pre>{summary.argumentsText}</pre></details>
    <ApprovalCard {...props} />
  </section>;
}
