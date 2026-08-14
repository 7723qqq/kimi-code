/**
 * `lsp` domain — minimal LSP wire vocabulary.
 *
 * Hand-written subset of the Language Server Protocol types (zero-based
 * UTF-16 positions, matching the wire protocol) plus the JSON-RPC message
 * envelope. Kept deliberately small: only the shapes the four semantic
 * operations (definition / references / implementation / hover) and the
 * stdio handshake need. No external protocol dependency.
 */

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspLocationLink {
  readonly targetUri: string;
  readonly targetRange: LspRange;
  readonly targetSelectionRange: LspRange;
  readonly originSelectionRange?: LspRange;
}

export interface LspMarkupContent {
  readonly kind: 'plaintext' | 'markdown';
  readonly value: string;
}

export type LspMarkedString = string | { readonly language: string; readonly value: string };

export type LspHoverContents = LspMarkupContent | LspMarkedString | readonly (LspMarkupContent | LspMarkedString)[];

export interface LspHover {
  readonly contents: LspHoverContents;
  readonly range?: LspRange;
}

export interface LspTextDocumentIdentifier {
  readonly uri: string;
}

export interface LspTextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface LspTextDocumentPositionParams {
  readonly textDocument: LspTextDocumentIdentifier;
  readonly position: LspPosition;
}

export interface LspWorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

export interface LspClientCapabilities {
  readonly textDocument?: {
    readonly hover?: { readonly contentFormat?: readonly string[] };
  };
  readonly workspace?: {
    readonly configuration?: boolean;
  };
}

export interface LspInitializeParams {
  readonly processId: number | null;
  readonly rootUri: string | null;
  readonly workspaceFolders: readonly LspWorkspaceFolder[] | null;
  readonly capabilities: LspClientCapabilities;
}

export interface LspServerCapabilities {
  readonly positionEncoding?: string;
  readonly hoverProvider?: boolean;
  readonly definitionProvider?: boolean;
  readonly referencesProvider?: boolean;
  readonly implementationProvider?: boolean;
}

export interface LspInitializeResult {
  readonly capabilities: LspServerCapabilities;
  readonly serverInfo?: { readonly name: string; readonly version?: string };
}

export interface LspDidOpenTextDocumentParams {
  readonly textDocument: LspTextDocumentItem;
}

export interface LspDidCloseTextDocumentParams {
  readonly textDocument: LspTextDocumentIdentifier;
}

export interface LspWorkspaceConfigurationParams {
  readonly items: readonly { readonly section?: string }[];
}

export interface LspApplyWorkspaceEditParams {
  readonly edit: unknown;
}

export interface LspApplyWorkspaceEditResult {
  readonly applied: boolean;
  readonly failureReason?: string;
}

export interface LspRequestMessage {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface LspResponseMessage {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface LspNotificationMessage {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export type LspMessage = LspRequestMessage | LspResponseMessage | LspNotificationMessage;

export type LspDefinitionResponse = LspLocation | readonly LspLocation[] | readonly LspLocationLink[] | null;
export type LspReferencesResponse = readonly LspLocation[] | null;
export type LspHoverResponse = LspHover | null;
