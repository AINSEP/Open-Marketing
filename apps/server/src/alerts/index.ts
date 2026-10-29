/** Server-local alerts public API; construction and imports perform no I/O. */
export { alertCandidates, alertEvidenceSchema, alertCandidateSchema, pacingEvidenceSchema, accountLocalDay, dailyPacingEvidence, lifetimePacingEvidence } from './rules.js';
export type { AlertEvidence, AlertCandidate, PacingEvidence } from './rules.js';
export { listAlerts, appendAlerts, acknowledgeAlert, alertNoticeSchema, alertQuerySchema } from './store.js';
export type { AlertNotice } from './store.js';
export { ALERT_EVALUATION_INTERVAL_MS, alertEvaluationPayloadSchema, alertEvaluationJob, enqueueAlertEvaluation, evaluateAlerts } from './jobs.js';
export { weeklyReportPayloadSchema, weeklyReportSlot, weeklyReportDays, weeklyReportJob, enqueueWeeklyReport, generateWeeklyReport } from './jobs.js';
export { ALERT_EMAIL_DEFINITION_DIGEST, alertEmailPayloadSchema, alertEmailJob, dispatchAlertEmail, enqueueAlertEmail, reserveAlertEmail } from './email.js';
export type { AlertEmailPayload, AlertEmailDependencies, AlertMailPort } from './email.js';
export { getMailProviderSettings, putMailProviderSettings, resolveAlertSender } from './provider-settings.js';
export type { AlertSender, ProviderReaders } from './provider-settings.js';
