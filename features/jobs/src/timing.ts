import { z } from "zod";
import { epochSchema } from "@open-marketing/contracts";
/** Optional earliest eligibility in safe-integer UTC milliseconds; omission uses the injected clock. */
export const enqueueTimingSchema = z.strictObject({ availableAt: epochSchema.optional() });
