import { describe, expect, it } from "vitest";
import type { Clock } from "@open-marketing/om-clock";
import * as gates from "../src/gates.js";
import type { AdAccountPolicy, Consent, SubjectPolicy } from "../src/types.js";
const clock: Clock = { now: () => 100 };
const grant: Consent = { scope: "channel", target: "email", purpose: "news", status: "granted", start: 0, end: 200 };
const subject: SubjectPolicy = { consents: [grant], suppressions: [], holdout: false };
const channel = { id: "email", intent: "marketing" } as const;
const destination = { id: "meta", intent: "audience" } as const;
const sharing: SubjectPolicy = { ...subject, consents: [{ ...grant, scope: "destination", target: "meta" }] };
const account: AdAccountPolicy = { halted: false, authorization: { start: 0, end: 200, currency: "USD", capMinorUnits: 100, committedMinorUnits: 40, reservedMinorUnits: 20, revoked: false } };
const window = { start: 0, end: 200 };
const send = ({ policy, time = clock }: {
    policy: SubjectPolicy;
    time?: Clock;
}) => gates.sendability({ subject: policy, channel: channel, purpose: "news", now: (time).now({}) });
const spend = ({ policy, amount = 40, time = clock }: {
    policy: AdAccountPolicy;
    amount?: number;
    time?: Clock;
}) => gates.spendability({ account: policy, amount: { minorUnits: amount, currency: "USD" }, window: window, now: (time).now({}) });
describe("canonical gate API", () => {
    it("does not mutate frozen policy arrays and propagates clock failures", () => {
        const frozen = Object.freeze({ ...subject, consents: Object.freeze([Object.freeze({ ...grant })]), suppressions: Object.freeze([]) });
        expect(send({ policy: frozen }).allowed).toBe(true);
        expect(frozen.consents).toEqual([grant]);
        const failure = new Error("clock unavailable");
        const broken: Clock = { now: () => { throw failure; } };
        expect(() => send({ policy: frozen, time: broken })).toThrow(failure);
        expect(() => gates.shareability({ subject: sharing, destination: destination, purpose: "news", now: (broken).now({}) })).toThrow(failure);
        expect(() => spend({ policy: account, amount: 1, time: broken })).toThrow(failure);
    });
    it("exports exactly three functions", () => expect(Object.keys(gates).sort()).toEqual(["sendability", "shareability", "spendability"]));
    it("requires matching grants and rejects expiry exactly at end", () => {
        expect(send({ policy: subject })).toEqual({ allowed: true });
        expect(send({ policy: subject, time: { now: () => 0 } })).toEqual({ allowed: true });
        expect(send({ policy: subject, time: { now: () => 200 } })).toEqual({ allowed: false, reason: "consent_missing" });
        expect(send({ policy: { ...subject, consents: [] } }).allowed).toBe(false);
        expect(gates.sendability({ subject: subject, channel: channel, purpose: "other", now: (clock).now({}) }).allowed).toBe(false);
        expect(send({ policy: { ...subject, consents: [{ ...grant, target: "sms" }] } }).allowed).toBe(false);
    });
    it("withdrawal wins over overlapping grants regardless of order or withdrawal expiry", () => {
        const withdrawn: Consent = { ...grant, status: "withdrawn", end: 50 };
        for (const consents of [[grant, withdrawn], [withdrawn, grant]]) {
            expect(send({ policy: { ...subject, consents } })).toEqual({ allowed: false, reason: "consent_withdrawn" });
        }
    });
    it("suppresses messages but not otherwise consented sharing", () => {
        const suppressions = [{ channel: "email", start: 0, end: 200 }];
        expect(send({ policy: { ...subject, suppressions } })).toEqual({ allowed: false, reason: "suppressed" });
        expect(gates.shareability({ subject: { ...sharing, suppressions }, destination: destination, purpose: "news", now: (clock).now({}) })).toEqual({ allowed: true });
        expect(send({ policy: { ...subject, suppressions: [{ channel: "email", start: 0, end: 100 }] } }).allowed).toBe(true);
    });
    it("holdout distinguishes marketing, transactional, audience and measurement intents", () => {
        expect(send({ policy: { ...subject, holdout: true } })).toEqual({ allowed: false, reason: "holdout" });
        expect(gates.sendability({ subject: { ...subject, holdout: true }, channel: { ...channel, intent: "transactional" }, purpose: "news", now: (clock).now({}) }).allowed).toBe(true);
        expect(gates.shareability({ subject: { ...sharing, holdout: true }, destination: destination, purpose: "news", now: (clock).now({}) }).allowed).toBe(false);
        expect(gates.shareability({ subject: { ...sharing, holdout: true }, destination: { ...destination, intent: "measurement" }, purpose: "news", now: (clock).now({}) }).allowed).toBe(true);
        expect(gates.shareability({ subject: { ...sharing, holdout: true, consents: [] }, destination: { ...destination, intent: "measurement" }, purpose: "news", now: (clock).now({}) }).allowed).toBe(false);
    });
    it("frequency cap denies at cap including zero", () => {
        expect(send({ policy: { ...subject, frequencyCap: { count: 1, limit: 2 } } }).allowed).toBe(true);
        for (const count of [2, 3])
            expect(send({ policy: { ...subject, frequencyCap: { count, limit: 2 } } })).toEqual({ allowed: false, reason: "frequency_cap" });
        expect(send({ policy: { ...subject, frequencyCap: { count: 0, limit: 0 } } }).allowed).toBe(false);
    });
    it("denies invalid times, windows and counters", () => {
        expect(send({ policy: subject, time: { now: () => NaN } })).toEqual({ allowed: false, reason: "invalid_input" });
        expect(send({ policy: { ...subject, consents: [{ ...grant, end: -1 }] } }).allowed).toBe(false);
        expect(send({ policy: { ...subject, frequencyCap: { count: -1, limit: 3 } } }).allowed).toBe(false);
        expect(send({ policy: { ...subject, suppressions: [{ channel: "email", start: 3, end: 3 }] } }).allowed).toBe(false);
    });
});
describe("spend envelope", () => {
    it("subtracts both committed and reserved totals; never mutates or reserves", () => {
        const before = JSON.stringify(account);
        expect(spend({ policy: account })).toEqual({ allowed: true });
        expect(spend({ policy: account, amount: 41 })).toEqual({ allowed: false, reason: "budget_exceeded" });
        expect(spend({ policy: account })).toEqual({ allowed: true });
        expect(JSON.stringify(account)).toBe(before);
    });
    it("denies halted, missing and revoked authorization", () => {
        expect(spend({ policy: { ...account, halted: true } })).toEqual({ allowed: false, reason: "account_halted" });
        expect(spend({ policy: { ...account, authorization: null } })).toEqual({ allowed: false, reason: "authorization_missing" });
        expect(spend({ policy: { ...account, authorization: { ...account.authorization!, revoked: true } } })).toEqual({ allowed: false, reason: "authorization_revoked" });
    });
    it("requires exact currency and contained half-open windows", () => {
        expect(spend({ policy: account, amount: 40, time: { now: () => 0 } }).allowed).toBe(true);
        expect(spend({ policy: account, amount: 40, time: { now: () => 200 } })).toEqual({ allowed: false, reason: "outside_window" });
        expect(gates.spendability({ account: account, amount: { minorUnits: 1, currency: "EUR" }, window: window, now: (clock).now({}) })).toEqual({ allowed: false, reason: "currency_mismatch" });
        expect(gates.spendability({ account: account, amount: { minorUnits: 1, currency: "USD" }, window: { start: 0, end: 201 }, now: (clock).now({}) }).allowed).toBe(false);
    });
    it.each([0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount %s", amount => expect(spend({ policy: account, amount: amount })).toEqual({ allowed: false, reason: "invalid_input" }));
    it("denies exhausted aggregate totals even near safe integer limits", () => {
        expect(spend({ policy: { ...account, authorization: { ...account.authorization!, capMinorUnits: Number.MAX_SAFE_INTEGER, committedMinorUnits: Number.MAX_SAFE_INTEGER, reservedMinorUnits: Number.MAX_SAFE_INTEGER } }, amount: 1 })).toEqual({ allowed: false, reason: "budget_exceeded" });
    });
});
