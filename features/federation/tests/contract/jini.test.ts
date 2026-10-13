import { McpTransportPortSuite } from "./port-suites.js";
import { httpFixture, stdioFixture } from "../fixtures/local-transports.js";
import { scriptedHttpFixture, scriptedStdioFixture } from "../fixtures/jini-transports.js";
McpTransportPortSuite({ name: "Jini scripted HTTP", create: scriptedHttpFixture });
McpTransportPortSuite({ name: "Jini scripted stdio", create: scriptedStdioFixture });
McpTransportPortSuite({ name: "Jini real HTTP", create: httpFixture });
McpTransportPortSuite({ name: "Jini real stdio", create: stdioFixture });
