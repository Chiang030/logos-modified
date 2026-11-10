# Private NetBird access

LOGOS can bind directly to an existing NetBird IPv4 interface. The browser and
server must belong to the same authorized NetBird network. This mode uses
HTTP inside the encrypted VPN; it does not provide browser HTTPS. The VPN
must be running before clients can connect. For browser secure-context features
or access outside the VPN, use a trusted HTTPS reverse proxy instead.

Configure the protected web environment file:

```ini
LOGOS_WEB_HOST=<server-netbird-ip>
LOGOS_WEB_PORT=18882
LOGOS_WEB_PUBLIC_URL=http://<server-netbird-ip>:18882
LOGOS_WEB_VPN_HTTP=1
```

The explicit opt-in requires a private IPv4 listener matching the public URL's
IP and port. Do not use `0.0.0.0`. This check validates configuration, not VPN
membership: the operator must select the actual VPN interface and configure
NetBird access rules for clients. No operating-system Agent isolation is added.

Register `http://<server-netbird-ip>:18882/auth/feishu/callback` in the Lark
application redirect allowlist. The browser follows the callback through its
VPN connection; Lark does not need to initiate a connection to the private IP.
If the enterprise application's policy requires HTTPS redirects, configure a
trusted HTTPS origin instead. Users log in once on the new origin, then the
same rolling 30-day session policy applies.

Keep the data directory and model encryption key unchanged. The HTTP service's
restart policy retries if the VPN interface is not ready during boot. Enable
both NetBird and the web user service, and enable user lingering.

During migration, a second HTTP service can use a separate protected environment
file and the same data directory, with only one shared worker. Keep the old
entry until the new Lark callback has been accepted and a real login succeeds.
