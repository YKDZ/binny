import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanContent,
  isAcceptableMediaResponse,
  validateMediaResponse,
  type ArchiveResourceMetadata,
} from "../src/index.ts";

void describe("content-cleaner", () => {
  void it("strips chrome tags and non-quote aside elements", () => {
    const html = `
      <header><nav><a href="/home">Home</a></nav></header>
      <main>
        <h1>Article Title</h1>
        <p>Real paragraph content.</p>
        <aside><form><input type="text" name="q" /><button>Search</button></form></aside>
        <script>console.log("bad");</script>
        <style>.bad { color: red; }</style>
        <noscript>Please enable JS</noscript>
        <template>Hidden</template>
        <iframe src="https://example.com/embed"></iframe>
      </main>
      <footer><p>&copy; 2026 Acme Corp</p></footer>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    assert.equal(cleaned.text, "Article Title Real paragraph content.");
    assert.match(
      cleaned.markdown,
      /^# Article Title\n\nReal paragraph content\./u,
    );
    assert.doesNotMatch(cleaned.markdown, /Home|bad|Search|Hidden|Acme/u);
    assert.doesNotMatch(cleaned.text, /Home|bad|Search|Hidden|Acme/u);
  });

  void it("preserves Discourse aside.quote blocks with author headers", () => {
    const html = `
      <p>Before quote</p>
      <aside class="quote no-group" data-username="alice" data-post="42" data-topic="100">
        <div class="title">
          <div class="quote-controls"></div>
          <img src="/avatar/alice.png" class="avatar" alt="avatar" />
          <a href="/t/100/42">alice:</a>
        </div>
        <blockquote>
          <p>This is a quoted paragraph.</p>
        </blockquote>
      </aside>
      <p>After quote</p>
    `;

    const cleaned = cleanContent(html, {
      format: "html",
      baseUrl: "https://discourse.example.com",
    });

    assert.match(cleaned.text, /Before quote/u);
    assert.match(cleaned.text, /alice:/u);
    assert.match(cleaned.text, /This is a quoted paragraph\./u);
    assert.match(cleaned.text, /After quote/u);

    assert.match(cleaned.markdown, /Before quote/u);
    assert.match(cleaned.markdown, /> \*\*alice:\*\*/u);
    assert.match(cleaned.markdown, /> This is a quoted paragraph\./u);
    assert.match(cleaned.markdown, /After quote/u);
  });

  void it("supports custom element filter predicates", () => {
    const html = `
      <article>
        <h1>Heading</h1>
        <div class="ad-banner">Ad content</div>
        <p>Main body text.</p>
        <div class="related-articles">Related list</div>
      </article>
    `;

    const cleaned = cleanContent(html, {
      format: "html",
      customDropElement(element) {
        const classAttr =
          element.attrs.find((a) => a.name === "class")?.value ?? "";
        return (
          classAttr.includes("ad-banner") ||
          classAttr.includes("related-articles")
        );
      },
    });

    assert.equal(cleaned.text, "Heading Main body text.");
    assert.match(cleaned.markdown, /^# Heading\n\nMain body text\./u);
    assert.doesNotMatch(cleaned.markdown, /Ad content|Related list/u);
  });

  void it("preserves headings, lists with nesting, and standard blockquotes", () => {
    const html = `
      <h1>Title</h1>
      <h2>Subtitle</h2>
      <blockquote>
        <p>A quote block</p>
      </blockquote>
      <ul>
        <li>First item</li>
        <li>Second item
          <ol>
            <li>Nested one</li>
            <li>Nested two</li>
          </ol>
        </li>
      </ul>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    assert.match(cleaned.markdown, /^# Title\n\n## Subtitle/u);
    assert.match(cleaned.markdown, /> A quote block/u);
    assert.match(cleaned.markdown, /- First item/u);
    assert.match(cleaned.markdown, /- Second item/u);
    assert.match(cleaned.markdown, / {2}1\. Nested one/u);
    assert.match(cleaned.markdown, / {2}2\. Nested two/u);
  });

  void it("preserves code blocks with indentation, newlines, and language tags", () => {
    const html = `
      <p>Inline <code>const x = 1;</code> in paragraph.</p>
      <pre><code class="lang-typescript">function add(a: number, b: number): number {
  // Indented line
  return a + b;
}</code></pre>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    assert.match(cleaned.markdown, /Inline `const x = 1;` in paragraph\./u);
    assert.match(
      cleaned.markdown,
      /```typescript\nfunction add\(a: number, b: number\): number \{\n {2}\/\/ Indented line\n {2}return a \+ b;\n\}\n```/u,
    );
    assert.match(cleaned.text, /const x = 1;/u);
    assert.match(cleaned.text, /return a \+ b;/u);
  });

  void it("preserves GFM tables", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Context</th><th>Price</th></tr>
        </thead>
        <tbody>
          <tr><td>Luna</td><td>1M</td><td>$1.00</td></tr>
          <tr><td>Sol</td><td>2M</td><td>$2.00</td></tr>
        </tbody>
      </table>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    assert.match(cleaned.markdown, /\| Model \| Context \| Price \|/u);
    assert.match(cleaned.markdown, /\| --- \| --- \| --- \|/u);
    assert.match(cleaned.markdown, /\| Luna \| 1M \| \$1\.00 \|/u);
    assert.match(cleaned.markdown, /\| Sol \| 2M \| \$2\.00 \|/u);
  });

  void it("preserves details and summary blocks", () => {
    const html = `
      <details>
        <summary>Click to expand</summary>
        <p>Hidden details content.</p>
      </details>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    assert.match(
      cleaned.markdown,
      /<details>\s*<summary>Click to expand<\/summary>/u,
    );
    assert.match(cleaned.markdown, /Hidden details content\./u);
    assert.match(cleaned.markdown, /<\/details>/u);
    assert.equal(cleaned.text, "Click to expand Hidden details content.");
  });

  void it("preserves links with markdown syntax", () => {
    const html = `<p>Visit <a href="https://example.com/page">our website</a> today.</p>`;
    const cleaned = cleanContent(html, { format: "html" });
    assert.equal(
      cleaned.markdown,
      "Visit [our website](https://example.com/page) today.",
    );
    assert.equal(cleaned.text, "Visit our website today.");
  });

  void it("handles plain text input format with exact text and escaped markdown", () => {
    const plain = "代码 <widget> 与 A & B";
    const cleaned = cleanContent(plain, { format: "text" });

    assert.equal(cleaned.text, "代码 <widget> 与 A & B");
    assert.equal(cleaned.markdown, "代码 &lt;widget&gt; 与 A &amp; B");

    const entitiesInPlain = "A &lt;widget&gt; &amp; B";
    const cleanedEntities = cleanContent(entitiesInPlain, { format: "text" });
    assert.equal(cleanedEntities.text, "A &lt;widget&gt; &amp; B");
    assert.equal(
      cleanedEntities.markdown,
      "A &amp;lt;widget&amp;gt; &amp;amp; B",
    );
  });

  void it("handles html/xhtml input format with decoded text and escaped markdown text nodes", () => {
    const html = "<p>代码 &lt;widget&gt; 与 A &amp; B</p>";
    const cleaned = cleanContent(html, { format: "html" });

    assert.equal(cleaned.text, "代码 <widget> 与 A & B");
    assert.equal(cleaned.markdown, "代码 &lt;widget&gt; 与 A &amp; B");
  });

  void it("extracts inline media and explicit attachments", () => {
    const html = `
      <article>
        <p>Post with media</p>
        <img src="/images/pic.png" alt="Pic" />
        <picture>
          <source srcset="/images/pic.webp" type="image/webp" />
          <img src="/images/fallback.png" alt="Fallback" />
        </picture>
        <video src="/videos/clip.mp4" poster="/images/poster.jpg"></video>
        <audio src="/audios/track.mp3"></audio>
        <a href="/files/doc.pdf" download="report.pdf">Download Report</a>
        <a class="attachment" href="/uploads/data.json">Data JSON</a>
      </article>
    `;

    const cleaned = cleanContent(html, {
      format: "html",
      baseUrl: "https://example.com/posts/",
    });

    const urls = cleaned.media.map((m) => m.url);
    assert.ok(urls.includes("https://example.com/images/pic.png"));
    assert.ok(urls.includes("https://example.com/images/pic.webp"));
    assert.ok(urls.includes("https://example.com/images/fallback.png"));
    assert.ok(urls.includes("https://example.com/videos/clip.mp4"));
    assert.ok(urls.includes("https://example.com/images/poster.jpg"));
    assert.ok(urls.includes("https://example.com/audios/track.mp3"));
    assert.ok(urls.includes("https://example.com/files/doc.pdf"));
    assert.ok(urls.includes("https://example.com/uploads/data.json"));

    const docAttachment = cleaned.media.find((m) => m.url.endsWith("doc.pdf"));
    assert.equal(docAttachment?.kind, "attachment");

    const jsonAttachment = cleaned.media.find((m) =>
      m.url.endsWith("data.json"),
    );
    assert.equal(jsonAttachment?.kind, "attachment");
  });

  void it("handles Discourse lightbox links by picking original image URL without thumbnail candidate", () => {
    const html = `
      <p>Check this out:</p>
      <a class="lightbox" href="https://example.com/uploads/original.png" title="Full Image">
        <img src="https://example.com/uploads/thumb.png" alt="Thumbnail" />
      </a>
    `;

    const cleaned = cleanContent(html, { format: "html" });
    const urls = cleaned.media.map((m) => m.url);
    assert.ok(urls.includes("https://example.com/uploads/original.png"));
    assert.ok(!urls.includes("https://example.com/uploads/thumb.png"));
    assert.match(
      cleaned.markdown,
      /!\[Thumbnail\]\(https:\/\/example\.com\/uploads\/original\.png\)/u,
    );
  });

  void it("replaces Discourse emojis with text and excludes them from media candidates", () => {
    const html = `
      <p>Hello world <img src="/images/emoji/twitter/smile.png" class="emoji" alt=":smile:" title=":smile:" />!</p>
    `;

    const cleaned = cleanContent(html, {
      format: "html",
      baseUrl: "https://example.com",
    });

    assert.equal(cleaned.media.length, 0);
    assert.equal(cleaned.text, "Hello world :smile:!");
    assert.equal(cleaned.markdown, "Hello world :smile:!");
  });

  void it("rewrites uploaded media URLs to binny://resource references and appends attachments", () => {
    const html = `
      <p>Article body</p>
      <img src="https://example.com/photo.png" alt="Cover" />
    `;

    const extraAttachment = {
      url: "https://example.com/files/dataset.json",
      kind: "attachment" as const,
      title: "Full Dataset",
    };

    const cleaned = cleanContent(html, {
      format: "html",
      extraMedia: [extraAttachment],
    });

    const uploaded = new Map<string, ArchiveResourceMetadata>([
      [
        "https://example.com/photo.png",
        {
          resourceId: "res-photo-123",
          sha256: "0".repeat(64),
          mediaType: "image/png",
          size: 1024,
        },
      ],
      [
        "https://example.com/files/dataset.json",
        {
          resourceId: "res-json-456",
          sha256: "1".repeat(64),
          mediaType: "application/json",
          size: 2048,
        },
      ],
    ]);

    const rendered = cleaned.renderArchiveBody(uploaded);
    assert.match(
      rendered.markdown,
      /!\[Cover\]\(binny:\/\/resource\/res-photo-123\)/u,
    );
    assert.match(
      rendered.markdown,
      /附件：Full Dataset \(binny:\/\/resource\/res-json-456\)/u,
    );
    assert.deepEqual(rendered.resources, [
      { resourceId: "res-photo-123" },
      { resourceId: "res-json-456" },
    ]);
  });

  void it("detects substantial content vs empty shell HTML", () => {
    const emptyShell = `<div><script>console.log(1);</script><style>.a{}</style></div>`;
    const cleanedEmpty = cleanContent(emptyShell, { format: "html" });
    assert.equal(cleanedEmpty.hasSubstantialContent, false);
    assert.equal(cleanedEmpty.text, "");

    const substantial = `<p>Real content</p>`;
    const cleanedSubstantial = cleanContent(substantial, { format: "html" });
    assert.equal(cleanedSubstantial.hasSubstantialContent, true);
  });

  void it("validates media responses correctly for inline media vs explicit attachments", () => {
    const inlineCandidate = {
      url: "https://example.com/image.png",
      kind: "inline-image" as const,
    };

    // Rejects inline image returning HTML (e.g. challenge page or error)
    const htmlOnImage = isAcceptableMediaResponse(
      inlineCandidate,
      "text/html",
      "<!doctype html><html><body>Error</body></html>",
    );
    assert.equal(htmlOnImage.acceptable, false);

    // Rejects inline image returning JSON
    const jsonOnImage = isAcceptableMediaResponse(
      inlineCandidate,
      "application/json",
      '{"error": "not found"}',
    );
    assert.equal(jsonOnImage.acceptable, false);

    // Accepts genuine binary image
    const validImage = isAcceptableMediaResponse(inlineCandidate, "image/png");
    assert.equal(validImage.acceptable, true);

    // Explicit attachment candidate with genuine JSON
    const jsonAttachment = {
      url: "https://example.com/export.json",
      kind: "attachment" as const,
    };
    const validJson = isAcceptableMediaResponse(
      jsonAttachment,
      "application/json",
      '{"items": [1, 2, 3]}',
    );
    assert.equal(validJson.acceptable, true);

    // Explicit attachment candidate with JSON error payload -> rejected!
    const errorJson = isAcceptableMediaResponse(
      jsonAttachment,
      "application/json",
      '{"error": "unauthorized", "message": "Login required"}',
    );
    assert.equal(errorJson.acceptable, false);

    // Explicit attachment candidate with genuine HTML report
    const htmlAttachment = {
      url: "https://example.com/reports/summary.html",
      kind: "attachment" as const,
    };
    const validHtml = isAcceptableMediaResponse(
      htmlAttachment,
      "text/html",
      "<!doctype html><html><body><h1>Report</h1></body></html>",
    );
    assert.equal(validHtml.acceptable, true);

    // Explicit attachment returning anti-bot challenge page -> rejected!
    const challengeHtml = isAcceptableMediaResponse(
      htmlAttachment,
      "text/html",
      '<!doctype html><html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b"></script></head></html>',
    );
    assert.equal(challengeHtml.acceptable, false);

    // Non-HTML attachment returning text/html -> rejected!
    const zipAttachment = {
      url: "https://example.com/files/archive.zip",
      kind: "attachment" as const,
    };
    const htmlOnZip = isAcceptableMediaResponse(
      zipAttachment,
      "text/html",
      "<html><body>404 Not Found</body></html>",
    );
    assert.equal(htmlOnZip.acceptable, false);

    // validateMediaResponse alias returns { ok, reason }
    const res = validateMediaResponse(inlineCandidate, "image/png");
    assert.equal(res.ok, true);
  });

  void it("detects Chinese and English login/challenge titles in HTML attachments", () => {
    const htmlAttachment = {
      url: "https://linux.do/uploads/login-challenge.html",
      kind: "attachment" as const,
    };
    const challengeHtml = isAcceptableMediaResponse(
      htmlAttachment,
      "text/html",
      "<!doctype html><html><title>登录挑战</title></html>",
    );
    assert.equal(challengeHtml.acceptable, false);
    assert.match(challengeHtml.reason ?? "", /人机验证或登录错误页面/u);

    const genuineHtml = isAcceptableMediaResponse(
      htmlAttachment,
      "text/html",
      "<!doctype html><html><head><title>基准测试报告</title></head><body><h1>报告正文</h1></body></html>",
    );
    assert.equal(genuineHtml.acceptable, true);
  });

  void it("does not add srcset responsive variants as separate media candidates when src is present", () => {
    const html = `
      <p>Image with responsive srcset:</p>
      <img src="https://example.com/cover.png" srcset="https://example.com/cover-small.webp 1x, https://example.com/cover-large.webp 2x" alt="Cover" />
    `;
    const cleaned = cleanContent(html, { format: "html" });
    assert.deepEqual(
      cleaned.media.map((m) => m.url),
      ["https://example.com/cover.png"],
    );
  });

  void it("rewrites media URLs directly to binny://resource references using mediaRewrites option", () => {
    const html = `
      <p>Topic body</p>
      <img src="https://linux.do/uploads/photo.png" alt="Photo" />
      <p><a class="attachment" href="https://linux.do/uploads/report.pdf">Report.pdf</a></p>
    `;
    const mediaRewrites = {
      "https://linux.do/uploads/photo.png": {
        resourceId: "photo-res-001",
        sha256: "0".repeat(64),
        mediaType: "image/png",
        size: 1024,
      },
      "https://linux.do/uploads/report.pdf": {
        resourceId: "pdf-res-002",
        sha256: "1".repeat(64),
        mediaType: "application/pdf",
        size: 2048,
      },
    };
    const cleaned = cleanContent(html, {
      format: "html",
      mediaRewrites,
    });
    assert.match(
      cleaned.markdown,
      /!\[Photo\]\(binny:\/\/resource\/photo-res-001\)/u,
    );
    assert.match(
      cleaned.markdown,
      /\[Report\.pdf\]\(binny:\/\/resource\/pdf-res-002\)/u,
    );
  });

  void it("handles markdown format preserving code blocks, html tags, and indentation in markdown and text while rewriting images", () => {
    const input = `
# Markdown Document

Outside noise to strip:
<header><nav><a href="/home">Home</a></nav></header>
<script>alert("evil")</script>
<style>.hide { display: none; }</style>

Outside content with inline code: \`<script>alert("ok")</script>\` and \`<header>\`.

\`\`\`html
<header>
  <nav>
    <script>inside code</script>
  </nav>
</header>
\`\`\`

\`\`\`typescript
function calculate(x: number): number {
  // Multi-line indentation
  const y = x * 2;
  return y + 1;
}
\`\`\`

Here is an image outside code blocks:
![Cover Image](https://example.com/cover.png)
<img src="https://example.com/figure.png" alt="Figure 1" />
`;

    const cleaned = cleanContent(input, {
      format: "markdown",
      baseUrl: "https://example.com",
    });

    // 1. Noise HTML outside code blocks is stripped from both markdown and text
    assert.doesNotMatch(cleaned.markdown, /<header><nav>/u);
    assert.doesNotMatch(cleaned.markdown, /alert\("evil"\)/u);
    assert.doesNotMatch(cleaned.text, /alert\("evil"\)/u);
    assert.doesNotMatch(cleaned.markdown, /\.hide/u);
    assert.doesNotMatch(cleaned.text, /\.hide/u);

    // 2. Inline code spans preserve tags in both markdown and text
    assert.match(cleaned.markdown, /`<script>alert\("ok"\)<\/script>`/u);
    assert.match(cleaned.text, /<script>alert\("ok"\)<\/script>/u);
    assert.match(cleaned.markdown, /`<header>`/u);
    assert.match(cleaned.text, /<header>/u);

    // 3. Fenced code blocks preserve <script>, <nav>, <header>, and multi-line indentation in markdown
    assert.match(
      cleaned.markdown,
      /```html\n<header>\n  <nav>\n    <script>inside code<\/script>\n  <\/nav>\n<\/header>\n```/u,
    );
    assert.match(
      cleaned.markdown,
      /```typescript\nfunction calculate\(x: number\): number \{\n  \/\/ Multi-line indentation\n  const y = x \* 2;\n  return y \+ 1;\n\}\n```/u,
    );

    // 4. In text, fence markers are stripped, while code content, indentation, and newlines are preserved
    assert.match(
      cleaned.text,
      /<header>\n  <nav>\n    <script>inside code<\/script>\n  <\/nav>\n<\/header>/u,
    );
    assert.match(
      cleaned.text,
      /function calculate\(x: number\): number \{\n  \/\/ Multi-line indentation\n  const y = x \* 2;\n  return y \+ 1;\n\}/u,
    );
    assert.doesNotMatch(cleaned.text, /```html/u);
    assert.doesNotMatch(cleaned.text, /```typescript/u);

    // 5. Media candidates extracted from Markdown images and HTML images outside code blocks
    const urls = cleaned.media.map((m) => m.url);
    assert.ok(urls.includes("https://example.com/cover.png"));
    assert.ok(urls.includes("https://example.com/figure.png"));

    // 6. renderArchiveBody rewrites Markdown images outside code blocks
    const rewrites = new Map<string, ArchiveResourceMetadata>([
      [
        "https://example.com/cover.png",
        {
          resourceId: "res-cover-123",
          sha256: "0".repeat(64),
          mediaType: "image/png",
          size: 1024,
        },
      ],
      [
        "https://example.com/figure.png",
        {
          resourceId: "res-fig-456",
          sha256: "1".repeat(64),
          mediaType: "image/png",
          size: 2048,
        },
      ],
    ]);

    const rendered = cleaned.renderArchiveBody(rewrites);
    assert.match(
      rendered.markdown,
      /!\[Cover Image\]\(binny:\/\/resource\/res-cover-123\)/u,
    );
    assert.match(
      rendered.markdown,
      /!\[Figure 1\]\(binny:\/\/resource\/res-fig-456\)/u,
    );
    assert.equal(rendered.resources.length, 2);

    // Ensure code blocks in rendered markdown remain intact after resource rewrite
    assert.match(
      rendered.markdown,
      /```html\n<header>\n  <nav>\n    <script>inside code<\/script>\n  <\/nav>\n<\/header>\n```/u,
    );
  });
});
