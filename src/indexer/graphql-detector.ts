import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export type GraphQLDocumentKind = "query" | "mutation" | "subscription" | "fragment";

export interface ExtractedGraphQLDocument {
  name: string;
  kind: GraphQLDocumentKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  snippet: string;
  variableName: string | null;
}

export interface ExtractedGraphQLUsage {
  sourceName: string;
  sourceFilePath: string;
  documentName: string;
  documentFilePath: string | null;
}

export interface ExtractedGraphQLFragmentSpread {
  sourceDocumentName: string;
  sourceDocumentFilePath: string;
  targetFragmentName: string;
  targetFragmentFilePath: string | null;
}

export interface GraphQLSourceExtraction {
  documents: ExtractedGraphQLDocument[];
  fragmentSpreads: ExtractedGraphQLFragmentSpread[];
}

interface DocumentMatch {
  name: string;
  kind: GraphQLDocumentKind;
  index: number;
}

const DEFINITION_RE = /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)|\bfragment\s+([_A-Za-z][_0-9A-Za-z]*)\s+on\b/g;
const FRAGMENT_SPREAD_RE = /\.\.\.\s*(?!on\b)([_A-Za-z][_0-9A-Za-z]*)/g;
const GRAPHQL_TAG_RE = /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][_0-9A-Za-z$]*)[^=]*=\s*(?:gql|graphql)\s*`/g;
const GRAPHQL_IMPORT_RE = /import\s+([^;]*?)\s+from\s+["']([^"']+\.(?:graphql|gql))["']/g;
const GRAPHQL_CALL_ARG_RE = /\b(?:useQuery|useSuspenseQuery|useLazyQuery|useMutation|useSubscription|useFragment|readFragment|writeFragment)\s*(?:<[^)]*?>)?\(\s*([A-Za-z_$][_0-9A-Za-z$]*)/g;
const GRAPHQL_CLIENT_OBJECT_ARG_RE = /\b(?:query|mutate|mutation|subscribe|watchQuery|readFragment|writeFragment)\s*\(\s*\{[\s\S]{0,800}?\b(?:query|mutation|fragment|document)\s*:\s*([A-Za-z_$][_0-9A-Za-z$]*)/g;

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findMatchingTemplateEnd(source: string, startIndex: number): number {
  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") return i;
  }
  return -1;
}

function stripTemplateInterpolations(source: string): string {
  return source.replace(/\$\{[^}]*\}/g, "");
}

function findDocumentDefinitions(source: string): DocumentMatch[] {
  const matches: DocumentMatch[] = [];
  for (const match of source.matchAll(DEFINITION_RE)) {
    const operationKind = match[1] as GraphQLDocumentKind | undefined;
    const operationName = match[2];
    const fragmentName = match[3];
    if (operationKind && operationName) {
      matches.push({ name: operationName, kind: operationKind, index: match.index ?? 0 });
    } else if (fragmentName) {
      matches.push({ name: fragmentName, kind: "fragment", index: match.index ?? 0 });
    }
  }
  return matches;
}

export function parseGraphQLDocuments(
  source: string,
  filePath: string,
  options: { startOffset?: number; variableName?: string | null } = {}
): GraphQLSourceExtraction {
  const startOffset = options.startOffset ?? 0;
  const variableName = options.variableName ?? null;
  const cleanSource = stripTemplateInterpolations(source);
  const definitions = findDocumentDefinitions(cleanSource);
  const documents: ExtractedGraphQLDocument[] = [];
  const fragmentSpreads: ExtractedGraphQLFragmentSpread[] = [];

  for (let i = 0; i < definitions.length; i++) {
    const def = definitions[i];
    const next = definitions[i + 1];
    const end = next ? next.index : cleanSource.length;
    const snippet = cleanSource.slice(def.index, end).trim();
    const startLine = lineNumberAt(cleanSource, def.index) + lineNumberAt(source.slice(0, startOffset), startOffset) - 1;
    const endLine = startLine + Math.max(0, snippet.split("\n").length - 1);
    const signature = def.kind === "fragment"
      ? `fragment ${def.name}`
      : `${def.kind} ${def.name}`;

    documents.push({
      name: def.name,
      kind: def.kind,
      filePath,
      startLine,
      endLine,
      signature,
      snippet,
      variableName,
    });

    for (const spread of snippet.matchAll(FRAGMENT_SPREAD_RE)) {
      fragmentSpreads.push({
        sourceDocumentName: def.name,
        sourceDocumentFilePath: filePath,
        targetFragmentName: spread[1],
        targetFragmentFilePath: filePath,
      });
    }
  }

  return { documents, fragmentSpreads };
}

function parseImportedDocument(importPath: string): GraphQLSourceExtraction | null {
  if (!existsSync(importPath)) return null;
  const source = readFileSync(importPath, "utf-8");
  return parseGraphQLDocuments(source, importPath);
}

function resolveGraphQLImport(sourceFilePath: string, importSource: string): string | null {
  if (!importSource.startsWith(".")) return null;
  const resolved = resolve(dirname(sourceFilePath), importSource);
  const candidates = extname(resolved) ? [resolved] : [`${resolved}.graphql`, `${resolved}.gql`];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
}

function extractImportLocalNames(importClause: string): string[] {
  const trimmed = importClause.trim();
  const names: string[] = [];
  const defaultName = trimmed.match(/^([A-Za-z_$][_0-9A-Za-z$]*)/);
  if (defaultName) names.push(defaultName[1]);

  const named = trimmed.match(/\{([^}]+)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const alias = part.trim().match(/\bas\s+([A-Za-z_$][_0-9A-Za-z$]*)$/);
      const direct = part.trim().match(/^([A-Za-z_$][_0-9A-Za-z$]*)$/);
      if (alias) names.push(alias[1]);
      else if (direct) names.push(direct[1]);
    }
  }

  const namespaceName = trimmed.match(/\*\s+as\s+([A-Za-z_$][_0-9A-Za-z$]*)/);
  if (namespaceName) names.push(namespaceName[1]);
  return [...new Set(names)];
}

export function extractGraphQLArtifactsFromTypeScript(
  source: string,
  filePath: string
): {
  documents: ExtractedGraphQLDocument[];
  fragmentSpreads: ExtractedGraphQLFragmentSpread[];
  documentVariables: Map<string, ExtractedGraphQLDocument>;
} {
  const documents: ExtractedGraphQLDocument[] = [];
  const fragmentSpreads: ExtractedGraphQLFragmentSpread[] = [];
  const documentVariables = new Map<string, ExtractedGraphQLDocument>();

  for (const match of source.matchAll(GRAPHQL_TAG_RE)) {
    const variableName = match[1];
    const templateStart = (match.index ?? 0) + match[0].length;
    const templateEnd = findMatchingTemplateEnd(source, templateStart);
    if (templateEnd === -1) continue;

    const templateSource = source.slice(templateStart, templateEnd);
    const parsed = parseGraphQLDocuments(templateSource, filePath, {
      startOffset: templateStart,
      variableName,
    });
    documents.push(...parsed.documents);
    fragmentSpreads.push(...parsed.fragmentSpreads);
    if (parsed.documents.length > 0) {
      documentVariables.set(variableName, parsed.documents[0]);
    }
  }

  for (const match of source.matchAll(GRAPHQL_IMPORT_RE)) {
    const localNames = extractImportLocalNames(match[1]);
    const resolvedPath = resolveGraphQLImport(filePath, match[2]);
    if (!resolvedPath) continue;

    const imported = parseImportedDocument(resolvedPath);
    if (!imported || imported.documents.length === 0) continue;
    documents.push(...imported.documents);
    fragmentSpreads.push(...imported.fragmentSpreads);

    const operation = imported.documents.find((doc) => doc.kind !== "fragment") ?? imported.documents[0];
    for (const localName of localNames) {
      documentVariables.set(localName, operation);
    }
  }

  return { documents, fragmentSpreads, documentVariables };
}

export function extractGraphQLUsagesFromFunction(
  functionSource: string,
  sourceName: string,
  sourceFilePath: string,
  documentVariables: Map<string, ExtractedGraphQLDocument>
): ExtractedGraphQLUsage[] {
  const usages: ExtractedGraphQLUsage[] = [];
  const seen = new Set<string>();

  function addUsage(variableName: string): void {
    const document = documentVariables.get(variableName);
    if (!document) return;
    const key = `${sourceName}:${document.name}:${document.filePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    usages.push({
      sourceName,
      sourceFilePath,
      documentName: document.name,
      documentFilePath: document.filePath,
    });
  }

  for (const match of functionSource.matchAll(GRAPHQL_CALL_ARG_RE)) {
    addUsage(match[1]);
  }
  for (const match of functionSource.matchAll(GRAPHQL_CLIENT_OBJECT_ARG_RE)) {
    addUsage(match[1]);
  }

  return usages;
}
