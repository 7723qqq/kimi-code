---
name: kimi-datasource
description: |
  Universal data-source assistant. Use this skill when the user wants external structured data such as stocks, financial reports, technical indicators, A-share/HK/US markets, global macroeconomics, Chinese enterprise registry information, arXiv papers, Google Scholar results, Chinese laws/regulations and judicial cases, Wind financial data (intraday/minute quotes, funds, bonds), IMF macro datasets (FX rates, CPI, GDP forecasts), Gildata smart screening, US SEC filings (10-K/10-Q, Form 4, 13F), or S&P Capital IQ fundamentals (top holders, consensus estimates, valuation ratios).
  This plugin exposes tools via MCP server `plugin-kimi-datasource_data`; call them in the flow `mcp__plugin-kimi-datasource_data__get_data_source_desc` → `mcp__plugin-kimi-datasource_data__call_data_source_tool`.
---

# kimi-datasource — Universal Data Source Assistant

## 0. How to call

This skill uses the two tools registered by the datasource MCP server; do not run scripts manually via Bash:

- `mcp__plugin-kimi-datasource_data__get_data_source_desc`
- `mcp__plugin-kimi-datasource_data__call_data_source_tool`

These two tools are executed by Kimi Code; pass parameters as JSON directly per the tool schema.

The tools read the local OAuth login credentials for the current Kimi Code environment; when `KIMI_CODE_OAUTH_HOST` / `KIMI_CODE_BASE_URL` are set, they use the isolated credentials of that environment. If there are no login credentials, ask the user to run `/login` in Kimi Code first.

## 1. What this skill provides

This plugin connects to 12 external data sources. The "data source name" in each row is the `name` passed to `get_data_source_desc`.

| Capability | Data source name | Typical questions |
|---|---|---|
| **A-share / HK / US market quotes and financials** | `stock_finance_data` | "What's the current price of Moutai", "CATL's 2024 financial report", "Tencent shareholders", "AI stocks in Hangzhou" |
| **Yahoo Finance global finance** | `yahoo_finance` | "Apple analyst ratings", "AAPL options chain", "Apple's top 10 institutional shareholders" |
| **World Bank historical macro** | `world_bank_open_data` | "China's GDP over the years", "India's inflation rate", "population growth comparison across countries" |
| **Chinese enterprise registry info** | `tianyancha` | "ByteDance shareholders", "BYD legal risks", "CATL patents" |
| **arXiv paper preprints** | `arxiv` | "Find RAG surveys", "Download 2406.xxxxx" |
| **Google Scholar academic search** | `scholar` | "Hinton's latest papers", "highly-cited transformer survey papers" |
| **Chinese laws/regulations and judicial cases** | `yuandian_law` | "Civil Code provisions on residence rights", "Help me find the legal provisions on labor contract termination", "Find some unjust enrichment precedents" |
| **Wind (A-shares/funds/bonds/macro)** | `wind` | "Moutai's minute chart today", "10-year treasury yield trend", "Fund NAV lookup" |
| **IMF international macro (FX rates / CPI / forecasts)** | `imf` | "USD/CNY exchange rate", "GDP growth forecasts by country", "global inflation comparison" |
| **Gildata smart screening** | `gildata` | "Screen stocks with net profit growth over 30% and ROE above 15%", "Fund manager screening" |
| **US SEC filings** | `sec_edgar` | "Tesla 10-K annual report", "Apple 10-Q quarterly report", "Form 4 insider trading", "13F institutional holdings" |
| **S&P Capital IQ US fundamentals** | `sp_data` | "Apple analyst consensus estimates", "US stock valuation ratio comparison", "competitor relationships" |

### Source selection principles

1. **The user named a data source** → use that source directly.
2. **No source named** → pick the best match from the table above by capability; judge for yourself using the "capability boundary reference" below and the depth/scope of the user's question.
3. **Pick only one data source per simple query** — don't read other sources' descs in parallel. Once the chosen source returns successfully and covers the user's question, answer immediately; don't keep calling other APIs to fill in fields, reformat, or cross-validate. Only query a second source when the user explicitly asks for cross-source comparison.

### Capability boundary reference (objective facts to consider when selecting a source)

- `yahoo_finance` FX history covers at most 2 years; `imf` provides long-term FX rates, CPI, GDP forecasts, and balance-of-payments series
- `stock_finance_data` quotes are real-time/close snapshots; minute-level intraday series live in `wind` (which also has funds, bonds, and treasury yields)
- Shareholders / institutional holdings: `yahoo_finance`, `sec_edgar` (13F), and `sp_data` (S&P standardized holders) all cover this, with different scopes and depths
- `world_bank_open_data` provides 50+ years of historical macro series; use `imf` for IMF forecast values
- `gildata` takes natural-language conditions as input (stock screening / fund selection / fund manager screening); `tianyancha` is enterprise registry archives
- `wind`'s `indexes`/`indicators` parameters require native Wind field names; for common fields like PE/PB/ROE/market cap, first call `wind_search_fields` to map them (supports aliases and Chinese names, one lookup at a time) — don't guess field names

**Unsupported capabilities**: general web search / real-time news. If asked about these, tell the user the current data sources don't cover them.

## 2. Standard workflow: `get_data_source_desc` → `call_data_source_tool`

The backend APIs change frequently, so **this skill deliberately doesn't copy specific API names or parameter tables**. Before each call, ask the data source on the spot: "What interfaces do you have?"

