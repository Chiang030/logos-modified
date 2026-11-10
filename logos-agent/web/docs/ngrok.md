# Fixed ngrok endpoint

Current public origin: https://outward-speed-alto.ngrok-free.dev
Lark redirect: https://outward-speed-alto.ngrok-free.dev/auth/feishu/callback

The account's free development domain persists across agent restarts. This was
verified by restarting logos-web-ngrok.service and checking the same public
bootstrap URL. This is subject to the provider's free plan, not an unlimited
or permanent-service guarantee.

ngrok 3.39.13 is installed at ~/.local/bin/ngrok from the official Debian package;
its SHA-256 was checked against the official repository metadata. The protected
~/.config/ngrok/ngrok.yml contains account authentication. It is mode 0600 and
is never committed. The unit reads LOGOS_WEB_PORT and LOGOS_WEB_PUBLIC_URL from
the existing protected server environment file. Request inspection is disabled.

All three units are enabled in the lingering user manager:
logos-web-pilot, logos-web-worker, logos-web-ngrok. The upstream is
http://127.0.0.1:18882. The old Cloudflare tunnel stays inactive.

As documented by ngrok on 2026-11-10, the free plan includes 1 GB/month outgoing
data, 20,000 HTTP requests/month, and an HTML browser interstitial. The app's
polling and file downloads consume these limits. For sustained multi-user use,
monitor quotas and choose a different plan/provider if needed. The free-plan
OAuth/OIDC traffic-policy limit is not this application's own Lark login.

References:
- https://ngrok.com/docs/pricing-limits/free-plan-limits
- https://ngrok.com/docs/universal-gateway/domains

The user confirmed adding the new Lark callback to the application allowlist.
The public app and API returned 200; the login route redirects to
accounts.larksuite.com with the exact new callback. A real user must complete
the Lark sign-in; no user identity was impersonated during deployment checks.
