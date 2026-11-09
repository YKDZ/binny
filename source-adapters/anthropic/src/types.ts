// Shared type definitions for Anthropic source adapter.
import type { CleanContentResult } from "@binny/source-adapter-sdk";

export interface DiscoveredArticle {
  readonly canonicalPath: string;
  readonly url: string;
  readonly title: string;
  readonly cardDate?: string | undefined;
  readonly category?: string | undefined;
  readonly sectionId: string;
}

export interface ExtractedArticle {
  readonly title: string;
  readonly cleanResult: CleanContentResult;
  readonly publishedAt?: string | undefined;
  readonly publishedDate?: string | undefined;
  readonly sourceModifiedAt?: string | undefined;
  readonly isStandardLayout: boolean;
}

export type ExtractionResult =
  | { readonly ok: true; readonly article: ExtractedArticle }
  | { readonly ok: false; readonly reason: string };

export interface CandidateArticle {
  readonly canonicalPath: string;
  readonly url: string;
  readonly title: string;
  readonly cardDate?: string | undefined;
  readonly category?: string | undefined;
  readonly sections: Set<string>;
  readonly fingerprint: string;
  readonly sitemapLastMod?: string | undefined;
}
