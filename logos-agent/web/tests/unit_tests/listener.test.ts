import assert from "node:assert/strict";
import test from "node:test";
import { vpnHttpAllowed } from "../../server/listener.ts";

test("VPN HTTP requires opt-in, a private interface, and the same origin address and port", () => {
  for (const host of ["10.250.179.176", "172.16.0.2", "192.168.1.2", "100.70.0.2"]) {
    const address = new URL(`http://${host}:18882`);
    assert.equal(vpnHttpAllowed(host, address, 18882, true), true);
    assert.equal(vpnHttpAllowed(host, address, 18882, false), false);
  }
  for (const host of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "100.128.0.1", "localhost", "::"]) {
    assert.equal(vpnHttpAllowed(host, new URL("http://10.250.179.176:18882"), 18882, true), false);
  }
  assert.equal(vpnHttpAllowed("10.0.0.1", new URL("http://10.0.0.2:18882"), 18882, true), false);
  assert.equal(vpnHttpAllowed("10.0.0.1", new URL("http://10.0.0.1:18883"), 18882, true), false);
  assert.equal(vpnHttpAllowed("10.0.0.1", new URL("https://10.0.0.1:18882"), 18882, true), false);
});
