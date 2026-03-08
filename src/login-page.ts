function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function loginPage(errorText?: string): string {
  const errorBanner = errorText
    ? `<div class="alert">${escapeHtml(errorText)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Nanoshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #050505;
      --bg-alt: #0c0c0c;
      --panel: #0a0a0a;
      --ink: #f5f5f5;
      --muted: #a3a3a3;
      --line: #262626;
      --line-strong: #404040;
      --danger: #ff6b6b;
      --button-bg: #f5f5f5;
      --button-ink: #050505;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--ink);
      background:
        linear-gradient(180deg, #090909 0%, #050505 45%, #020202 100%),
        repeating-linear-gradient(
          0deg,
          transparent 0 31px,
          #121212 31px 32px
        );
      padding: 1.25rem;
    }
    .panel {
      width: min(460px, 100%);
      background: linear-gradient(180deg, #0d0d0d 0%, #090909 100%);
      border: 1px solid var(--line-strong);
      padding: 1.4rem 1.4rem 1.3rem;
      box-shadow:
        0 0 0 1px #000,
        0 22px 60px #00000066;
      animation: settle .36s ease-out;
    }
    .badge {
      font-size: .74rem;
      letter-spacing: .2em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 .6rem;
    }
    h1 {
      margin: 0 0 .4rem;
      font-size: clamp(1.24rem, 2.2vw, 1.55rem);
      line-height: 1.2;
      letter-spacing: .01em;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 1.2rem;
      color: var(--muted);
      line-height: 1.48;
      font-size: .93rem;
    }
    .alert {
      margin: 0 0 .95rem;
      padding: .68rem .78rem;
      border: 1px solid #7f1d1d;
      background: #2a0f0f;
      color: var(--danger);
      font-size: .88rem;
    }
    form { display: grid; gap: .68rem; }
    label {
      font-size: .85rem;
      color: #d4d4d4;
      letter-spacing: .03em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      padding: .86rem .88rem;
      font-size: 1rem;
      letter-spacing: .1em;
      font-family: inherit;
      color: var(--ink);
      background: #050505;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input:focus {
      border-color: #f5f5f5;
      box-shadow: inset 0 0 0 1px #f5f5f5;
    }
    button {
      border: 1px solid var(--button-bg);
      padding: .88rem 1rem;
      font: 700 .88rem "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .08em;
      text-transform: uppercase;
      cursor: pointer;
      color: var(--button-ink);
      background: var(--button-bg);
      transition: background-color .15s ease, color .15s ease;
    }
    button:hover {
      background: #050505;
      color: var(--button-bg);
    }
    .hint {
      margin-top: .88rem;
      font-size: .78rem;
      color: #8a8a8a;
      border-top: 1px solid var(--line);
      padding-top: .8rem;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .hint a {
      color: #f5f5f5;
      text-decoration: none;
      border-bottom: 1px solid #404040;
      padding-bottom: 1px;
      transition: border-color .15s ease, color .15s ease;
    }
    .hint a:hover {
      color: #ffffff;
      border-color: #f5f5f5;
    }
    @keyframes settle {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  </style>
</head>
<body>
  <main class="panel">
    <div class="badge">Nanoshare / Access Gateway</div>
    <h1>Enter Access PIN</h1>
    <p>Use the 6-digit code from the host machine to unlock this low-latency screen stream.</p>
    ${errorBanner}
    <form method="post" action="/auth">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus />
      <button type="submit">Open Live Feed</button>
    </form>
    <div class="hint"><a href="https://github.com/extoci/nanoshare" target="_blank" rel="noreferrer noopener">View Source on GitHub</a></div>
  </main>
</body>
</html>`;
}
