import { spendSuite } from "./spend-suite.js";
spendSuite({ backend: "memory" });
spendSuite({ backend: "sql" });
import { generationSuite } from "./generation-suite.js";
generationSuite({ backend: "memory" });
generationSuite({ backend: "sql" });
import { stopSuite } from "./stop-suite.js";
stopSuite({ backend: "memory" });
stopSuite({ backend: "sql" });
