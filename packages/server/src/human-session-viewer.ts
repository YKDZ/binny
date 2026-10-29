export function humanSessionViewerPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>浏览器维护</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #17191c; color: #f3f4f6; }
      header { min-height: 3rem; padding: .75rem 1rem; display: flex; align-items: center; gap: 1rem; }
      #status { color: #c4c8ce; }
      #screen { height: calc(100vh - 4.5rem); width: 100vw; overflow: hidden; }
    </style>
  </head>
  <body>
    <header><strong>浏览器维护</strong><span id="status">正在连接…</span></header>
    <main id="screen" aria-label="浏览器画面"></main>
    <script type="module" src="/human-viewer.js"></script>
  </body>
</html>`;
}
