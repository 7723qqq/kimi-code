---
uid: e1e00008
id: kimi-code.engine.tools.web
parent: kimi-code.engine.tools
name: {zh: "网络与抓取", en: "Web & fetch"}
description:
  zh: >
      注册工具名：WebSearch、FetchURL、SwitchSearchEngine、NotifyUser 与 GitHub* 族。
      
  en: >
      Registered tool names: WebSearch, FetchURL, SwitchSearchEngine, NotifyUser and the GitHub* family.
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:39.002Z"
fingerprint: 245b2e86b4d360766bc8c236ed9e710abbc840d6b34d6d94b85fa36898ed94cc
source:
  - path: "packages/kimi-agent/src/tools/web_search.rs"
  - path: "packages/kimi-agent/src/tools/fetch_url.rs"
  - path: "packages/kimi-agent/src/tools/github.rs"
  - path: "packages/kimi-agent/src/tools/read_media.rs"
apis:
  - protocol: rpc
    path: "WebSearch"
    description:
      zh: >
          搜索网页
          
      en: >
          Search the web
          
  - protocol: rpc
    path: "FetchURL"
    description:
      zh: >
          抓取 URL 为 markdown
          
      en: >
          Fetch a URL as markdown
          
  - protocol: rpc
    path: "SwitchSearchEngine"
    description:
      zh: >
          切换搜索引擎
          
      en: >
          Switch the search engine
          
  - protocol: rpc
    path: "GitHubGetPR"
    description:
      zh: >
          GitHub API 操作
          
      en: >
          GitHub API operations
          
---
