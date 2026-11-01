List the paths tracked by git in this repository, as recorded at HEAD.

Use it to learn the shape of a repository or a subtree in one call: which packages, directories and files exist, and where they live. The output is the raw git path list, so it reflects the committed tree rather than untracked or ignored files in the working directory.

- Omit `path` for the whole repository, or pass a directory or file prefix to narrow the listing. Give `path` relative to the repository root (for example `packages/agent-core-v2`); when nothing matches there, it is also tried relative to the working directory.
- `depth` limits how deep the listing goes below `path`: depth 1 returns the direct children of `path`, depth 2 their children, and so on. The default is 3.
- The output is capped. When it is, the last line says how many paths were left out — narrow `path` or raise `depth` to see them.
