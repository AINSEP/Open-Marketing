import { FederationAdmissionSuite } from "./contract/admission-suites.js";
import { createMemoryMcpTransport } from "../index.js";
import { respond } from "./fixtures/domain.js";
import { httpFixture, stdioFixture } from "./fixtures/local-transports.js";
FederationAdmissionSuite({ name: "memory", create: async () => ({ port: createMemoryMcpTransport({ respond }), cleanup: async () => {} }) });
FederationAdmissionSuite({ name: "real HTTP", create: httpFixture });
FederationAdmissionSuite({ name: "real stdio", create: stdioFixture });
