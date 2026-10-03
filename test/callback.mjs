import assert from "node:assert/strict";
import { deliveryId, resultHash } from "../dist/callback.js";
const payload = { sessionId:"job-1", label:"test", terminalState:"done", finalText:"ok",
  error:undefined, startedAt:"2026-01-01T00:00:00.000Z", finishedAt:"2026-01-01T00:00:01.000Z",
  providerModel:"test/model" };
const h1=resultHash(payload), h2=resultHash(payload);
assert.equal(h1,h2); assert.match(h1,/^[0-9a-f]{64}$/);
assert.equal(deliveryId("job-1",h1), `pi-delegate:job-1:${h1.slice(0,24)}`);
console.log("callback: ok");
