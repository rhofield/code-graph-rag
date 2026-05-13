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
  resolverFieldNames: string[];
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

interface TypeScriptGraphQLExtraction extends GraphQLSourceExtraction {
  documentVariables: Map<string, ExtractedGraphQLDocument>;
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
const TYPESCRIPT_IMPORT_RE = /import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
const TYPESCRIPT_EXPORT_FROM_RE = /export\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
const ANY_GRAPHQL_TAG_RE = /\b(?:gql|graphql)\s*`/g;
const GRAPHQL_CALL_ARG_RE = /\b(?:useQuery|useSuspenseQuery|useLazyQuery|useMutation|useSubscription|useFragment|readFragment|writeFragment)\s*(?:<[^)]*?>)?\(\s*([A-Za-z_$][_0-9A-Za-z$]*)/g;
const GRAPHQL_CLIENT_OBJECT_ARG_RE = /\b(?:query|mutate|mutation|subscribe|watchQuery|readFragment|writeFragment)\s*\(\s*\{[\s\S]{0,800}?\b(?:query|mutation|fragment|document)\s*:\s*([A-Za-z_$][_0-9A-Za-z$]*)/g;
const APOLLO_GENERATED_HOOK_RE = /\buse([A-Z][_0-9A-Za-z]*?)(LazyQuery|SuspenseQuery|Query|Mutation|Subscription)\s*\(/g;

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

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWhitespaceAndComments(source: string, index: number): number {
  let i = index;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    break;
  }
  return i;
}

function readName(source: string, index: number): { name: string; end: number } | null {
  const match = source.slice(index).match(/^[_A-Za-z][_0-9A-Za-z]*/);
  if (!match) return null;
  return { name: match[0], end: index + match[0].length };
}

function skipBalanced(source: string, index: number, open: string, close: string): number {
  if (source[index] !== open) return index;
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    if (source[i] === open) depth++;
    if (source[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

function extractTopLevelOperationFields(snippet: string, kind: GraphQLDocumentKind): string[] {
  if (kind === "fragment") return [];
  const selectionStart = snippet.indexOf("{");
  if (selectionStart === -1) return [];
  const selectionEnd = findMatchingBrace(snippet, selectionStart);
  if (selectionEnd === -1) return [];

  const fields: string[] = [];
  const seen = new Set<string>();
  let i = selectionStart + 1;
  let depth = 1;

  while (i < selectionEnd) {
    const ch = snippet[i];
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth !== 1) {
      i++;
      continue;
    }

    i = skipWhitespaceAndComments(snippet, i);
    if (i >= selectionEnd) break;
    if (snippet[i] === "{") {
      depth++;
      i++;
      continue;
    }
    if (snippet[i] === "}") {
      depth--;
      i++;
      continue;
    }
    if (snippet.startsWith("...", i)) {
      i += 3;
      continue;
    }
    if (snippet[i] === "@") {
      const directive = readName(snippet, i + 1);
      i = directive ? directive.end : i + 1;
      i = skipWhitespaceAndComments(snippet, i);
      if (snippet[i] === "(") i = skipBalanced(snippet, i, "(", ")");
      continue;
    }
    if (snippet[i] === "(") {
      i = skipBalanced(snippet, i, "(", ")");
      continue;
    }

    const first = readName(snippet, i);
    if (!first) {
      i++;
      continue;
    }

    let fieldName = first.name;
    let cursor = skipWhitespaceAndComments(snippet, first.end);
    if (snippet[cursor] === ":") {
      cursor = skipWhitespaceAndComments(snippet, cursor + 1);
      const aliased = readName(snippet, cursor);
      if (aliased) {
        fieldName = aliased.name;
        cursor = aliased.end;
      }
    }

    if (!seen.has(fieldName)) {
      seen.add(fieldName);
      fields.push(fieldName);
    }
    i = cursor;
  }

  return fields;
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
      resolverFieldNames: extractTopLevelOperationFields(snippet, def.kind),
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

function firstOperationDocument(documents: ExtractedGraphQLDocument[]): ExtractedGraphQLDocument | undefined {
  return documents.find((doc) => doc.kind !== "fragment") ?? documents[0];
}

function documentKey(document: ExtractedGraphQLDocument): string {
  return `${document.kind}\0${document.name}\0${document.filePath}`;
}

function fragmentSpreadKey(spread: ExtractedGraphQLFragmentSpread): string {
  return [
    spread.sourceDocumentName,
    spread.sourceDocumentFilePath,
    spread.targetFragmentName,
    spread.targetFragmentFilePath ?? "",
  ].join("\0");
}

function resolveFragmentSpreadTargets(
  fragmentSpreads: ExtractedGraphQLFragmentSpread[],
  documents: ExtractedGraphQLDocument[]
): ExtractedGraphQLFragmentSpread[] {
  const fragmentPathsByName = new Map<string, Set<string>>();
  for (const document of documents) {
    if (document.kind !== "fragment") continue;
    const paths = fragmentPathsByName.get(document.name) ?? new Set<string>();
    paths.add(document.filePath);
    fragmentPathsByName.set(document.name, paths);
  }

  return fragmentSpreads.map((spread) => {
    const paths = fragmentPathsByName.get(spread.targetFragmentName);
    if (!paths || paths.size === 0) return spread;

    if (paths.size === 1) {
      return { ...spread, targetFragmentFilePath: [...paths][0] };
    }

    if (paths.has(spread.sourceDocumentFilePath)) {
      return { ...spread, targetFragmentFilePath: spread.sourceDocumentFilePath };
    }

    return spread;
  });
}

function resolveGraphQLImport(sourceFilePath: string, importSource: string): string | null {
  if (!importSource.startsWith(".")) return null;
  const resolved = resolve(dirname(sourceFilePath), importSource);
  const candidates = extname(resolved) ? [resolved] : [`${resolved}.graphql`, `${resolved}.gql`];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
}

function resolveTypeScriptImport(sourceFilePath: string, importSource: string): string | null {
  if (!importSource.startsWith(".")) return null;
  const resolved = resolve(dirname(sourceFilePath), importSource);
  const candidates = extname(resolved)
    ? [resolved]
    : [
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}.js`,
        `${resolved}.jsx`,
        resolve(resolved, "index.ts"),
        resolve(resolved, "index.tsx"),
        resolve(resolved, "index.js"),
        resolve(resolved, "index.jsx"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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

function extractImportBindings(importClause: string): Array<{ localName: string; importedName: string | null }> {
  const trimmed = importClause.trim();
  const bindings: Array<{ localName: string; importedName: string | null }> = [];
  const defaultName = trimmed.match(/^([A-Za-z_$][_0-9A-Za-z$]*)/);
  if (defaultName) bindings.push({ localName: defaultName[1], importedName: null });

  const named = trimmed.match(/\{([^}]+)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const clean = part.trim();
      const alias = clean.match(/^([A-Za-z_$][_0-9A-Za-z$]*)\s+as\s+([A-Za-z_$][_0-9A-Za-z$]*)$/);
      const direct = clean.match(/^([A-Za-z_$][_0-9A-Za-z$]*)$/);
      if (alias) bindings.push({ localName: alias[2], importedName: alias[1] });
      else if (direct) bindings.push({ localName: direct[1], importedName: direct[1] });
    }
  }

  return bindings;
}

export function extractGraphQLArtifactsFromTypeScript(
  source: string,
  filePath: string,
  visitedFiles: Set<string> = new Set(),
  cache: Map<string, TypeScriptGraphQLExtraction> = new Map()
): TypeScriptGraphQLExtraction {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const documents: ExtractedGraphQLDocument[] = [];
  const fragmentSpreads: ExtractedGraphQLFragmentSpread[] = [];
  const documentVariables = new Map<string, ExtractedGraphQLDocument>();
  const assignedTemplateRanges: Array<{ start: number; end: number }> = [];
  const seenDocuments = new Set<string>();
  const seenFragmentSpreads = new Set<string>();

  function addDocuments(items: ExtractedGraphQLDocument[]): void {
    for (const document of items) {
      const key = documentKey(document);
      if (seenDocuments.has(key)) continue;
      seenDocuments.add(key);
      documents.push(document);
    }
  }

  function addFragmentSpreads(items: ExtractedGraphQLFragmentSpread[]): void {
    for (const spread of items) {
      const key = fragmentSpreadKey(spread);
      if (seenFragmentSpreads.has(key)) continue;
      seenFragmentSpreads.add(key);
      fragmentSpreads.push(spread);
    }
  }

  for (const match of source.matchAll(GRAPHQL_TAG_RE)) {
    const variableName = match[1];
    const templateStart = (match.index ?? 0) + match[0].length;
    const templateEnd = findMatchingTemplateEnd(source, templateStart);
    if (templateEnd === -1) continue;
    assignedTemplateRanges.push({ start: match.index ?? 0, end: templateEnd + 1 });

    const templateSource = source.slice(templateStart, templateEnd);
    const parsed = parseGraphQLDocuments(templateSource, filePath, {
      startOffset: templateStart,
      variableName,
    });
    addDocuments(parsed.documents);
    addFragmentSpreads(parsed.fragmentSpreads);
    if (parsed.documents.length > 0) {
      documentVariables.set(variableName, firstOperationDocument(parsed.documents)!);
    }
  }

  let inlineCounter = 0;
  for (const match of source.matchAll(ANY_GRAPHQL_TAG_RE)) {
    const tagStart = match.index ?? 0;
    if (assignedTemplateRanges.some((range) => tagStart >= range.start && tagStart < range.end)) {
      continue;
    }
    const templateStart = tagStart + match[0].length;
    const templateEnd = findMatchingTemplateEnd(source, templateStart);
    if (templateEnd === -1) continue;

    inlineCounter++;
    const templateSource = source.slice(templateStart, templateEnd);
    const parsed = parseGraphQLDocuments(templateSource, filePath, {
      startOffset: templateStart,
      variableName: `__inline_graphql_${inlineCounter}`,
    });
    addDocuments(parsed.documents);
    addFragmentSpreads(parsed.fragmentSpreads);
  }

  for (const match of source.matchAll(GRAPHQL_IMPORT_RE)) {
    const localNames = extractImportLocalNames(match[1]);
    const resolvedPath = resolveGraphQLImport(filePath, match[2]);
    if (!resolvedPath) continue;

    const imported = parseImportedDocument(resolvedPath);
    if (!imported || imported.documents.length === 0) continue;
    addDocuments(imported.documents);
    addFragmentSpreads(imported.fragmentSpreads);

    const operation = firstOperationDocument(imported.documents);
    for (const localName of localNames) {
      if (operation) documentVariables.set(localName, operation);
    }
  }

  for (const match of source.matchAll(TYPESCRIPT_IMPORT_RE)) {
    if (/\.(?:graphql|gql)$/.test(match[2])) continue;
    const resolvedPath = resolveTypeScriptImport(filePath, match[2]);
    if (!resolvedPath || visitedFiles.has(resolvedPath)) continue;

    const importedSource = readFileSync(resolvedPath, "utf-8");
    const imported = extractGraphQLArtifactsFromTypeScript(
      importedSource,
      resolvedPath,
      new Set([...visitedFiles, filePath]),
      cache
    );
    if (imported.documents.length === 0) continue;

    addDocuments(imported.documents);
    addFragmentSpreads(imported.fragmentSpreads);

    for (const binding of extractImportBindings(match[1])) {
      const document = binding.importedName
        ? imported.documentVariables.get(binding.importedName)
        : firstOperationDocument(imported.documents);
      if (document) documentVariables.set(binding.localName, document);
    }
  }

  for (const match of source.matchAll(TYPESCRIPT_EXPORT_FROM_RE)) {
    const resolvedPath = resolveTypeScriptImport(filePath, match[2]);
    if (!resolvedPath || visitedFiles.has(resolvedPath)) continue;

    const importedSource = readFileSync(resolvedPath, "utf-8");
    const imported = extractGraphQLArtifactsFromTypeScript(
      importedSource,
      resolvedPath,
      new Set([...visitedFiles, filePath]),
      cache
    );
    if (imported.documents.length === 0) continue;

    addDocuments(imported.documents);
    addFragmentSpreads(imported.fragmentSpreads);

    for (const binding of extractImportBindings(match[1])) {
      const document = binding.importedName
        ? imported.documentVariables.get(binding.importedName)
        : firstOperationDocument(imported.documents);
      if (document) documentVariables.set(binding.localName, document);
    }
  }

  const result = {
    documents,
    fragmentSpreads: resolveFragmentSpreadTargets(fragmentSpreads, documents),
    documentVariables,
  };
  cache.set(filePath, result);
  return result;
}

export function extractGraphQLUsagesFromFunction(
  functionSource: string,
  sourceName: string,
  sourceFilePath: string,
  documentVariables: Map<string, ExtractedGraphQLDocument>,
  documents: ExtractedGraphQLDocument[] = [...documentVariables.values()]
): ExtractedGraphQLUsage[] {
  const usages: ExtractedGraphQLUsage[] = [];
  const seen = new Set<string>();
  const documentCandidates = [...documentVariables.values(), ...documents];

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
  for (const match of functionSource.matchAll(APOLLO_GENERATED_HOOK_RE)) {
    const operationName = match[1];
    const document = documentCandidates.find((doc) => doc.name === operationName);
    if (!document) continue;
    const key = `${sourceName}:${document.name}:${document.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usages.push({
      sourceName,
      sourceFilePath,
      documentName: document.name,
      documentFilePath: document.filePath,
    });
  }
  for (const match of functionSource.matchAll(ANY_GRAPHQL_TAG_RE)) {
    const templateStart = (match.index ?? 0) + match[0].length;
    const templateEnd = findMatchingTemplateEnd(functionSource, templateStart);
    if (templateEnd === -1) continue;
    const parsed = parseGraphQLDocuments(functionSource.slice(templateStart, templateEnd), sourceFilePath);
    for (const document of parsed.documents) {
      if (document.kind === "fragment") continue;
      const key = `${sourceName}:${document.name}:${sourceFilePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usages.push({
        sourceName,
        sourceFilePath,
        documentName: document.name,
        documentFilePath: sourceFilePath,
      });
    }
  }

  return usages;
}
