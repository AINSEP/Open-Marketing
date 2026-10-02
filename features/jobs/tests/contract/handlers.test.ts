import { JobDispatchPortSuite } from "./port-suites.js";
import { createJobHandlerRegistry } from "../../index.js";
JobDispatchPortSuite({ name: "handler registry", create: required => {
    const registry = createJobHandlerRegistry({});
    if (required.result) registry.register({ name: "write", handler: { async handle() { return required.result!; }, async dispose() {} } });
    return registry;
} });
