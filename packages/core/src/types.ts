/** A location in the repository that backs up a claim (file + optional 1-based line). */
export interface Evidence {
  file: string;
  line?: number;
  note?: string;
}

export type LanguageId =
  | 'typescript' | 'javascript' | 'python' | 'java' | 'kotlin' | 'csharp' | 'go'
  | 'rpgle' | 'sqlrpgle' | 'rpg' | 'cl' | 'dds' | 'cmd' | 'sql' | 'cobol'
  | 'html' | 'css' | 'json' | 'yaml' | 'xml' | 'markdown' | 'shell' | 'other';

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'procedure' | 'program' | 'interface' | 'variable';
  line: number;
  exported?: boolean;
}

export type ReferenceKind = 'import' | 'include' | 'call' | 'file';

/** A raw reference found while parsing a file, before resolution. */
export interface RawReference {
  specifier: string;
  kind: ReferenceKind;
  line: number;
  /** Type-only import (TS `import type`, Python `if TYPE_CHECKING:`) — not a runtime dependency. */
  typeOnly?: boolean;
}

export interface FileInfo {
  /** Repository-relative path with forward slashes. */
  path: string;
  language: LanguageId;
  size: number;
  lines: number;
  symbols: SymbolInfo[];
  references: RawReference[];
  /** True if the file looks like a program/app entry point on its own (e.g. has main()). */
  selfEntry?: Evidence;
  isTest: boolean;
}

export interface Edge {
  from: string;
  to: string;
  kind: ReferenceKind;
  line: number;
  specifier: string;
  typeOnly?: boolean;
}

export interface ExternalDependency {
  name: string;
  version?: string;
  ecosystem: 'npm' | 'pypi' | 'maven' | 'gradle' | 'nuget' | 'go' | 'ibmi';
  dev?: boolean;
  evidence: Evidence;
}

export interface Detection {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: Evidence[];
}

export interface BuildCommand {
  label: string;
  command: string;
  cwd: string;
  tool: string;
  evidence: Evidence;
}

export interface EntryPoint {
  file: string;
  reason: string;
  evidence: Evidence;
}

export interface ModuleInfo {
  name: string;
  files: number;
  lines: number;
  languages: string[];
  dependsOn: string[];
}

export interface RepoIndex {
  root: string;
  name: string;
  scannedAt: string;
  durationMs: number;
  truncated: boolean;
  files: FileInfo[];
  languages: { language: LanguageId; files: number; lines: number }[];
  frameworks: Detection[];
  buildSystems: Detection[];
  buildCommands: BuildCommand[];
  entryPoints: EntryPoint[];
  externalDependencies: ExternalDependency[];
  edges: Edge[];
  unresolved: { from: string; specifier: string; line: number }[];
  modules: ModuleInfo[];
  hotspots: { file: string; dependents: number }[];
  cycles: string[][];
  readme?: string;
  testFiles: number;
}

export interface ScanOptions {
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  onProgress?: (scanned: number, current: string) => void;
  isCancelled?: () => boolean;
}
