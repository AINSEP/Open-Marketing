import { OAuthClientPortSuite, CredentialRefreshPortSuite } from "./port-suites.js";
import { createJiniFixture, createTokenRecord } from "../jini-fixture.js";

OAuthClientPortSuite({ create: () => createJiniFixture({}).oauth });
CredentialRefreshPortSuite({ create: async () => {
  const h = createJiniFixture({});
  return { port: h.refresh, record: await createTokenRecord({ sealer: h.sealer }) };
} });
