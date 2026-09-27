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
      
revision: 60e70d6896fce2a853b5a66abeba2b577029053e
updated_at: "2026-09-27T10:55:36.275Z"
fingerprint: 1be686a27ccd361c376f14604c61852dc0ed253f2693423b047c451793ed96e1
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