```
1. Based on the user's question, pick exactly one data_source_name from the table above
2. Run get_data_source_desc and read that data source's Markdown doc
3. Read the returned Markdown carefully; it lists:
     - An overview of the data source (including ticker format, global constraints)
     - Each API's description / required params / optional params / defaults / value ranges
4. Pick the best-matching API and assemble params per the doc
5. Run call_data_source_tool once; stop calling once it succeeds and covers the question
6. Read the returned result and answer in the language the user asked in
```

### Example 1: the user asks "Moutai's trend over the past year"

1. Stock trend → `stock_finance_data`
2. Call `mcp__plugin-kimi-datasource_data__get_data_source_desc` with params `{"name":"stock_finance_data"}`

3. Find the "get historical prices" API in the doc and check what it needs: `ticker / start_date / end_date / file_path`, etc.
4. Verify with web_search → Moutai = `600519.SH`
5. Call `mcp__plugin-kimi-datasource_data__call_data_source_tool` with params like `{"data_source_name":"stock_finance_data","api_name":"<文档里写的 api>","params":{"ticker":"600519.SH","start_date":"...","end_date":"...","file_path":"/tmp/mao_1y.csv"}}`

### Example 2: the user asks "find a few surveys on retrieval augmented generation"

1. Paper search → `arxiv` (or `scholar`; arxiv is better for preprints, scholar has more complete citations)
2. Call `mcp__plugin-kimi-datasource_data__get_data_source_desc` with params `{"name":"arxiv"}`

3. Find the search-type API in the doc and check what it needs: `query / file_path / max_results`, etc.
4. Run `call_data_source_tool`

### Example 3: the user asks "who are ByteDance's shareholders"

1. Enterprise registry → `tianyancha`
2. Call `mcp__plugin-kimi-datasource_data__get_data_source_desc` with params `{"name":"tianyancha"}`

3. Note: tianyancha's APIs are dynamically registered; the doc will guide you to **first use a search-type interface to find the right API name, then call it**
4. **Must use the company's full registered name** (e.g. "北京字节跳动科技有限公司"), not an abbreviation. If you don't know the full name, look it up via the "company search" interface in the tianyancha doc first

## 3. Iron rules before calling

### 3.1 Always verify stock codes — never guess from memory

A-shares use `.SH/.SZ/.BJ`, HK stocks `.HK`, US stocks `.US`, etc. Users usually only give the Chinese name (e.g. "Moutai", "CATL", "Tencent") without the code.

**Before calling any stock-related API**, first use a networked tool such as `web_search` / `WebSearch` to confirm the correct code + suffix.

If the current environment has no networked tools, **ask the user to confirm the code** — don't guess. A wrong code makes the API silently return wrong or empty data.

### 3.2 Company queries must use the full registered name

`tianyancha` rejects abbreviations like "Tesla", "NetEase", or "Tencent"; you must provide the full name, e.g. "北京特斯拉销售有限公司". If you don't know the full name, call its company search API first.

### 3.3 Most APIs require `file_path`

Most data-source APIs write the full result as CSV to `file_path`. Omitting it returns `Missing required parameters: file_path`. If you don't know what to pass, use `/tmp/<场景>_<时间戳>.csv`.

### 3.4 Don't cram too many tickers into one call

`stock_finance_data`'s real-time interface supports at most 3 tickers and the historical interface at most 10. More than that gets truncated or errors out. Split into batches if you have more.

## 4. How to read the returned results

`call_data_source_tool`'s stdout usually contains two parts:

1. **`data_preview`**: CSV header + the first few rows (usually 1–3), enough to answer simple questions directly
2. **`CSV 数据已写入：/tmp/xxx.csv`**: the path where the full data was written

Strategy:
- For single-value questions like "what's XX's current price" or "what was China's 2023 GDP", `data_preview` is usually enough — answer directly
- If the user wants charts, comparisons, P&L, or lists → read the CSV with the `Read` tool and process it
- For mixed A-share + HK queries, the server automatically splits the CSV into `_a.csv` / `_hk.csv`; the original `file_path` file won't exist

If the API returns a failure, the message usually states the reason (bad params / unsupported / empty data, etc.). Relay the plain-language reason to the user; don't force a second attempt.

## 5. `watchlist.json` — the user's watchlist

`${KIMI_SKILL_DIR}/watchlist.json` is the user's watchlist. When the user asks to "check my watchlist", read this file, then follow the standard `get_data_source_desc("stock_finance_data") → call_data_source_tool` flow to fetch real-time quotes; the real-time interface handles at most 3 tickers per batch — split larger batches.

Format:

```json
[
  {"code": "600519.SH", "name": "贵州茅台"},
  {"code": "0700.HK", "name": "腾讯控股", "hold_cost": 350.5, "hold_quantity": 100}
]
```

- `code` and `name` are required; `hold_cost` and `hold_quantity` are optional
- When both are present, also compute P&L: `(current price - hold_cost) * hold_quantity`
- When the user says "add XX to my watchlist": first verify the code with web_search, then append it to the JSON array

## 6. Notes

- **Answer the user in the language they asked in**. If the user asks in Chinese, answer in Chinese; if in English, answer in English; if in another language, answer in that language.
- **Don't guess stock codes / company full names from memory**. A wrong code makes the API silently return wrong data the user won't notice
- **Don't pass `api_name` without reading the desc first**. The backend returns `API_NOT_FOUND`. Unless you've already read that data source's desc in this session and remember the params
- **Don't give investment advice**. After providing the data, just append "AI 生成，不构成投资建议"
- If an error from a data-source API is clearly a backend bug (contradictory parameter schemas, internal Python errors, etc.), **report the error to the user and don't force it** — such bugs can't be fixed on our side; the backend service must fix them
