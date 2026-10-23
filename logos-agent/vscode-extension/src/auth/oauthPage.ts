function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    html { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
      background: #09090b; color: #fafafa; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
    main { width: 100%; max-width: 560px; display: flex; flex-direction: column; align-items: center; }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }
    .details { margin-top: 16px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #a1a1aa;
      white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
  return renderPage({ title: "登录成功", heading: "登录成功", message });
}

export function oauthErrorHtml(message: string, details?: string): string {
  return renderPage({ title: "登录失败", heading: "登录失败", message, details });
}
