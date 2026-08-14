# lsp — semantic navigation over a language server

Runs a Language Server Protocol operation at a position in a file and returns
the result as text. Use it when you need semantic information that text
search cannot give you: the definition of a symbol, every reference to it,
implementations of an interface member, or hover documentation.

Four operations:

- `goToDefinition` — the definition of the symbol at the position.
- `findReferences` — every reference to the symbol at the position.
- `goToImplementation` — implementations of an interface or abstract member.
- `hover` — type information and documentation at the position.

Positions are one-based: line 1 is the first line, character 1 is the first
UTF-16 code unit of the line. The file must be inside the session workspace.

Requires a language server configured for the file's extension in the `[lsp]`
config section (e.g. `servers.typescript = { command = "typescript-language-server", args = ["--stdio"], extensionToLanguage = { ts = "typescript" } }`). When no server covers the extension, the tool reports an error explaining how to configure one.
