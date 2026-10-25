import type { ApprovalCardProps } from '../../features/approve/index.js';
import { approvalSummary } from './approval-summary.rules.js';

/** Keep derived presentation out of the markup-only component. */
export function useChatApproval(required: ApprovalCardProps) { return approvalSummary({ card: required.card }); }
