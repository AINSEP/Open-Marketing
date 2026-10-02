import type { AppError, Outcome } from "@open-marketing/contracts";
/** Stable boundary failure; never contains payloads or driver/provider exceptions. @complexity O(1). */
export function jobFailure<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
    return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}
/** Store adapter failures are explicit; the service maps them to Outcome without inferring no effect. */
export class JobStoreError extends Error {
    readonly code: AppError["code"];
    constructor(required: { code: AppError["code"]; message: string }) {
        super(required.message);
        this.name = "JobStoreError";
        this.code = required.code;
    }
}
