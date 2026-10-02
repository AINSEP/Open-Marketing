import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import { draftSchema, proposalSchema, requestSchema } from "./rules.js";
export const capabilityCreateSchema = z.strictObject({ context: callContextSchema, draft: draftSchema, campaignId: idSchema, permitId: idSchema });
export const capabilityLaunchSchema = z.strictObject({ context: callContextSchema, request: requestSchema, proposal: proposalSchema, permitId: idSchema });
export const capabilityReadSchema = z.strictObject({ context: callContextSchema, campaignId: idSchema, connectionId: idSchema, accountId: idSchema, operationId: idSchema });
