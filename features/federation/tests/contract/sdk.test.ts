import { McpTransportPortSuite } from "./port-suites.js";
import { httpFixture, stdioFixture } from "../fixtures/local-transports.js";
McpTransportPortSuite({ name: "real HTTP", create: httpFixture });
McpTransportPortSuite({ name: "real stdio", create: stdioFixture });
