// Qoder MDX/Markdown preprocessor and cleaner.
// Transforms Mintlify/MDX components into semantic Markdown and extracts metadata.
import {
  cleanContent,
  type CleanContentResult,
} from "@binny/source-adapter-sdk";

export interface QoderMdxUpdate {
  readonly label: string;
  readonly description?: string | undefined;
}

/** Returns the first Markdown H1 as a source title, or null when the page has none. */
export function extractQoderDocumentTitle(markdown: string): string | null {
  const match = /^\s{0,3}#\s+(.+?)\s*#*\s*$/mu.exec(markdown);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

export interface TransformMdxResult {
  readonly transformedMarkdown: string;
  readonly updates: readonly QoderMdxUpdate[];
}

export interface CleanQoderMdxResult {
  readonly cleanResult: CleanContentResult;
  readonly updates: readonly QoderMdxUpdate[];
  readonly transformedMarkdown: string;
}

export interface CleanQoderMdxOptions {
  readonly baseUrl?: string | undefined;
}

/**
 * Transforms Qoder Mintlify/MDX source into standard Markdown while preserving semantic facts.
 * Extracts `<Update>` metadata, converts `<Card>` components to list items/links,
 * `<Note>`/`<Warning>` to blockquotes, `<Accordion>`/`<Step>`/`<Tab>` to subheadings,
 * and strips Mintlify boilerplate noise.
 */
export function transformQoderMdx(rawMarkdown: string): TransformMdxResult {
  let md = rawMarkdown;

  // 1. Strip YAML frontmatter at document start
  if (md.startsWith("---")) {
    const endMatch = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
    if (endMatch) {
      md = md.slice(endMatch[0].length);
    }
  }

  // 2. Strip first-line Mintlify documentation index prompts
  // Matches:
  // > ## Documentation Index
  // > Fetch the complete documentation index at: ...
  // > Use this file to discover all available pages before exploring further.
  md = md.replace(
    /^>\s*##\s*Documentation Index[\s\S]*?>\s*Use this file to discover all available pages before exploring further\.?\r?\n?/gmu,
    "",
  );
  md = md.replace(
    /^>\s*(?:##\s*Documentation Index|Fetch the complete documentation index at:[\s\S]*?before exploring further\.?)\r?\n?/gmu,
    "",
  );

  // 3. Strip inline style blocks
  md = md.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "");

  // 4. Strip custom heading anchor comments/spans and JSX anchors
  // e.g. {/* #anchor */}
  md = md.replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
  // e.g. <a id="..." style={{ ... }} /> or <a id="..."></a>
  md = md.replace(/<a\b[^>]*\bid=["'][^"']*["'][^>]*\/>/giu, "");
  md = md.replace(/<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>/giu, "");
  md = md.replace(/<span\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/span>/giu, "");

  // 5. Extract <Update label="..." description="..."> and convert into Markdown section headings
  const updates: QoderMdxUpdate[] = [];
  md = md.replace(
    /<Update\b([^>]*)>([\s\S]*?)<\/Update>/giu,
    (_match, attrsStr: string, bodyContent: string) => {
      const labelMatch = attrsStr.match(/\blabel=(?:"([^"]*)"|'([^']*)')/u);
      const descMatch = attrsStr.match(
        /\bdescription=(?:"([^"]*)"|'([^']*)')/u,
      );
      const label = (labelMatch?.[1] ?? labelMatch?.[2] ?? "").trim();
      const description = (descMatch?.[1] ?? descMatch?.[2] ?? "").trim();

      if (label.length > 0) {
        updates.push({
          label,
          ...(description.length > 0 ? { description } : {}),
        });
      }

      let heading = "";
      if (label.length > 0 && description.length > 0) {
        heading = `## ${label} (${description})`;
      } else if (label.length > 0) {
        heading = `## ${label}`;
      } else if (description.length > 0) {
        heading = `## ${description}`;
      }

      const trimmedBody = bodyContent.trim();
      if (heading.length > 0) {
        return trimmedBody.length > 0
          ? `\n\n${heading}\n\n${trimmedBody}\n\n`
          : `\n\n${heading}\n\n`;
      }
      return trimmedBody.length > 0 ? `\n\n${trimmedBody}\n\n` : "";
    },
  );

  // 6. Strip container tags: <CardGroup>, <AccordionGroup>, <Steps>, <Tabs>, <Frame>, <CodeGroup>
  md = md.replace(
    /<\/?(?:CardGroup|AccordionGroup|Steps|Tabs|Frame|CodeGroup)\b[^>]*>/giu,
    "",
  );

  // 7. Convert <Card title="..." href="..."> into list items
  md = md.replace(
    /<Card\b([^>]*)>(?:([\s\S]*?)<\/Card>)?/giu,
    (_match, attrsStr: string, bodyContent?: string) => {
      const titleMatch = attrsStr.match(/\btitle=(?:"([^"]*)"|'([^']*)')/u);
      const hrefMatch = attrsStr.match(/\bhref=(?:"([^"]*)"|'([^']*)')/u);
      const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim();
      const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? "").trim();
      const body = (bodyContent ?? "").trim();

      let formatted = "";
      if (title.length > 0 && href.length > 0) {
        formatted =
          body.length > 0
            ? `- [${title}](${href}): ${body}`
            : `- [${title}](${href})`;
      } else if (title.length > 0) {
        formatted =
          body.length > 0 ? `- **${title}**: ${body}` : `- **${title}**`;
      } else if (href.length > 0) {
        formatted =
          body.length > 0 ? `- [${body}](${href})` : `- [${href}](${href})`;
      } else if (body.length > 0) {
        formatted = `- ${body}`;
      }
      return formatted.length > 0 ? `\n\n${formatted}\n\n` : "";
    },
  );

  // 8. Convert <Accordion title="...">, <Step title="...">, <Tab title="..."> into subheadings (### title)
  md = md.replace(
    /<(Accordion|Step|Tab)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
    (_match, _tag: string, attrsStr: string, bodyContent: string) => {
      const titleMatch = attrsStr.match(/\btitle=(?:"([^"]*)"|'([^']*)')/u);
      const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim();
      const trimmedBody = bodyContent.trim();
      if (title.length > 0) {
        return trimmedBody.length > 0
          ? `\n\n### ${title}\n\n${trimmedBody}\n\n`
          : `\n\n### ${title}\n\n`;
      }
      return trimmedBody.length > 0 ? `\n\n${trimmedBody}\n\n` : "";
    },
  );

  // 9. Convert <Note>, <Warning>, <Info>, <Tip>, <Callout>, <Check>, <Caution> into Markdown blockquotes (> ...)
  md = md.replace(
    /<(Note|Warning|Info|Tip|Callout|Check|Caution)\b[^>]*>([\s\S]*?)<\/\1>/giu,
    (_match, _tag: string, bodyContent: string) => {
      const lines = bodyContent.trim().split(/\r?\n/u);
      const quoted = lines
        .map((line) => {
          const trimmed = line.trim();
          return trimmed.length > 0 ? `> ${trimmed}` : ">";
        })
        .join("\n");
      return quoted.length > 0 ? `\n\n${quoted}\n\n` : "";
    },
  );

  // 10. Strip other Mintlify tags
  md = md.replace(/<Icon\b[^>]*\/?>/giu, "");
  md = md.replace(/<Tooltip\b[^>]*>([\s\S]*?)<\/Tooltip>/giu, "$1");

  // 11. Convert Markdown image syntax outside code blocks into <img> tags
  // so cleanContent can discover media candidates and resolve relative URLs.
  const lines = md.split("\n");
  let inCodeBlock = false;
  const processedLines: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      processedLines.push(line);
      continue;
    }
    if (inCodeBlock) {
      processedLines.push(line);
      continue;
    }
    const replaced = line.replaceAll(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/gu,
      (_match, alt, url, title) => {
        const titleAttr = title ? ` title="${title}"` : "";
        return `<img src="${url}" alt="${alt}"${titleAttr} />`;
      },
    );
    processedLines.push(replaced);
  }
  md = processedLines.join("\n");

  // 12. Normalize consecutive blank lines
  md = md.replace(/\n{3,}/gu, "\n\n").trim();

  return {
    transformedMarkdown: md,
    updates,
  };
}

/**
 * Transforms Qoder Mintlify/MDX source and cleans it through cleanContent from @binny/source-adapter-sdk.
 */
export function cleanQoderMdx(
  rawMarkdown: string,
  options: CleanQoderMdxOptions = {},
): CleanQoderMdxResult {
  const { transformedMarkdown, updates } = transformQoderMdx(rawMarkdown);
  const cleanResult = cleanContent(transformedMarkdown, {
    format: "markdown",
    baseUrl: options.baseUrl,
  });

  return {
    cleanResult,
    updates,
    transformedMarkdown,
  };
}
