# WorkBuddy 专家全量 Agent 目录

由 `scripts/workbuddy-experts/import-all.mjs` 生成，覆盖 WorkBuddy 5.11.3 专家中心的全部清单条目。

## 总览

| 指标 | 数量 |
|---|---:|
| 清单专家（含专家团） | 448 |
| 已生成 Agent 的专家 | 252 |
| 生成的 Agent 文件 | 439 |
| 不完整（部分成员缺失） | 1 |
| 受限（无公开提示词） | 199 |
| 本地额外专家 | 3 |

## 分类

| 分类 | 总数 | 已生成 | 部分 | 受限 |
|---|---:|---:|---:|---:|
| 腾讯专区 (`13-TencentZone`) | 37 | 19 | 0 | 18 |
| 产品设计 (`01-ProductDesign`) | 20 | 17 | 0 | 3 |
| 开学季 (`15-BackToSchool`) | 11 | 0 | 0 | 11 |
| 技术工程 (`02-Engineering`) | 45 | 29 | 0 | 16 |
| 金融投资 (`08-FinanceInvestment`) | 39 | 23 | 0 | 16 |
| 游戏空间 (`03-GameSpatial`) | 25 | 24 | 0 | 1 |
| 数据智能 (`04-DataAI`) | 44 | 21 | 0 | 23 |
| 营销增长 (`05-MarketingGrowth`) | 37 | 29 | 0 | 8 |
| 内容创作 (`06-ContentCreative`) | 48 | 26 | 1 | 21 |
| 销售商务 (`07-SalesCommerce`) | 17 | 10 | 0 | 7 |
| 运营人力 (`09-OperationsHR`) | 17 | 7 | 0 | 10 |
| 项目质量 (`10-ProjectQuality`) | 25 | 23 | 0 | 2 |
| 法务安全 (`11-SecurityCompliance`) | 27 | 14 | 0 | 13 |
| 行业顾问 (`12-IndustryConsultant`) | 35 | 6 | 0 | 29 |
| 全球发展 (`14-GlobalDevelopment`) | 21 | 0 | 0 | 21 |
| 本地安装 (`local-installed`) | 3 | 3 | 0 | 0 |

## 专家明细

### 腾讯专区（37）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 小益 | `TencentCharityExpert` | 单专家 | 完整 | [wb-tencent-charity-expert](./agents/wb-tencent-charity-expert.md) | 精通公益行业产品和技术解决方案的腾讯技术公益智能化专家 |
| CloudQ | `MultiCloudManagementExpert` | 单专家 | 完整 | [wb-multi-cloud-management-expert](./agents/wb-multi-cloud-management-expert.md) | 精通腾讯云、阿里云、AWS等多云架构治理、可视化、智能巡检与成本优化，一个专家管理所有云。 |
| 腾讯云技术支持 | `CloudOpsTeam` | 专家团 | 完整 | [wb-cloud-ops-team-lead](./agents/wb-cloud-ops-team-lead.md)、[wb-cloud-ops-team-cloud-q](./agents/wb-cloud-ops-team-cloud-q.md)、[wb-cloud-ops-team-andon-q](./agents/wb-cloud-ops-team-andon-q.md) 等 4 个 | 三位专家组成的运维团队 — CloudQ 负责多云统一治理与架构可视化，AndonQ 负责工单管理与智能问答，MigraQ 负责跨云迁移规划与 TCO 分析。… |
| AndonQ | `AndonQExpert` | 单专家 | 完整 | [wb-andon-q-expert](./agents/wb-andon-q-expert.md) | 精通腾讯云全线产品，提供产品咨询、故障排查、服务报告等多维度服务的技术专家。 |
| 云鼎安全专家 | `TencentSecurityExpert` | 单专家 | 完整 | [wb-tencent-security-expert](./agents/wb-tencent-security-expert.md) | 深耕安全领域多年，提供威胁建模、漏洞评估、安全代码审查、架构设计、事件响应、安全咨询等服务 |
| 安迪 | `APMPerformanceExpert` | 单专家 | 完整 | [wb-apm-performance-expert](./agents/wb-apm-performance-expert.md) | 精通腾讯云 APM 性能诊断与调优，快速定位应用瓶颈并给出优化方案 |
| 小益 | `CharityDocFinanceExpert` | 单专家 | 完整 | [wb-charity-doc-finance-expert](./agents/wb-charity-doc-finance-expert.md) | 公益机构文书与财务一站式专家，覆盖项目申请书、结项报告、票据管理、审计准备与合规咨询，帮助公益人从繁琐行政中解放。 |
| CloudQ | `CapacityExpert` | 单专家 | 完整 | [wb-capacity-expert](./agents/wb-capacity-expert.md) | 容量规划专家。擅长水位监控、容量预测与弹性伸缩策略制定，防止资源瓶颈与浪费。 |
| CloudQ | `ChaosExpert` | 单专家 | 完整 | [wb-chaos-expert](./agents/wb-chaos-expert.md) | 混沌演练专家。擅长故障注入演练、韧性验证与熔断策略评估，提升系统抗脆弱能力。 |
| CloudQ | `FinopsExpert` | 单专家 | 完整 | [wb-finops-expert](./agents/wb-finops-expert.md) | 云成本治理专家。擅长账单分析、闲置资源识别、计费模式优化与成本分摊，驱动降本增效决策。 |
| CloudQ | `InspectionExpert` | 单专家 | 完整 | [wb-inspection-expert](./agents/wb-inspection-expert.md) | 云资源巡检专家。覆盖五维巡检（安全、性能、可靠性、成本、合规）、高危风险扫描与优先级处置、巡检趋势分析与可视化报告生成，主动发现潜在隐患，防患于未然。 |
| CloudQ | `SreExpert` | 单专家 | 完整 | [wb-sre-expert](./agents/wb-sre-expert.md) | 站点可靠性专家。擅长故障根因推理、告警关联分析、业务进程诊断与 SLO 治理，通过系统化诊断方法论保障服务持续稳定运行。 |
| CloudQ | `WellArchExpert` | 单专家 | 完整 | [wb-well-arch-expert](./agents/wb-well-arch-expert.md) | 卓越架构专家。擅长架构可视化评估、资源拓扑梳理、Well-Architected 六支柱评估与架构风险识别，确保架构符合最佳实践。 |
| 腾讯云行业 SRE | `IndustrySreTeam` | 专家团 | 完整 | [wb-industry-sre-team-lead](./agents/wb-industry-sre-team-lead.md)、[wb-industry-sre-team-game-sre](./agents/wb-industry-sre-team-game-sre.md)、[wb-industry-sre-team-retail-sre](./agents/wb-industry-sre-team-retail-sre.md) 等 13 个 | 12 位行业 SRE 覆盖游戏、金融、电商等场景，做五维巡检，输出可对照可执行的架构治理建议。 |
| CloudQ | `TencentRtcExpert` | 单专家 | 完整 | [wb-tencent-rtc-expert](./agents/wb-tencent-rtc-expert.md) | TRTC 技术支持专家：通话用量与质量查询、单次通话诊断、云端巡检解读、故障排查与友商代码迁移。 |
| 天御金融反诈 | `AntiScamAgent` | 单专家 | 受限 | — | 金融黑灰产情报驱动的反诈智能体，覆盖电诈、职业背债、贷款包装、反催收，能分析、能查证、能出研判报告。 |
| 天御营销保护 | `TianyuMarketingGuardian` | 单专家 | 受限 | — | 替您守护每一场营销活动，在文旅、零售、Token、医疗挂号等场景自动盯活动、查漏召、调策略护预算。 |
| 天御账号保护 | `TianyuAccountGuardian` | 单专家 | 受限 | — | 替您盯住注册、登录、裂变全链路账号异常，实时调优策略拦截恶意账号，并生成客诉原因分析报告。 |
| 腾讯云上云迁移专家团 | `MigraqTeam` | 专家团 | 完整 | [wb-migraq-team-lead](./agents/wb-migraq-team-lead.md)、[wb-migraq-team-product-expert](./agents/wb-migraq-team-product-expert.md)、[wb-migraq-team-landing-zone-expert](./agents/wb-migraq-team-landing-zone-expert.md) 等 7 个 | 7位专家协作完成上云迁移：产品选型、Landing Zone、架构设计、交付实施、运维与FDE部署 |
| DataBrain | `DatabrainAgentV2` | 单专家 | 受限 | — | 覆盖经分取数、三方市场情报、舆情情感分析、归因下钻及跨游戏竞品对比，提供有数据支撑的专业洞察与建议。 |
| CloudQ | `MultiCloudExpert` | 单专家 | 完整 | [wb-multi-cloud-expert](./agents/wb-multi-cloud-expert.md) | 统一管理腾讯云、阿里云、AWS、Azure、GCP 等多云平台，一个智能体即可管多云。 |
| 腾讯云安全运营专家 | `Soe` | 单专家 | 受限 | — | 分析WAF、主机安全、云防火墙、SOC、御界、天幕告警事件，覆盖漏洞、攻击、入侵溯源与iOA排障。 |
| 腾讯健康药箱-私域患教内容审核助手 | `PatientEducationContentReviewWordAssistant` | 单专家 | 受限 | — | 六维度审核患教内容并核对数据文献一致性，审核意见以 Word 批注+高亮直接标注在原文上输出。 |
| CloudQ | `SdkLogExpert` | 单专家 | 受限 | — | 解码客户端日志，还原 TRTC/IM/TUI 时间线，定位音视频与 IM 相关根因 |
| 腾讯云报价助手 | `TencentCloudQuoteAssistant` | 单专家 | 受限 | — | 面向销售与方案团队的腾讯云报价助手，支持产品咨询选型、实时刊例价查询比较、批量采购报价、友商 Mapping 与折扣推荐。 |
| HR数智专家 | `HrDigitalExpert` | 单专家 | 受限 | — | 覆盖HR数仓查询、页面设计开发、一键部署上线和本地知识库管理的全链路HR数智专家 |
| 腾讯云刊例价查询助手 | `TencentCloudPriceExpert` | 单专家 | 完整 | [wb-tencent-cloud-price-expert](./agents/wb-tencent-cloud-price-expert.md) | 腾讯云销售刊例价查询助手。支持产品咨询、单产品/批量询价、图片配置识别，价格来自实时 API。 |
| 贝安 | `AbExperimentAnalyst` | 单专家 | 受限 | — | 聚焦TAB外分析：新指标构建、维度下钻与Bonferroni校正、TAB指标查看 |
| 绩效管理专家 | `PerfManagementExpert` | 单专家 | 受限 | — | 管理者的绩效管理私人顾问，帮你应对目标制定、绩效辅导、绩效反馈等真实困境，提供针对性建议、AI角色扮演陪练和能力测评，形成系统提升闭环 |
| MigraQ | `Migraq` | 单专家 | 完整 | [wb-migraq](./agents/wb-migraq.md) | 腾讯云迁移服务专家，支持阿里云、AWS、华为云等多云资源扫描、规格对标、TCO成本分析与迁移方案规划 |
| 阿拉丁 | `AladinTestDesign` | 单专家 | 受限 | — | 根据需求内容或TAPD链接，自动分析需求并生成结构化功能测试用例，以HTML报告或表格输出。 |
| CPQ 报价专家 | `Cpq` | 单专家 | 受限 | — | 基于多源数据生成腾讯云报价及磐石CPQ配置单，覆盖选品、询价、折扣配置与方案交付全流程。 |
| 流通通 | `WorkflowAssistant` | 单专家 | 受限 | — | 汇金一站式流程编排专家，覆盖流程设计、流程单操作（查询/审批/撤单/导出），智能识别用户意图，精准推送链接。 |
| 觅诊 | `MiZhenExpert` | 单专家 | 受限 | — | 面向医疗健康咨询场景，透传用户原始问题给觅诊服务，原样返回专业回复，减少转述偏差，适合就医用药咨询。 |
| 哈勃AI评测专家 | `HubbleEvalExpert` | 单专家 | 受限 | — | 用 Hubble CLI 全程管理 AI 评测：数据集、任务、报告与模板，让 AI 评估更高效。 |
| 小T HR智能助手 | `Xiaot` | 单专家 | 受限 | — | 小T，你的HR智能服务助手，涉及HR政策、流程和业务办理事项，都可以直接告诉我，我会尽快帮你找到答案。 |
| MigraQ | `MigraQExpert` | 单专家 | 受限 | — | 腾讯云迁移服务专家，支持阿里云、AWS、华为云等多云资源扫描、规格对标、TCO成本分析与迁移方案规划 |

### 产品设计（20）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 产品通 | `ProductManagementExpert` | 单专家 | 完整 | [wb-product-management-expert](./agents/wb-product-management-expert.md) | 产品管理工具集：功能规格编写、路线图规划、利益相关者沟通、用户研究综合、竞品分析和指标追踪 |
| 像素君 | `UiDesigner` | 单专家 | 完整 | [wb-ui-designer](./agents/wb-ui-designer.md) | 精通设计系统和组件库，追求像素级完美，打造无障碍用户界面 |
| 画令令 | `AiImagePromptEngineer` | 单专家 | 完整 | [wb-ai-image-prompt-engineer](./agents/wb-ai-image-prompt-engineer.md) | 精通AI图像生成的语言密码，将抽象视觉概念转化为精准提示词 |
| 体验达 | `UserExperienceArchitect` | 单专家 | 完整 | [wb-user-experience-architect](./agents/wb-user-experience-architect.md) | 为开发者提供坚实的技术基础和CSS系统，是设计与开发之间的桥梁 |
| 图说说 | `VisualStorytellingExpert` | 单专家 | 完整 | [wb-visual-storytelling-expert](./agents/wb-visual-storytelling-expert.md) | 擅长将复杂信息转化为引人入胜的视觉故事 |
| 探真真 | `UserExperienceResearcher` | 单专家 | 完整 | [wb-user-experience-researcher](./agents/wb-user-experience-researcher.md) | 用真实数据而非假设验证设计决策，专精用户行为分析和可用性测试 |
| 排序序 | `SprintPriorityManager` | 单专家 | 完整 | [wb-sprint-priority-manager](./agents/wb-sprint-priority-manager.md) | 在有限迭代周期内做出最优优先级决策，确保Sprint交付最大价值 |
| 听声声 | `FeedbackSynthesisAnalyst` | 单专家 | 完整 | [wb-feedback-synthesis-analyst](./agents/wb-feedback-synthesis-analyst.md) | 从海量用户反馈中提炼有价值洞察，将用户声音转化为改进方向 |
| 惊喜喜 | `DelightfulExperienceDesigner` | 单专家 | 完整 | [wb-delightful-experience-designer](./agents/wb-delightful-experience-designer.md) | 专注于在品牌体验中注入意想不到的愉悦时刻 |
| 助推推 | `BehavioralNudgeEngine` | 单专家 | 完整 | [wb-behavioral-nudge-engine](./agents/wb-behavioral-nudge-engine.md) | 运用行为经济学设计产品助推机制，引导用户做出更好的决策 |
| 多元元 | `DiversityVisualExpert` | 单专家 | 完整 | [wb-diversity-visual-expert](./agents/wb-diversity-visual-expert.md) | 致力于消除AI图像中的系统性偏见，确保视觉内容文化准确和包容 |
| 林觉初 | `AdortDesignExpert` | 单专家 | 完整 | [wb-adort-design-expert](./agents/wb-adort-design-expert.md) | 精通 Ardot 设计软件，既能在画布上构建精准 UI，也能将设计稿直接生成前端代码 |
| 规范范 | `DesignMdArchitect` | 单专家 | 完整 | [wb-design-md-architect](./agents/wb-design-md-architect.md) | 基于58个品牌参考库，生成设计系统规范文档并直接输出高质量HTML/CSS页面与UI组件代码 |
| 图变码 | `DesignToCodeExpert` | 单专家 | 完整 | [wb-design-to-code-expert](./agents/wb-design-to-code-expert.md) | 将 Figma 设计稿和截图转换为可直接使用的代码组件，内置无障碍性支持 |
| 产品战略团队 | `ProductStrategyTeam` | 专家团 | 完整 | [wb-product-strategy-team-lead](./agents/wb-product-strategy-team-lead.md)、[wb-product-strategy-team-requirement-analyst](./agents/wb-product-strategy-team-requirement-analyst.md)、[wb-product-strategy-team-user-researcher](./agents/wb-product-strategy-team-user-researcher.md) 等 6 个 | 由产品总监领导的 5 人产品专家团队：需求分析师（PRD/功能规格书）、用户研究员（调研综合分析）、竞品分析师（竞争情报）、数据分析师（指标追踪）和路线图规划… |
| 设计原型专家团 | `DesignEngineTeam` | 专家团 | 完整 | [wb-design-engine-team-lead](./agents/wb-design-engine-team-lead.md)、[wb-design-engine-team-evidence-exchange-analyst](./agents/wb-design-engine-team-evidence-exchange-analyst.md)、[wb-design-engine-team-design-system-expert](./agents/wb-design-engine-team-design-system-expert.md) 等 6 个 | 6 角色 AI 设计团队，覆盖从需求发现到品牌级原型交付的完整工作流，内置 71 套设计系统 |
| 绘灵 | `MermaidDiagramExpert` | 单专家 | 完整 | [wb-mermaid-diagram-expert](./agents/wb-mermaid-diagram-expert.md) | 将自然语言转化为专业级Mermaid图表，支持6种图表类型、15种主题配色，秒级渲染出版级SVG与ASCII可视化 |
| 小花创意 | `DesignPrototypeExpert` | 单专家 | 受限 | — | 设计系统驱动的高保真原型专家。先建规范再出页面，提供多方向选择，交付前做AI味检测。 |
| 卡仔 | `NgoChallengeAdvisor` | 单专家 | 受限 | — | 通過點擊式訪談梳理 NGO 真實工作痛點，生成清晰可執行的共創卡，並在發佈前完成適配、邊界與質量檢查。 |
| 甄需明 | `CloudRequirementExpert` | 单专家 | 受限 | — | 专注云产品需求的智能生成、结构化补全、AI读层生成与需求拆分，完整覆盖从想法到交付的全流程管理。 |

### 开学季（11）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 技能匠人 | `SkillSmith` | 单专家 | 受限 | — | 陪制作者把重复工作流做成可用的 Skill：挖掘场景、确认需求、生成制作、实测验证、按标准审查打分。 |
| 社交搭子 | `CampusConversationCoach` | 单专家 | 受限 | — | 帮助学生在破冰、面试和校园冲突中，通过递进情景、证据反馈与迁移练习提升自然表达和边界沟通能力。 |
| 活动操盘手 | `CampusEventNavigator` | 单专家 | 受限 | — | 把校园活动从模糊想法推进为可执行方案，覆盖分工、预算、宣传、现场流程、应急预案与数据复盘。 |
| 求职冲刺 | `CampusJobSearchCoach` | 单专家 | 受限 | — | 面向校园求职，支持真实经历梳理、应届简历成稿、岗位定制、面试训练、求职沟通与Offer决策。 |
| 生涯领航员 | `CareerNavigator` | 单专家 | 受限 | — | 帮助大学生梳理兴趣、能力、价值观与现实约束，对比专业和发展路径，用低成本行动验证方向并形成阶段计划。 |
| 小修同学 | `ComputerOperationsAdvisor` | 单专家 | 受限 | — | 面向大学生提供电脑上手、安全装软件、流氓广告防护、校园网络、外设连接与常见故障的分步指导 |
| Evan老师 | `EnglishWritingCoach` | 单专家 | 受限 | — | 面向大学生诊断英语薄弱项，训练阅读、词汇、语法、翻译与写作，并按考试目标逐轮反馈和复盘。 |
| 备考军师 | `ExamPreparationPlanner` | 单专家 | 受限 | — | 为在校生制定贴合考试范围、剩余时间和掌握情况的复习计划，通过每日打卡、薄弱点复盘和滚动调整推进备考。 |
| 小记同学 | `NoteClassRepresentative` | 单专家 | 受限 | — | 对齐课堂速记、课件与转写稿，区分来源、加工和核验状态，生成可追踪纠错、可直接复习的笔记与卡片。 |
| 学运趋势解读师 | `StudyFortuneCompass` | 单专家 | 受限 | — | 一数起卦，循本卦、互卦与变卦解析学习趋势与盲区，并结合现实信息给出可验证的观察和行动方向。 |
| 论小舟 | `ThesisWritingMentor` | 单专家 | 受限 | — | 基于可核验材料辅助论文结构、学术润色、期刊匹配与审稿回复，以证据状态和提交就绪度控制质量。 |

### 技术工程（45）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 吴八哥 | `SeniorDeveloper` | 单专家 | 完整 | [wb-senior-developer](./agents/wb-senior-developer.md) | 10年以上全栈经验，精通多种语言和框架，以严谨的工程纪律交付可运行的高质量代码 |
| 火眼眼 | `CodeReviewExpert` | 单专家 | 完整 | [wb-code-review-expert](./agents/wb-code-review-expert.md) | 以鹰眼标准检查每行代码，在缺陷到达生产环境之前将其拦截 |
| 架构通 | `SoftwareArchitect` | 单专家 | 完整 | [wb-software-architect](./agents/wb-software-architect.md) | 站在全局高度设计可扩展高可用的软件架构，为技术团队指明方向 |
| 磐石石 | `BackendArchitect` | 单专家 | 完整 | [wb-backend-architect](./agents/wb-backend-architect.md) | 深耕分布式系统和高并发架构，擅长将复杂业务转化为优雅技术方案 |
| 像素匠 | `FrontendDeveloper` | 单专家 | 完整 | [wb-frontend-developer](./agents/wb-frontend-developer.md) | 精通现代Web技术和主流框架，以像素级精度构建响应式高性能Web应用 |
| 软件开发团队 | `SoftwareCompany` | 专家团 | 完整 | [wb-software-company-lead](./agents/wb-software-company-lead.md)、[wb-software-company-product-manager](./agents/wb-software-company-product-manager.md)、[wb-software-company-architect](./agents/wb-software-company-architect.md) 等 5 个 | 高效软件研发团队，产品经理定需求、架构师设计+拆任务、工程师批量实现代码、QA验证质量，小需求支持快速模式 |
| 掌中灵 | `MobileApplicationDeveloper` | 单专家 | 完整 | [wb-mobile-application-developer](./agents/wb-mobile-application-developer.md) | 精通iOS和Android原生及跨平台开发，打造流畅美观的移动应用 |
| 小程达 | `WeChatMiniProgramDeveloper` | 单专家 | 完整 | [wb-we-chat-mini-program-developer](./agents/wb-we-chat-mini-program-developer.md) | 精通微信小程序开发框架和生态，打造流畅微信原生体验应用 |
| 盾甲甲 | `SecurityEngineer` | 单专家 | 完整 | [wb-security-engineer](./agents/wb-security-engineer.md) | 全方位保障系统安全，在黑客之前发现并修复安全漏洞 |
| 一键达 | `DevOpsAutomationEngineer` | 单专家 | 完整 | [wb-dev-ops-automation-engineer](./agents/wb-dev-ops-automation-engineer.md) | 将一切手动运维自动化，从CI/CD到基础设施即代码，部署一键搞定 |
| 闪造造 | `RapidPrototypingEngineer` | 单专家 | 完整 | [wb-rapid-prototyping-engineer](./agents/wb-rapid-prototyping-engineer.md) | 以极快速度将创意转化为可工作的原型，让团队快速验证想法 |
| 分支通 | `GitWorkflowExpert` | 单专家 | 完整 | [wb-git-workflow-expert](./agents/wb-git-workflow-expert.md) | 精通Git高级工作流和分支策略，让团队协作像行云流水般顺畅 |
| 稳如山 | `SiteReliabilityEngineer` | 单专家 | 完整 | [wb-site-reliability-engineer](./agents/wb-site-reliability-engineer.md) | 用软件工程方法论解决运维问题，确保99.99%可用性 |
| 救火队 | `IncidentResponseCommander` | 单专家 | 完整 | [wb-incident-response-commander](./agents/wb-incident-response-commander.md) | 系统故障时冷静指挥团队快速定位处理和恢复，是终极救火队长 |
| 运维通 | `InfrastructureOperationsExpert` | 单专家 | 完整 | [wb-infrastructure-operations-expert](./agents/wb-infrastructure-operations-expert.md) | 确保IT基础设施的持续稳定运行，一切尽在掌控 |
| 协议通 | `McpBuildExpert` | 单专家 | 完整 | [wb-mcp-build-expert](./agents/wb-mcp-build-expert.md) | 精通Model Context Protocol设计实现 |
| 猎威威 | `ThreatDetectionEngineer` | 单专家 | 完整 | [wb-threat-detection-engineer](./agents/wb-threat-detection-engineer.md) | 专精构建威胁检测系统，在攻击者造成损害前发现拦截威胁 |
| 固件通 | `EmbeddedFirmwareEngineer` | 单专家 | 完整 | [wb-embedded-firmware-engineer](./agents/wb-embedded-firmware-engineer.md) | 精通微控制器编程，在资源受限的硬件上编写高效可靠的固件代码 |
| 索引引 | `LspIndexEngineer` | 单专家 | 完整 | [wb-lsp-index-engineer](./agents/wb-lsp-index-engineer.md) | 精通语言服务器协议和代码索引技术 |
| 链合约 | `SoliditySmartContractEngineer` | 单专家 | 完整 | [wb-solidity-smart-contract-engineer](./agents/wb-solidity-smart-contract-engineer.md) | 精通Solidity和EVM生态，编写安全高效的智能合约 |
| 终端通 | `TerminalIntegrationExpert` | 单专家 | 完整 | [wb-terminal-integration-expert](./agents/wb-terminal-integration-expert.md) | 精通终端应用与空间计算环境的集成 |
| 亚伦 | `CATNetworkQualityAnalyst` | 单专家 | 完整 | [wb-cat-network-quality-analyst](./agents/wb-cat-network-quality-analyst.md) | 精通错误分析、性能分析、整体分析、抓包分析、多任务对比分析，自动生成专业分析报告 |
| 速构构 | `ModernWebappExpert` | 单专家 | 完整 | [wb-modern-webapp-expert](./agents/wb-modern-webapp-expert.md) | 现代 Web 应用开发专家，基于 React + TypeScript + Vite + Tailwind CSS + shadcn/ui 技术栈，含浏览器自… |
| 容器器 | `DockerfileGenExpert` | 单专家 | 完整 | [wb-dockerfile-gen-expert](./agents/wb-dockerfile-gen-expert.md) | Dockerfile 自动生成专家，遵循容器化最佳实践 |
| 工程保障团队 | `EngineeringAssuranceTeam` | 专家团 | 完整 | [wb-engineering-assurance-team-lead](./agents/wb-engineering-assurance-team-lead.md)、[wb-engineering-assurance-team-code-reviewer](./agents/wb-engineering-assurance-team-code-reviewer.md)、[wb-engineering-assurance-team-architect](./agents/wb-engineering-assurance-team-architect.md) 等 6 个 | 由工程总监领导的 5 人工程专家团队：代码审查师（安全/性能/正确性）、架构师（系统设计/ADR）、SRE 工程师（事故响应/部署）、测试专家（测试策略/覆盖… |
| 软件工坊 | `SoftwareWorkshop` | 专家团 | 完整 | [wb-software-workshop-lead](./agents/wb-software-workshop-lead.md)、[wb-software-workshop-product-reviewer](./agents/wb-software-workshop-product-reviewer.md)、[wb-software-workshop-security-officer](./agents/wb-software-workshop-security-officer.md) 等 6 个 | 6位工程专业角色：产品评审、代码审查、安全审计、QA测试、设计系统、调试运维，覆盖从想法到生产的完整软件生命周期 |
| 腾讯云 RUM 全链路专家团 | `RumFullstackTeam` | 专家团 | 完整 | [wb-rum-fullstack-team-lead](./agents/wb-rum-fullstack-team-lead.md)、[wb-rum-fullstack-team-integration-specialist](./agents/wb-rum-fullstack-team-integration-specialist.md)、[wb-rum-fullstack-team-performance-analyst](./agents/wb-rum-fullstack-team-performance-analyst.md) | 腾讯云 RUM 全链路服务：10 大平台 aegis SDK 接入 + WebVitals/异常/接口/资源分析，支持 RUM-APM 联动 |
| 工序达 | `EngineeringWorkflowSkills` | 单专家 | 完整 | [wb-engineering-workflow-skills](./agents/wb-engineering-workflow-skills.md) | 基于Google 工程师的《Agent Skills》打造的资深工程全流程教练：规约驱动、测试驱动、代码评审、CI/CD发布 |
| 计算机等级考试专家团 | `NcreExpert` | 专家团 | 受限 | — | NCRE一至四级专家团，覆盖Office、编程、数据库与网络安全，分工协作，量身定制备考方案。 |
| MVP开发专家团 | `MvpDevExpertTeam` | 专家团 | 受限 | — | 说出你的想法，8位专家从调研、设计、编码、测试到部署全流程协作，帮你快速开发MVP产品 |
| 腾讯云API专家 | `TencentcloudApi` | 单专家 | 受限 | — | 自然语言管理腾讯云200+产品资源，智能检索API并构造CLI命令，内置安全管控与异常处理 |
| Makers 开发专家团 | `EdgeoneMakersExperts` | 专家团 | 受限 | — | 在 EdgeOne Makers 上构建并部署 Web 应用 —— 涵盖前端、Serverless 后端、AI Agent 开发及快速部署到全球加速网络 |
| 鹏城信息AI专家 | `ApiDev` | 单专家 | 受限 | — | 专注接口全生命周期开发，涵盖端点搭建、自动化测试、OpenAPI文档生成、Mock服务搭建与HTTP请求问题调试，提升开发效率。 |
| 鹏城信息AI专家 | `DevPipelineOrchestrator` | 单专家 | 受限 | — | 编排开发流水线：澄清需求意图，拆解为测试驱动的细粒度任务，子代理逐任务实现并双重评审，最终集成分支。 |
| 鹏城信息AI专家 | `Eno` | 单专家 | 受限 | — | 深度分析前端项目架构、技术栈选型、组件设计与构建配置，输出含评分等级、优势短板和重构优先级的结构化评审报告。 |
| AI编程方法论专家 | `SuperpowersZh` | 单专家 | 受限 | — | 二十项AI编程方法论，覆盖头脑风暴、测试驱动开发、系统化调试、代码审查，适配中文文档与国内平台规范。 |
| 贝锐花生壳 | `HskDevopsExpert` | 单专家 | 受限 | — | 基于 HSK CLI 的 DevOps 专家，提供零配置公网预览、内网穿透、文件托管和项目部署能力 |
| 鹏城信息AI专家 | `Code` | 单专家 | 受限 | — | 提供规划执行验证测试全流程编码指导，将复杂需求拆解为可独立验证步骤，支持多任务跟踪与偏好记忆。 |
| 鹏城信息AI专家 | `Frontend` | 单专家 | 受限 | — | 精通响应式界面开发，遵循移动优先与可访问性，以鲜明排版与色彩构建落地页、仪表盘、表单等高保真界面。 |
| 鹏城信息AI专家 | `DatabaseOperations` | 单专家 | 受限 | — | 精通表结构设计、迁移与性能调优。先用执行计划分析慢查询，再构建复合索引、修复N+1问题、实施分区与缓存优化。 |
| 组小学 | `OmicsHpcExpert` | 单专家 | 受限 | — | 远程组学HPC一站式运维，管控节点、队列、存储全生命周期，适配SLURM/SGE调度，自然语言交互降低门槛 |
| 提示词工程师 | `PromptEngineer` | 单专家 | 受限 | — | 精通系统提示词架构、思维链与少样本设计，用测试数据驱动迭代，把提示词优化到模型稳定输出。 |
| Python 全栈工程师 | `PythonFullstackEngineer` | 单专家 | 受限 | — | 精通后端API、数据分析、AI工程与自动化爬虫，坚持类型安全与工程化，交付测试齐全的生产级全栈代码 |
| 小台 | `WorkspaceBuilder` | 单专家 | 完整 | [wb-workspace-builder](./agents/wb-workspace-builder.md) | 为不同人群定制专属数字工作台，覆盖学习备考、职场效率、自媒体创作、宝妈育儿、生活管理五大场景，PC/移动端双适配，一键部署即用 |
| AICoding 架构专家团 | `AicodingArchitectureExpertTeam` | 专家团 | 受限 | — | 面向复杂系统架构设计，协同完成资料摄入、调研、业务、系统、部署、安全与用户故事全流程交付。 |

### 金融投资（39）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 账清清 | `FinancialTracker` | 单专家 | 完整 | [wb-financial-tracker](./agents/wb-financial-tracker.md) | 精准追踪项目和业务的财务数据，确保每笔收支清晰透明 |
| 付清清 | `AccountsPayableAgent` | 单专家 | 完整 | [wb-accounts-payable-agent](./agents/wb-accounts-payable-agent.md) | 自动化处理应付账款流程，确保付款准确及时 |
| 交易分析团队 | `TradingAgentTeam` | 专家团 | 完整 | [wb-trading-agent-team-lead](./agents/wb-trading-agent-team-lead.md)、[wb-trading-agent-team-market-analyst](./agents/wb-trading-agent-team-market-analyst.md)、[wb-trading-agent-team-fundamentals-analyst](./agents/wb-trading-agent-team-fundamentals-analyst.md) 等 13 个 | 13位专业角色分5阶段协作完成投资分析：技术面、基本面、新闻面、情绪面数据采集 → 多空辩论 → 交易决策 → 三方风险评估 → 最终报告，输出 BUY/SE… |
| 记账账 | `FinanceAccountingExpert` | 单专家 | 完整 | [wb-finance-accounting-expert](./agents/wb-finance-accounting-expert.md) | 财务会计工具集：月末结账、日记账分录、账户核对、财务报表生成、差异分析和 SOX 审计支持 |
| 建模模 | `FinancialModelingExpert` | 单专家 | 完整 | [wb-financial-modeling-expert](./agents/wb-financial-modeling-expert.md) | 核心金融建模工具：DCF 估值、可比公司分析、LBO 模型、三张表模型、竞争格局分析和 PPT 质检 |
| 严估深 | `EquityResearchExpert` | 单专家 | 完整 | [wb-equity-research-expert](./agents/wb-equity-research-expert.md) | 全面的股票研究工具集：财报分析、首次覆盖报告、DCF与可比估值、多空推介、投资备忘录、事件情景分析、组合风险管理，覆盖完整买方卖方研究工作流 |
| 银拓远 | `InvestmentBankingExpert` | 单专家 | 完整 | [wb-investment-banking-expert](./agents/wb-investment-banking-expert.md) | 全能投资银行专家：交易材料制作、估值建模（Comps/DCF/LBO/三表）、资本市场融资、买方尽调分析、重组与回收瀑布、交易全流程执行 |
| 募资资 | `PrivateEquityExpert` | 单专家 | 完整 | [wb-private-equity-expert](./agents/wb-private-equity-expert.md) | 私募股权工具集：Deal Sourcing、项目筛选、尽调清单、IC Memo、单位经济学分析、回报分析、投后管理和价值创造方案 |
| 理财财 | `WealthManagementExpert` | 单专家 | 完整 | [wb-wealth-management-expert](./agents/wb-wealth-management-expert.md) | 财富管理工具集：客户回顾、财务规划、投资组合再平衡、税损收割、投资提案和客户报告生成 |
| 腾讯自选股股票投研专家团 | `StockPartnerTeam` | 专家团 | 完整 | [wb-stock-partner-team-lead](./agents/wb-stock-partner-team-lead.md)、[wb-stock-partner-team-industry-strategist](./agents/wb-stock-partner-team-industry-strategist.md)、[wb-stock-partner-team-signal-chief](./agents/wb-stock-partner-team-signal-chief.md) 等 7 个 | 六位投研专家团，兼擅产业策略、信号捕捉、估值定价、逆向布局、基本面与短线，基于实时行情多视角研判。 |
| 投资大师专家团 | `InvestmentMastersTeam` | 专家团 | 完整 | [wb-investment-masters-team-lead](./agents/wb-investment-masters-team-lead.md)、[wb-investment-masters-team-oracle-of-omaha](./agents/wb-investment-masters-team-oracle-of-omaha.md)、[wb-investment-masters-team-charlie-munger](./agents/wb-investment-masters-team-charlie-munger.md) 等 22 个 | 13位传奇投资哲学家 + 6位专业分析师并行分析，风险管理师评估约束，投资组合经理信号聚合投票，多角度投资分析参考 |
| A股研究团队 | `AShareAnalysis` | 专家团 | 完整 | [wb-a-share-analysis-lead](./agents/wb-a-share-analysis-lead.md)、[wb-a-share-analysis-macro-strategist](./agents/wb-a-share-analysis-macro-strategist.md)、[wb-a-share-analysis-market-reader](./agents/wb-a-share-analysis-market-reader.md) 等 8 个 | 8位研究专家支持6个预设工作流编排，覆盖宏观策略、盘面解读、个股深度、估值定价、产业链映射、资金追踪、风险诊断 |
| 季明辨 | `EarningsReviewer` | 单专家 | 完整 | [wb-earnings-reviewer](./agents/wb-earnings-reviewer.md) | 资深季报复核分析师,读财报电话会和公告更新覆盖模型,产出季报后记、方差表与估值调整,供研究部门沿用。 |
| 钱对齐 | `GlReconciler` | 单专家 | 完整 | [wb-gl-reconciler](./agents/wb-gl-reconciler.md) | 基金后台日终与月末对账专员,在总账与子账之间找出差异、追溯到源交易、归类 timing/reclass/FX 等原因并出具可签核清单。 |
| 查本源 | `KycScreener` | 单专家 | 完整 | [wb-kyc-screener](./agents/wb-kyc-screener.md) | 客户准入合规分析师,解析 KYC 材料、跑规则引擎、比对制裁与 PEP 名单,并按风险等级形成可交合规签核的升级包。 |
| 严研行 | `FsiMarketResearcher` | 单专家 | 完整 | [wb-fsi-market-researcher](./agents/wb-fsi-market-researcher.md) | 面向分析师与基金经理的行业研究分析师,产出行业全景、竞争格局、可比公司估值表与主题选股清单等研究交付物。 |
| 周备全 | `MeetingPrepAgent` | 单专家 | 完整 | [wb-meeting-prep-agent](./agents/wb-meeting-prep-agent.md) | 理财顾问的会议准备搭档,在每次客户见面前汇总关系历史、持仓近况、市场要闻与议题清单,让顾问 5 分钟进入状态。 |
| 莫百炼 | `ModelBuilder` | 单专家 | 完整 | [wb-model-builder](./agents/wb-model-builder.md) | 专业财务建模师,在 Excel 中从零搭建 DCF、LBO、三张表模型与可比公司估值,公式全链接、可追溯、机构级品控。 |
| 关月结 | `MonthEndCloser` | 单专家 | 完整 | [wb-month-end-closer](./agents/wb-month-end-closer.md) | 财务负责人的月末关账搭档,按清单跑应计、滚动表、差异说明,把关账包整理好交给 controller 签核。 |
| 白必得 | `PitchAgent` | 单专家 | 完整 | [wb-pitch-agent](./agents/wb-pitch-agent.md) | 资深投行关联人,从零搭建 pitch 初稿——可比公司、先例交易、DCF、足球场估值图,并生成绑在模型上的品牌化 PPT。 |
| 审细明 | `StatementAuditor` | 单专家 | 完整 | [wb-statement-auditor](./agents/wb-statement-auditor.md) | LP 资本账户报表最后把关人,按基金 NAV 反算每条项目、对齐分配与管理费,发差前形成签核建议与异常清单。 |
| 顾估衡 | `ValuationReviewer` | 单专家 | 完整 | [wb-valuation-reviewer](./agents/wb-valuation-reviewer.md) | PE/VC 基金组合估值主管,收 GP 估值包、跑标准估值模板、算基金 NAV 与 LP 分配、出 LP 报告草稿交投资者关系签核。 |
| 回测明算 | `StrategyBacktestExpert` | 单专家 | 完整 | [wb-strategy-backtest-expert](./agents/wb-strategy-backtest-expert.md) | 把自然语言描述的交易策略转成可运行的 Python 回测脚本，输出标准指标、可视化图表、HTML 仪表盘，并给出实现细节、已知偏差和结果解读。 |
| 钱守通 | `SmbFinance` | 单专家 | 受限 | — | 小企业财务管家，一站式搞定现金流预测、逾期追款、毛利分析、月结对账和税务准备 |
| 刺桐说Pro-投资社群嘉宾团 | `Citongshuopro` | 专家团 | 受限 | — | 模拟真实投资社群运作模式的多智能体投研系统，已接入社群嘉宾数字分身，可7*24为您提供投资咨询服务。 |
| 通达信诊断师 | `TdxStockDiagnostician` | 单专家 | 受限 | — | 像经验丰富的分析师，对任意A股进行六大模块360度全方位诊断，涵盖基本面、技术面、资金面、事件催化、同业对标，输出专业诊断报告。 |
| 通达信选股猎手 | `TdxStockHunter` | 单专家 | 受限 | — | 基于通达信MCP数据，将自然语言转为多维筛选条件，从5000+A股中按基本面/技术面/资金面/估值做横向分析与综合评分，供用户参考。 |
| 通达信评估师 | `TdxValueAssessor` | 单专家 | 受限 | — | 秉承格雷厄姆-巴菲特价值体系，运用15+估值模型，通过护城河评估与多维估值分析，评估企业内在价值与安全边际水平。 |
| 星辰 | `SmartStockAnalyst` | 单专家 | 受限 | — | AI驱动多市场股票分析专家，内置缠论、波浪等15+策略，默认输出精美交互式HTML决策仪表盘报告 |
| 鹏城信息AI专家 | `YahooFinanceCli` | 单专家 | 受限 | — | 查询全球股票实时行情、基本面、财报预期、评级、历史走势与估值洞察，发现热门趋势标的，支持模糊检索与并排对比。 |
| MAI Lab并购交易Agent | `MaiDealAdvisor` | 单专家 | 受限 | — | 接住真实并购项目：拆解资料、画交易结构、核数字与股权，也梳理买方、资金与推进路径。 |
| 同舟股市投研专家 | `FinResearchExpert` | 单专家 | 受限 | — | 连接同舟公开投研能力，稳定生成个股、行业、事件与研报的证据化简报和可复核投研案例页面 |
| 基金投研分析师 | `FundResearchAnalyst` | 单专家 | 受限 | — | 穿透基金业绩、回撤、夏普比率、持仓与基金经理等多维数据，横向对比帮你找出值得长期持有的好基金 |
| 相信光么 | `BelieveInLight` | 专家团 | 受限 | — | 光模块产业链信号监控专家团。主理人 + 6位成员Agent 三端采集信号，因果验证+权重校准，三层嵌套输出景气度评级。 |
| 新股专家 | `NewShareExpert` | 单专家 | 受限 | — | 面向A股新股的事实型助手：多源交叉校验、板块规则区分、精准K线与分时绘制，仅出客观数据不打分不推荐。 |
| 资本市场路演研究团 | `RoadshowResearchTeam` | 专家团 | 受限 | — | 多专家协作标的研报：多源解析、行业对比、财报三表（上市+未上市）、路演研报、股价关联，模板出报告。 |
| 天御对公信贷 | `CorpCreditDueDiligence` | 单专家 | 受限 | — | 对公信贷尽调助手，覆盖行业研究、财务核查、实控人画像与风险预警，输出结构化信评报告。 |
| Vietnam Finance & Tax Expert | `VietnamFinanceTaxExpert` | 单专家 | 受限 | — | 覆盖越南企业税务、会计、银行、外汇与财务合规，提供选址测算、税负计算与ODI落地等可量化交付物。 |
| AI尽调专家团 | `DdDueDiligenceTeam` | 专家团 | 受限 | — | 银行对公授信尽调专家团：主理人按七步流程统筹进件/核验/画像/财务/经营/行业/风险/报告八岗协同。 |

### 游戏空间（25）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 游戏设计师 | `GameDesigner` | 单专家 | 完整 | [wb-game-designer](./agents/wb-game-designer.md) | 用系统思维拆解游戏机制，画清经济系统源与汇，为每条数值配平衡验证路径，把好玩变成可交付的工程产物 |
| 技美美 | `TechnicalArtist` | 单专家 | 完整 | [wb-technical-artist](./agents/wb-technical-artist.md) | 在美术愿景与引擎实现之间架起桥梁，精通着色器和VFX |
| 剧本本 | `NarrativeDesigner` | 单专家 | 完整 | [wb-narrative-designer](./agents/wb-narrative-designer.md) | 将叙事和游戏玩法无缝融合，让故事与互动不可分割 |
| 关卡卡 | `LevelDesigner` | 单专家 | 完整 | [wb-level-designer](./agents/wb-level-designer.md) | 将每个关卡视为精心编排的体验，用空间讲述故事 |
| 音效效 | `GameAudioEngineer` | 单专家 | 完整 | [wb-game-audio-engineer](./agents/wb-game-audio-engineer.md) | 精通FMOD/Wwise集成和空间音频，让游戏声音栩栩如生 |
| 解耦达 | `UnityArchitect` | 单专家 | 完整 | [wb-unity-architect](./agents/wb-unity-architect.md) | 精通ScriptableObjects和解耦系统设计 |
| 虚幻通 | `UnrealSystemEngineer` | 单专家 | 完整 | [wb-unreal-system-engineer](./agents/wb-unreal-system-engineer.md) | 精通C++/Blueprint和Nanite/Lumen |
| 造世界 | `UnrealWorldBuilder` | 单专家 | 完整 | [wb-unreal-world-builder](./agents/wb-unreal-world-builder.md) | 精通UE5 World Partition和大世界流式加载 |
| 联机达 | `UnrealMultiplayerArchitect` | 单专家 | 完整 | [wb-unreal-multiplayer-architect](./agents/wb-unreal-multiplayer-architect.md) | 精通Unreal Actor复制和服务器权威架构 |
| 材质通 | `UnrealTechnicalArtist` | 单专家 | 完整 | [wb-unreal-technical-artist](./agents/wb-unreal-technical-artist.md) | 精通UE5材质编辑器和Niagara VFX |
| 同步达 | `UnityMultiplayerEngineer` | 单专家 | 完整 | [wb-unity-multiplayer-engineer](./agents/wb-unity-multiplayer-engineer.md) | 精通Netcode for GameObjects和网络预测 |
| 着色师 | `UnityShaderGraphArtist` | 单专家 | 完整 | [wb-unity-shader-graph-artist](./agents/wb-unity-shader-graph-artist.md) | 精通Unity Shader Graph和HLSL |
| 插件达 | `UnityEditorToolDeveloper` | 单专家 | 完整 | [wb-unity-editor-tool-developer](./agents/wb-unity-editor-tool-developer.md) | 精通Unity自定义EditorWindow和管线自动化 |
| 节点通 | `GodotGameScriptEngineer` | 单专家 | 完整 | [wb-godot-game-script-engineer](./agents/wb-godot-game-script-engineer.md) | 精通GDScript 2.0和Godot 4节点架构 |
| 联网达 | `GodotMultiplayerEngineer` | 单专家 | 完整 | [wb-godot-multiplayer-engineer](./agents/wb-godot-multiplayer-engineer.md) | 精通Godot 4 MultiplayerAPI和网络复制 |
| 渲染达 | `GodotShaderDeveloper` | 单专家 | 完整 | [wb-godot-shader-developer](./agents/wb-godot-shader-developer.md) | 精通Godot着色语言和VisualShader |
| 乐体验 | `RobloxExperienceDesigner` | 单专家 | 完整 | [wb-roblox-experience-designer](./agents/wb-roblox-experience-designer.md) | 精通Roblox平台UX和商业化设计 |
| 脚本通 | `RobloxSystemScriptEngineer` | 单专家 | 完整 | [wb-roblox-system-script-engineer](./agents/wb-roblox-system-script-engineer.md) | 精通Luau和Roblox客户端-服务器安全模型 |
| 捏脸达 | `RobloxAvatarCreator` | 单专家 | 完整 | [wb-roblox-avatar-creator](./agents/wb-roblox-avatar-creator.md) | 精通Roblox UGC和虚拟形象管线 |
| 空间通 | `VisionOsSpatialEngineer` | 单专家 | 完整 | [wb-vision-os-spatial-engineer](./agents/wb-vision-os-spatial-engineer.md) | 精通visionOS平台开发，打造Apple Vision Pro空间应用 |
| 渲染师 | `MacOsSpatialMetalEngineer` | 单专家 | 完整 | [wb-mac-os-spatial-metal-engineer](./agents/wb-mac-os-spatial-metal-engineer.md) | 精通Apple Metal图形API和macOS空间计算开发 |
| 沉浸达 | `XrImmersiveDeveloper` | 单专家 | 完整 | [wb-xr-immersive-developer](./agents/wb-xr-immersive-developer.md) | 精通XR沉浸式体验开发，创造身临其境的VR/MR应用 |
| 空间界 | `XrInterfaceArchitect` | 单专家 | 完整 | [wb-xr-interface-architect](./agents/wb-xr-interface-architect.md) | 设计XR环境中的用户界面架构，让3D空间交互直观自然 |
| 座舱师 | `XrCockpitInteractionExpert` | 单专家 | 完整 | [wb-xr-cockpit-interaction-expert](./agents/wb-xr-cockpit-interaction-expert.md) | 专精XR环境下的座舱式交互设计 |
| 鹏城信息AI专家 | `GameDevelopmentStudio` | 专家团 | 受限 | — | 统筹策划、技术、美术、音频、质量、运营六大专业成员，以七阶段工作流驱动游戏从概念到上线流程协同开发。 |

### 数据智能（44）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 深网网 | `AiEngineer` | 单专家 | 完整 | [wb-ai-engineer](./agents/wb-ai-engineer.md) | 精通ML模型开发部署优化的全栈AI工程师，将AI从论文带到生产环境 |
| 深研研 | `DeepResearchExpert` | 单专家 | 完整 | [wb-deep-research-expert](./agents/wb-deep-research-expert.md) | 综合性深度研究专家，支持多源信息检索、事实验证、知识发现和结构化报告生成，含微信公众号文章搜索能力 |
| 舒明析 | `DataAnalyticsReporter` | 单专家 | 完整 | [wb-data-analytics-reporter](./agents/wb-data-analytics-reporter.md) | 将复杂数据转化为战略洞察，提供指标诊断、KPI框架设计、数据质量评估与决策报告 |
| 风向标 | `TrendResearcher` | 单专家 | 完整 | [wb-trend-researcher](./agents/wb-trend-researcher.md) | 持续追踪行业和技术趋势，为产品战略提供前瞻性洞察 |
| 索引灵 | `DatabaseOptimizationExpert` | 单专家 | 完整 | [wb-database-optimization-expert](./agents/wb-database-optimization-expert.md) | 专精数据库性能调优和查询优化，让慢查询变快让瓶颈消失 |
| 管道通 | `DataEngineer` | 单专家 | 完整 | [wb-data-engineer](./agents/wb-data-engineer.md) | 构建高效可靠的数据管道和ETL流程，让数据从源头到洞察畅通无阻 |
| 聚数数 | `DataIntegrationAgent` | 单专家 | 完整 | [wb-data-integration-agent](./agents/wb-data-integration-agent.md) | 将分散数据清洗整合统一，构建企业统一数据视图 |
| 拉数数 | `SalesDataExtractionAgent` | 单专家 | 完整 | [wb-sales-data-extraction-agent](./agents/wb-sales-data-extraction-agent.md) | 从各类数据源中自动提取整理销售数据 |
| 自进化 | `AutonomousOptimizationArchitect` | 单专家 | 完整 | [wb-autonomous-optimization-architect](./agents/wb-autonomous-optimization-architect.md) | 专精于设计能自主优化和进化的智能系统架构，让系统越用越聪明 |
| 模检检 | `ModelQualityAssuranceExpert` | 单专家 | 完整 | [wb-model-quality-assurance-expert](./agents/wb-model-quality-assurance-expert.md) | 系统化评估保障AI模型质量，确保输出准确公平安全 |
| 知库库 | `LlmWiki` | 单专家 | 完整 | [wb-llm-wiki](./agents/wb-llm-wiki.md) | 基于 Andrej Karpathy 的 LLM Wiki 模式，帮助用户构建、维护和查询持久化的个人知识库。擅长将原始资料（论文、文章、笔记等）编译为结构化… |
| 析数数 | `DataAnalysisExpert` | 单专家 | 完整 | [wb-data-analysis-expert](./agents/wb-data-analysis-expert.md) | 数据分析专家，支持 Excel 电子表格的创建、编辑、分析、公式计算、格式化和数据可视化 |
| 探数数 | `DataExplorationExpert` | 单专家 | 完整 | [wb-data-exploration-expert](./agents/wb-data-exploration-expert.md) | 数据探索专家，支持 SQL 查询、数据探索、可视化、仪表板构建、数据验证和洞察生成 |
| 财数数 | `FinanceDataExpert` | 单专家 | 完整 | [wb-finance-data-expert](./agents/wb-finance-data-expert.md) | 金融数据检索专家，通过自然语言查询 209 个金融数据 API，涵盖股票、指数、期货、债券、基金和宏观经济等 15 大类 |
| 深度研究团队 | `GPTResearcherTeam` | 专家团 | 完整 | [wb-gpt-researcher-team-lead](./agents/wb-gpt-researcher-team-lead.md)、[wb-gpt-researcher-team-research-planner](./agents/wb-gpt-researcher-team-research-planner.md)、[wb-gpt-researcher-team-topic-researcher](./agents/wb-gpt-researcher-team-topic-researcher.md) 等 7 个 | 深度研究报告输出，7角色5阶段聚合多源信息，经审稿修订循环输出带引用的专业报告 |
| 金山文档智能建表助手 | `KdocsDataTable` | 单专家 | 完整 | [wb-kdocs-data-table](./agents/wb-kdocs-data-table.md) | 金山文档出品，专注接龙转表与智能表单，支持条件格式、数据校验和区域保护，省心好用。 |
| 智数分析专家团 | `AiDataCopilot` | 专家团 | 完整 | [wb-ai-data-copilot-lead](./agents/wb-ai-data-copilot-lead.md)、[wb-ai-data-copilot-sql-analyst](./agents/wb-ai-data-copilot-sql-analyst.md)、[wb-ai-data-copilot-data-scientist](./agents/wb-ai-data-copilot-data-scientist.md) 等 6 个 | 6人AI数据分析团队，擅长自然语言转SQL、Python建模、RAG知识问答、仪表盘可视化与报告生成 |
| 词力 | `VocabCraftExpert` | 单专家 | 完整 | [wb-vocab-craft-expert](./agents/wb-vocab-craft-expert.md) | 融合间隔重复记忆科学与键盘输入训练的AI英语词汇教练，支持每日定时推送、错词强化、三种练习模式，让背单词更科学高效 |
| 数字生命卡兹克 | `AiHot` | 单专家 | 完整 | [wb-ai-hot](./agents/wb-ai-hot.md) | 一句话查到每天精选的 AI 模型/产品/行业/论文动态，自动整理成中文简报，免配置免登录。 |
| 花叔数据分析专家团 | `HuashuDataPro` | 专家团 | 完整 | [wb-huashu-data-pro-lead](./agents/wb-huashu-data-pro-lead.md)、[wb-huashu-data-pro-trend-analyst](./agents/wb-huashu-data-pro-trend-analyst.md)、[wb-huashu-data-pro-structure-analyst](./agents/wb-huashu-data-pro-structure-analyst.md) 等 4 个 | 「一人公司」本地数据分析专家团。一份 Excel 进，趋势 / 结构 / 异常三专家并行分析，交付网页、Excel、PPT 三格式报告，数据不出本地。 |
| 腾讯云知（乐享） | `YunzhiQaAssistant` | 单专家 | 完整 | [wb-yunzhi-qa-assistant](./agents/wb-yunzhi-qa-assistant.md) | 基于腾讯云知（乐享）知识库的检索增强问答专家，支持竞品对比与国际化海外检索，输出带引用的结构化答案。 |
| 万方数据 | `AcademicJournalSelector` | 专家团 | 受限 | — | 万方数据旗下学术选刊专家团，中英双管道并行检索，覆盖中英文核心期刊，输出冲-稳-保分层投稿方案。 |
| 鹏城信息AI专家 | `PromptEngineeringExpert` | 单专家 | 受限 | — | 精通提示词工程，提供提示词撰写、系统提示设计、自定义指令、优化迭代与评估测试，打造高效稳定的智能体。 |
| 腾讯健康-觅影-眼底彩照疾病分析专家 | `FundusDiseaseAnalysis` | 单专家 | 受限 | — | 基于普角与超广角眼底彩照的AI多病种分析，覆盖青光眼、糖网、AMD等数十种疾病的诊断与报告解读。 |
| 鹏城信息AI专家 | `ArxivWatcher` | 单专家 | 受限 | — | 检索ArXiv最新论文，支持按关键词、作者、学科精准搜索，自动提炼摘要要点并归档至研究日志，助您持续追踪前沿学术动态。 |
| 金数据 | `JinshujuExpert` | 单专家 | 受限 | — | 通过金数据 MCP 用自然语言搭建表单、增删改查与批量维护数据、查询套餐额度，替代登录后台手动操作 |
| DataBrain舆情分析专家 | `DatabrainOpinionExpert` | 单专家 | 受限 | — | 玩家口碑与舆情侦察兵，覆盖评分告警、内容趋势、竞品对比与热点挖掘，实时感知玩家声音，辅助运营决策 |
| 组小学 | `OmicsBioinfoExpert` | 单专家 | 受限 | — | 专攻生信分析，支持任务投递、进度追踪、日志解析、智能排错。内置自研模型库，加速生信研发与生产分析 |
| 组小学 | `OmicsCdgptExpert` | 单专家 | 受限 | — | 基于腾讯CD-GPT多模态大模型，覆盖DNA、RNA、蛋白质序列，支持翻译、反向翻译、生成 |
| 组小学 | `OmicsDiagnosisExpert` | 单专家 | 受限 | — | 生物信息分析智能诊断，解析任务日志、拆解错误堆栈、快速定位OOM、磁盘满载等故障根源，提升分析效率 |
| 组小学 | `OmicsIggmExpert` | 单专家 | 受限 | — | 精通腾讯IgGM生成式模型。覆盖CDR重设计、全链生成与人源化亲和力优化，输出可验证的抗体候选序列 |
| 组小学 | `OmicsOriExpert` | 单专家 | 受限 | — | 覆盖序列从头设计、USMFold结构预测与溶解性、热稳定性，打通从设计到可生产蛋白的关键决策 |
| 组小学 | `OmicsScbertExpert` | 单专家 | 受限 | — | 基于腾讯scBERT单细胞预训练大模型，实现细胞精细注释、新亚群挖掘及Marker筛选，自适应多组织参数，助力肿瘤细胞研究 |
| 组小学 | `OmicsScproteinExpert` | 单专家 | 受限 | — | 腾讯 scPROTEIN表征模型，实现对单细胞蛋白组的多肽不确定性估计，去除批次效应噪声以及单细胞蛋白组的细胞类型注释 |
| 组小学 | `OmicsTfoldExpert` | 单专家 | 受限 | — | 腾讯tFold模型，专注单克隆抗体、纳米抗体与抗原复合物的高精度结合界面建模，辅助表位预测与亲和力改造 |
| 女娲 | `Nuwa` | 单专家 | 受限 | — | 女娲蒸馏知名人物的思维方式为可运行视角。给定名字（如乔布斯、芒格、纳瓦尔、马斯克），运行多路调研→三重验证提炼→技能构建→质量验证四阶段流水线，用其认知框架分… |
| 个人知识库架构师 | `PersonalKnowledgeArchitect` | 单专家 | 受限 | — | 精通卡片盒、PARA、LYT 等方法论，结合 Obsidian 等工具把信息搭成可检索的第二大脑。 |
| 表单管理专家 | `JinshujuFormExpert` | 单专家 | 受限 | — | 搭建报名、问卷、预约、收款等表单，增删改查、批量导入导出数据，替代登录后台操作。 |
| AI表格专家 | `JinshujuTableExpert` | 单专家 | 受限 | — | 轻量表格，支持文本、日期等多种字段类型，专为 Agent 设计，可随时读写协作。 |
| 腾讯健康-觅影-肺部CT影像的肺炎辅助评估专家 | `PneumoniaAiAnalyst` | 单专家 | 受限 | — | 上传胸部CT DICOM压缩包即可完成肺炎AI辅助诊断，逐张分析耗时较久请耐心等待。 |
| DataBrain X TideRider | `TideriderSentiment` | 单专家 | 受限 | — | 游戏舆情分析师：基于多平台玩家评论，做异动归因、话题提取、版本趋势对比，并生成精品可视化分析报告。 |
| 科研专家团 | `EmpiricalResearchTeam` | 专家团 | 受限 | — | 覆盖实证研究全流程的专家团：因果推断、稳健性检验、出版级表图与降AIGC，高效完成可复现学术论文 |
| 秘宝 | `MibaoMediaArchivist` | 单专家 | 受限 | — | 在不改动原件的前提下，完成影像盘点、严格SHA-256、精确重复识别、本地索引检索与可验收报告 |
| 问图 | `Wentu` | 单专家 | 受限 | — | 腾讯地图问数助手，口径全部来自知识库、绝不瞎猜，产出必标依据与业务域归属，含糊问法主动追问澄清 |

### 营销增长（37）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 卖得好 | `ChinaEcommerceOperationsExpert` | 单专家 | 完整 | [wb-china-ecommerce-operations-expert](./agents/wb-china-ecommerce-operations-expert.md) | 精通天猫京东拼多多等平台运营，从选品到爆款一站式操盘 |
| 盾卫卫 | `BrandGuardian` | 单专家 | 完整 | [wb-brand-guardian](./agents/wb-brand-guardian.md) | 15年品牌战略经验，守护品牌一致性的终极捍卫者 |
| 裂变变 | `GrowthHacker` | 单专家 | 完整 | [wb-growth-hacker](./agents/wb-growth-hacker.md) | 用数据驱动的实验方法论找到未开发的增长渠道，实现指数级增长 |
| 点睛睛 | `AdCreativeStrategist` | 单专家 | 完整 | [wb-ad-creative-strategist](./agents/wb-ad-creative-strategist.md) | 精通广告创意设计和效果预判，创作高转化广告素材 |
| 播旺旺 | `LivestreamEcommerceCoach` | 单专家 | 完整 | [wb-livestream-ecommerce-coach](./agents/wb-livestream-ecommerce-coach.md) | 精通直播带货全链路运营，从话术到投流帮助实现GMV突破 |
| 传声声 | `SocialMediaStrategist` | 单专家 | 完整 | [wb-social-media-strategist](./agents/wb-social-media-strategist.md) | 全面统筹多平台社交媒体策略，让品牌在每个平台发出最强音 |
| 搜霸霸 | `SeoExpert` | 单专家 | 完整 | [wb-seo-expert](./agents/wb-seo-expert.md) | 精通Google搜索算法和技术SEO，让网站在搜索结果中稳居前列 |
| 海跨洋 | `CrossBorderEcommerceExpert` | 单专家 | 完整 | [wb-cross-border-ecommerce-expert](./agents/wb-cross-border-ecommerce-expert.md) | 精通亚马逊Shopify等国际电商平台，助力品牌出海全球 |
| 留客客 | `PrivateDomainOperationsExpert` | 单专家 | 完整 | [wb-private-domain-operations-expert](./agents/wb-private-domain-operations-expert.md) | 精通微信私域流量池搭建运营，将公域流量沉淀为私域资产 |
| 度优优 | `BaiduSeoExpert` | 单专家 | 完整 | [wb-baidu-seo-expert](./agents/wb-baidu-seo-expert.md) | 深谙百度搜索算法和中国搜索生态，让品牌获得最大曝光 |
| 竞高高 | `PpcBiddingStrategist` | 单专家 | 完整 | [wb-ppc-bidding-strategist](./agents/wb-ppc-bidding-strategist.md) | 精通Google Ads和百度竞价，以最低点击成本获取高质量流量 |
| 领英达 | `LinkedInContentCreator` | 单专家 | 完整 | [wb-linked-in-content-creator](./agents/wb-linked-in-content-creator.md) | 精通LinkedIn专业社交平台内容策略，帮助建立思想领袖地位 |
| 精投投 | `SocialAdStrategist` | 单专家 | 完整 | [wb-social-ad-strategist](./agents/wb-social-ad-strategist.md) | 精通社交平台广告投放，以精准定向实现最优获客成本 |
| 翻页页 | `CarouselContentGrowthExpert` | 单专家 | 完整 | [wb-carousel-content-growth-expert](./agents/wb-carousel-content-growth-expert.md) | 专精设计高互动率轮播图内容，驱动社交平台用户参与和增长 |
| 榜上上 | `AppStoreOptimizationExpert` | 单专家 | 完整 | [wb-app-store-optimization-expert](./agents/wb-app-store-optimization-expert.md) | 精通App Store和Google Play搜索排名算法，让应用脱颖而出 |
| 红迪迪 | `RedditCommunityBuilder` | 单专家 | 完整 | [wb-reddit-community-builder](./agents/wb-reddit-community-builder.md) | 深谙Reddit社区文化，在全球最大论坛上建立真实社区影响力 |
| 查账账 | `PaidMediaAuditor` | 单专家 | 完整 | [wb-paid-media-auditor](./agents/wb-paid-media-auditor.md) | 深度审计广告投放数据和预算分配，找出被浪费的广告费 |
| 追踪踪 | `AdTrackingExpert` | 单专家 | 完整 | [wb-ad-tracking-expert](./agents/wb-ad-tracking-expert.md) | 精通广告追踪代码和转化归因技术，确保投放效果可追踪 |
| 词探探 | `SearchTermAnalyst` | 单专家 | 完整 | [wb-search-term-analyst](./agents/wb-search-term-analyst.md) | 深度分析搜索词数据，挖掘用户真实搜索意图 |
| 算法投 | `ProgrammaticAdBuyer` | 单专家 | 完整 | [wb-programmatic-ad-buyer](./agents/wb-programmatic-ad-buyer.md) | 精通程序化广告购买和DSP平台，通过算法实现大规模精准投放 |
| 布道道 | `DeveloperEvangelist` | 单专家 | 完整 | [wb-developer-evangelist](./agents/wb-developer-evangelist.md) | 构建发展开发者社区，推动产品在开发者群体中的采用 |
| 知文文 | `CulturalIntelligenceStrategist` | 单专家 | 完整 | [wb-cultural-intelligence-strategist](./agents/wb-cultural-intelligence-strategist.md) | 帮助品牌建立全球化过程中的文化敏感度 |
| 识图图 | `IdentityGraphOperator` | 单专家 | 完整 | [wb-identity-graph-operator](./agents/wb-identity-graph-operator.md) | 构建维护用户身份图谱系统，实现跨平台身份识别 |
| 司玉琦 | `PrivateDomainMarketingExpert` | 单专家 | 完整 | [wb-private-domain-marketing-expert](./agents/wb-private-domain-marketing-expert.md) | 深谙私域运营增长，盘活现有数据资源、洞察营销机会、实现业绩增长 |
| 策动动 | `MarketingCampaignExpert` | 单专家 | 完整 | [wb-marketing-campaign-expert](./agents/wb-marketing-campaign-expert.md) | 策划、创建和优化全渠道营销活动，包括内容策略、社交媒体、邮件营销和广告投放 |
| 营销战役团队 | `MarketingCampaignTeam` | 专家团 | 完整 | [wb-marketing-campaign-team-lead](./agents/wb-marketing-campaign-team-lead.md)、[wb-marketing-campaign-team-content-creator](./agents/wb-marketing-campaign-team-content-creator.md)、[wb-marketing-campaign-team-campaign-planner](./agents/wb-marketing-campaign-team-campaign-planner.md) 等 5 个 | 由营销总监领导的 4 人营销专家团队：内容创作者（博客/邮件/社媒/品牌声音）、活动策划师（战役策略/受众/渠道/预算）、SEO 专家（技术审计/内容优化/效… |
| 内容变现商业化专家团 | `ContentMonetizationTeam` | 专家团 | 完整 | [wb-content-monetization-team-lead](./agents/wb-content-monetization-team-lead.md)、[wb-content-monetization-team-cps-specialist](./agents/wb-content-monetization-team-cps-specialist.md)、[wb-content-monetization-team-cpe-cpm-expert](./agents/wb-content-monetization-team-cpe-cpm-expert.md) 等 5 个 | 5人专家团覆盖CPS带货分佣、CPE/CPM效果广告、创作者-品牌交易撮合与收益分析，助力内容创作者和品牌方实现商业化闭环 |
| 社媒互动增长专家团 | `SocialEngagementTeam` | 专家团 | 完整 | [wb-social-engagement-team-lead](./agents/wb-social-engagement-team-lead.md)、[wb-social-engagement-team-interaction-automator](./agents/wb-social-engagement-team-interaction-automator.md)、[wb-social-engagement-team-ai-comment-specialist](./agents/wb-social-engagement-team-ai-comment-specialist.md) 等 5 个 | 通过智能化互动自动化、AI评论运营、高转化信号挖掘和品牌舆情监控，安全高效提升社交媒体互动效果，覆盖14+全球主流平台 |
| SEO 内容营销团队 | `SeoContentTeam` | 专家团 | 完整 | [wb-seo-content-team-lead](./agents/wb-seo-content-team-lead.md)、[wb-seo-content-team-keyword-researcher](./agents/wb-seo-content-team-keyword-researcher.md)、[wb-seo-content-team-content-writer](./agents/wb-seo-content-team-content-writer.md) 等 7 个 | 7位专业角色分5阶段协作：关键词研究、SEO长文创作、技术优化、内容编辑、链接策略、转化率分析，全流程自动化产出高质量SEO内容 |
| 爆量君 | `JiayiAdsAnalyticsExpert` | 单专家 | 受限 | — | 不止分析，更能直接操盘——通过API调价、暂停词、加否词、改预算、上下创意，五大广告平台一句话搞定 |
| 苍何 | `GeoDiagnosisExpert` | 单专家 | 受限 | — | 品牌 GEO 可见度诊断专家，覆盖基建评估、AI 平台收录、竞品对标、舆情分析，输出 AIVO 评分报告。 |
| 车赢赢 | `AutoConsultant` | 单专家 | 受限 | — | 精通用户选车购车决策，深谙汽车营销增长，覆盖品牌营销、用户增长、车型分析、购车咨询等全链路汽车服务。 |
| 腾讯健康NGES医药营销专家团 | `NgesHealthcareMarketingTeam` | 专家团 | 受限 | — | 由医药营销智能协调官统一调度的医药营销专家团，整合HCP客户洞察、互动病例生成、学术物料生成、医学内容二创、合规审核五大能力，覆盖从客户情报分析到内容生产到合… |
| 鹏城信息AI专家 | `MarketAnalysisCn` | 单专家 | 受限 | — | 聚焦市场趋势、竞品对标与用户行为洞察，输出SWOT分析与战略建议，助力企业做出明智商业决策。 |
| 热点猎手 | `TrendHunter` | 单专家 | 受限 | — | 追踪微博抖音小红书全网热搜，关键词过滤加竞品监控，从选题文案到视频与全平台分发，打通内容全链路 |
| 微信视频号运营策略师 | `WechatChannelsStrategist` | 单专家 | 受限 | — | 精通视频号社交推荐与生态联动，专注内容策划、直播带货、社交裂变与私域闭环，助力视频号从0到1增长 |
| 营销增长专家团 | `MarketingGrowthTeam` | 专家团 | 受限 | — | fCMO 级全栈营销增长团队：转化率优化、SEO 与内容策略、增长工程、数据归因分析与策略规划，全方位助力 SaaS 产品增长 |

### 内容创作（48）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 文博凯 | `ContentCreator` | 单专家 | 完整 | [wb-content-creator](./agents/wb-content-creator.md) | 擅长创作引人入胜的多平台内容，让品牌故事触达目标受众 |
| 斗音音 | `DouyinStrategist` | 单专家 | 完整 | [wb-douyin-strategist](./agents/wb-douyin-strategist.md) | 精通抖音算法和内容生态，打造短视频爆款并实现商业化变现 |
| 薛红笙 | `XiaohongshuOperationsExpert` | 单专家 | 完整 | [wb-xiaohongshu-operations-expert](./agents/wb-xiaohongshu-operations-expert.md) | 深谙小红书种草生态和推荐机制，打造高互动率种草内容 |
| 剪神神 | `ShortVideoEditingCoach` | 单专家 | 完整 | [wb-short-video-editing-coach](./agents/wb-short-video-editing-coach.md) | 精通短视频剪辑技巧和节奏把控，让每条视频具有专业冲击力 |
| 郝文昌 | `WechatOfficialAccountExpert` | 单专家 | 完整 | [wb-wechat-official-account-expert](./agents/wb-wechat-official-account-expert.md) | 精通公众号内容策略和粉丝增长，打造10万+品牌自媒体矩阵 |
| 弹幕幕 | `BilibiliContentStrategist` | 单专家 | 完整 | [wb-bilibili-content-strategist](./agents/wb-bilibili-content-strategist.md) | 精通B站平台生态和年轻用户偏好，打造高播放量视频策略 |
| 拓刻刻 | `TikTokStrategist` | 单专家 | 完整 | [wb-tik-tok-strategist](./agents/wb-tik-tok-strategist.md) | 精通TikTok算法和海外短视频生态，帮助品牌在全球平台爆发 |
| 热搜搜 | `WeiboStrategist` | 单专家 | 完整 | [wb-weibo-strategist](./agents/wb-weibo-strategist.md) | 精通微博话题营销和舆论传播规律，让品牌在热搜持续出圈 |
| 晒图图 | `InstagramOperationsExpert` | 单专家 | 完整 | [wb-instagram-operations-expert](./agents/wb-instagram-operations-expert.md) | 精通Instagram视觉美学和内容策略，打造令人向往的品牌形象 |
| 推文文 | `TwitterOperationsExpert` | 单专家 | 完整 | [wb-twitter-operations-expert](./agents/wb-twitter-operations-expert.md) | 精通Twitter/X平台互动策略和话题运营，让品牌占据全球对话 |
| 著书书 | `BookCoCreator` | 单专家 | 完整 | [wb-book-co-creator](./agents/wb-book-co-creator.md) | 与作者深度协作，帮助规划书籍结构和内容，达到出版级品质 |
| 声浪浪 | `PodcastStrategist` | 单专家 | 完整 | [wb-podcast-strategist](./agents/wb-podcast-strategist.md) | 精通播客内容策划和增长策略，通过音频建立深度用户连接 |
| 答有道 | `ZhihuStrategist` | 单专家 | 完整 | [wb-zhihu-strategist](./agents/wb-zhihu-strategist.md) | 精通知乎推荐机制和知识营销策略，通过高质量回答建立权威 |
| 老铁铁 | `KuaishouStrategist` | 单专家 | 完整 | [wb-kuaishou-strategist](./agents/wb-kuaishou-strategist.md) | 深谙快手下沉市场特性和老铁文化，打造接地气的内容策略 |
| 腾讯云知（乐享） | `PptCreationExpert` | 单专家 | 完整 | [wb-ppt-creation-expert](./agents/wb-ppt-creation-expert.md) | 基于腾讯云知（乐享）平台，整合通用汇报、面客方案、高拜材料与演讲讲稿生成的 PPT 制作专家 |
| 动画画 | `RemotionVideoExpert` | 单专家 | 完整 | [wb-remotion-video-expert](./agents/wb-remotion-video-expert.md) | 基于 Remotion 的视频生成专家，创建产品演示、解说视频、社交媒体内容和演示文稿 |
| 金山文档文档管家助手 | `KdocsDocButler` | 单专家 | 完整 | [wb-kdocs-doc-butler](./agents/wb-kdocs-doc-butler.md) | 金山文档出品，覆盖新建搜索、分类整理与分享权限管理，助力文档全生命周期一站搞定。 |
| 金山文档知识收藏助手 | `KdocsKnowledgeCollector` | 单专家 | 完整 | [wb-kdocs-knowledge-collector](./agents/wb-kdocs-knowledge-collector.md) | 金山文档出品，支持网页剪藏、碎片笔记整理与多文档智能摘要，帮你沉淀云端知识资产。 |
| 金山文档PDF处理助手 | `KdocsPdfToolbox` | 单专家 | 完整 | [wb-kdocs-pdf-toolbox](./agents/wb-kdocs-pdf-toolbox.md) | 金山文档出品，支持PDF按页拆分合并、格式转换与全文翻译，覆盖常见文档处理场景。 |
| 金山文档PPT创作助手 | `KdocsPptCreator` | 单专家 | 完整 | [wb-kdocs-ppt-creator](./agents/wb-kdocs-ppt-creator.md) | 金山文档出品，一句话或参考文档即可生成完整PPT，自动完成大纲排版与场景配色方案。 |
| AI师傅 | `AIShifuExpert` | 单专家 | 完整 | [wb-ai-shifu-expert](./agents/wb-ai-shifu-expert.md) | 基于你的教学需求和原始内容(PPT、Word、PDF、txt等)，帮你快速做门AI一对一互动课 |
| 内容创作专家团 | `AiContentCreatorTeam` | 专家团 | 部分 | [wb-ai-content-creator-team-lead](./agents/wb-ai-content-creator-team-lead.md)、[wb-ai-content-creator-team-copywriter](./agents/wb-ai-content-creator-team-copywriter.md)、[wb-ai-content-creator-team-video-generator](./agents/wb-ai-content-creator-team-video-generator.md) 等 6 个 | AI驱动的多模态内容生产团队，从创意策划到成品交付全覆盖，涵盖品牌定位、情绪板、广告方向、文案创作、视频生成、图片设计、精修合成和素材改编。 |
| 全域内容分发专家团 | `ContentDistributionTeam` | 专家团 | 完整 | [wb-content-distribution-team-lead](./agents/wb-content-distribution-team-lead.md)、[wb-content-distribution-team-domestic-platform-expert](./agents/wb-content-distribution-team-domestic-platform-expert.md)、[wb-content-distribution-team-international-platform-expert](./agents/wb-content-distribution-team-international-platform-expert.md) 等 5 个 | 一站式多平台内容分发方案，覆盖13+全球社交媒体平台（含微信视频号），提供发布规则适配、排期管理、批量发布编排、跨平台数据分析和小红书自动化发布能力 |
| 苍何视频生成团队 | `VideoGenTeam` | 专家团 | 完整 | [wb-video-gen-team-lead](./agents/wb-video-gen-team-lead.md)、[wb-video-gen-team-ling-reader](./agents/wb-video-gen-team-ling-reader.md)、[wb-video-gen-team-ling-planner](./agents/wb-video-gen-team-ling-planner.md) 等 4 个 | 三位一体的AI视频创作团队：灵阅负责采集AI/科技热点，灵枢负责策划选题与脚本，灵映负责渲染MP4视频成品（配音+字幕）。全流程自动化，60秒短视频一键生成。 |
| 苍何视频解剖 | `VideoDissection` | 专家团 | 完整 | [wb-video-dissection-lead](./agents/wb-video-dissection-lead.md)、[wb-video-dissection-video-extractor](./agents/wb-video-dissection-video-extractor.md)、[wb-video-dissection-script-analyst](./agents/wb-video-dissection-script-analyst.md) | 专业拆解火爆抖音视频拍摄手法的专家团。输入抖音链接，自动提取视频、转录文案、分析景别运镜、剪辑节奏、色调风格，生成完整拍摄脚本拆解文档，并提供可落地的仿拍建议。 |
| 袋鼠帝宣传片创作团队 | `PromoCreatorTeam` | 专家团 | 完整 | [wb-promo-creator-team-lead](./agents/wb-promo-creator-team-lead.md)、[wb-promo-creator-team-brief-strategist](./agents/wb-promo-creator-team-brief-strategist.md)、[wb-promo-creator-team-storyboard-artist](./agents/wb-promo-creator-team-storyboard-artist.md) 等 6 个 | 6位专业角色分6阶段协作完成产品宣传片全流程制作：创意简报、逐镜头分镜、素材生产、HyperFrames剪辑合成、BGM设计与交付，从产品URL到可发布的60… |
| PPT大纲、生成、视频、演示与交付专家团 | `HumanizePptTeam` | 专家团 | 完整 | [wb-humanize-ppt-team-lead](./agents/wb-humanize-ppt-team-lead.md)、[wb-humanize-ppt-team-outline-director](./agents/wb-humanize-ppt-team-outline-director.md)、[wb-humanize-ppt-team-guizang-renderer](./agents/wb-humanize-ppt-team-guizang-renderer.md) 等 7 个 | 把原始资料梳理成人感PPT大纲，调度HTML生成、演讲模式、视频动效与交付质检，形成可演示成果。 |
| 爆款炼金师 | `ViralTopicMaster` | 单专家 | 受限 | — | 投热点出爆款。12 心法预筛+8 维打分+6 大形态产出，公众号视频号小红书 H5 通吃。 |
| 吟游诗人基德创作专家 | `KiddContentExpert` | 单专家 | 受限 | — | 基于深度研究报告，用基德风格创作口语化、反常识的知识视频脚本，覆盖时政财经、宇宙科普与科技前沿。 |
| 科技侠来了 | `TopicEvaluator` | 单专家 | 受限 | — | 双层级4维评分与5方向对比，全部评分详情、硬源清单、风险提示在对话中完整展示，报告可下载存档。 |
| 福帮手 | `LongManuscriptExpert` | 单专家 | 受限 | — | 把提纲、访谈、旧稿和零散素材整理成结构清晰的长文档，支持章节续写、限定范围改稿与成稿交付前检查。 |
| 懂秘 | `NewsBuddy` | 单专家 | 受限 | — | 懂你的资讯顾问。基于隐式画像精选新闻，告诉你每条跟你有什么关系、你能做什么，让信息真正为你所用。 |
| 汽车行业内容创作专家团 | `ContentCreationExpertProd` | 专家团 | 受限 | — | 汽车行业垂类图文创作团队，5 人协作完成选题、撰写、智能配图与质检，一键交付懂车帝、小红书等风格图文 |
| 把专业内容画给外行看懂 | `VibeknowHanddraw` | 单专家 | 受限 | — | 老师讲考点、医生讲术后护理、工程师讲原理，专业内容边画边讲成手绘科普视频，51种风格随选。 |
| 鹏城信息AI专家 | `AiHumanizer` | 单专家 | 受限 | — | 识别24种AI写作模式与500+词汇，统计突发性与多样性，重写为自然真实的人类表达，彻底消除机器味。 |
| AI师傅 | `AiShifu` | 单专家 | 受限 | — | 基于你的教学需求和原始内容(PPT、Word、PDF、txt等)，帮你快速做门AI一对一互动课 |
| 一站式视频创作专家 | `ChatcutVideoEditor` | 单专家 | 受限 | — | AI 视频剪辑与素材生成：剪辑、字幕、转场、特效，并生成视频/图片/音乐/配音，保持可手动编辑的多轨时间线，支持导出 Pr / DaVinci 工程文件。 |
| 鹏城信息AI专家 | `NovelGenerator` | 单专家 | 受限 | — | 把一句话灵感扩写成完整提示词与大纲，逐章生成连贯爽文，维护角色、地点、情节一致，支持修仙、重生、都市等题材。 |
| 鹏城信息AI专家 | `ContentWriter` | 单专家 | 受限 | — | 专注为小红书、知乎、公众号、抖音生成平台原生的可发布内容，含标题钩子、正文结构与转化引导，匹配各平台字数规范。 |
| 鹏城信息AI专家 | `AiVideoScript` | 单专家 | 受限 | — | 依据主题或关键词生成完整视频脚本，涵盖分镜表、画面提示词、配音文案与字幕，适配主流AI生成工具及抖音、B站平台。 |
| 鹏城信息AI专家 | `FrontendSlides` | 单专家 | 受限 | — | 零依赖打造动画丰富的网页演示文稿，支持从零创建、PPTX转换与幻灯片增强，提供风格预览、在线部署与PDF导出。 |
| 逐页讲解，一键成片 | `VibeknowPptExplain` | 单专家 | 受限 | — | 讲师做内训、医生讲病理、投标专员讲方案，PPT/PDF 逐页配音成讲解视频，原页原版式不用重做。 |
| 一份文档，排成一条成片 | `VibeknowDesignVideo` | 单专家 | 受限 | — | 老师讲考点、销售讲方法、企业讲卖点，给个文件或说个主题，自动排版配图配音，成一条设计感横版视频。 |
| 新闻资讯专家 | `NewsBriefingExpert` | 单专家 | 受限 | — | 私人新闻主编，覆盖AI财经科技社会国际全领域，多源交叉验证后产出结构化简报，星级标重要度，可溯源。 |
| 小说故事创作专家 | `NovelCreator` | 单专家 | 受限 | — | 长篇创作搭子，善用叙事结构搭骨架、三维理论塑角色，靠追踪系统防矛盾，去AI感规则让正文更像真人手笔。 |
| 福帮手 | `FbsirMomDialogueExpert` | 单专家 | 受限 | — | 整理与妈妈有关的照片、视频、录音、手稿和家庭资料，生成可追溯的故事卡、生活轨迹、追问与书稿。 |
| 贴图头条 | `TietuToutiao` | 单专家 | 受限 | — | 把单版或多版报纸转成手机头图：条目化综合选题、结构化编辑决策、自审门禁、四模板确定性渲染与版本回退。 |
| 腾讯云知（乐享） | `LexiangPptExpert` | 单专家 | 受限 | — | 基于腾讯云知平台，整合通用演示文稿、面客解决方案、高拜材料、演讲讲稿四套生成流程的 PPT 制作专家 |

### 销售商务（17）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 单必成 | `SalesCoach` | 单专家 | 完整 | [wb-sales-coach](./agents/wb-sales-coach.md) | 全栈销售教练：从能力培养到实战执行——会议准备、交易策略、商业案例、竞品分析、通话复盘，用苏格拉底式提问驱动 |
| 策必中 | `ProposalStrategist` | 单专家 | 完整 | [wb-proposal-strategist](./agents/wb-proposal-strategist.md) | 精通销售提案和方案设计，将价值转化为无法拒绝的商业论证 |
| 拓客客 | `EnterpriseAccountStrategist` | 单专家 | 完整 | [wb-enterprise-account-strategist](./agents/wb-enterprise-account-strategist.md) | 精通大客户经营和账户扩展策略，将客户发展为长期战略伙伴 |
| 赢单单 | `DealStrategist` | 单专家 | 完整 | [wb-deal-strategist](./agents/wb-deal-strategist.md) | 精通复杂交易策略制定和推进，帮助销售团队赢得大单 |
| 方案通 | `PresalesTechnicalConsultant` | 单专家 | 完整 | [wb-presales-technical-consultant](./agents/wb-presales-technical-consultant.md) | 架起技术与商业的桥梁，帮助客户理解解决方案的价值 |
| 漏斗通 | `SalesPipelineAnalyst` | 单专家 | 完整 | [wb-sales-pipeline-analyst](./agents/wb-sales-pipeline-analyst.md) | 用数据驱动方法分析销售管道健康度，让预测从猜测变科学 |
| 掘需需 | `DiscoveryCoach` | 单专家 | 完整 | [wb-discovery-coach](./agents/wb-discovery-coach.md) | 训练销售掌握深度需求挖掘技巧，发现真正的业务痛点 |
| 拨必通 | `OutboundStrategist` | 单专家 | 完整 | [wb-outbound-strategist](./agents/wb-outbound-strategist.md) | 精通外呼和冷启动销售策略，让陌生人30秒内愿意继续倾听 |
| 政通通 | `GovernmentDigitalPresalesConsultant` | 单专家 | 完整 | [wb-government-digital-presales-consultant](./agents/wb-government-digital-presales-consultant.md) | 精通政府数字化转型需求和采购流程 |
| 销售作战团队 | `SalesBattleTeam` | 专家团 | 完整 | [wb-sales-battle-team-lead](./agents/wb-sales-battle-team-lead.md)、[wb-sales-battle-team-account-researcher](./agents/wb-sales-battle-team-account-researcher.md)、[wb-sales-battle-team-outreach-strategist](./agents/wb-sales-battle-team-outreach-strategist.md) 等 5 个 | 销售攻坚体系，客户研究锁定目标、外联策略提升触达、竞品情报预警风险、销售预测优化资源分配 |
| 甄客来 | `SmbRevenue` | 单专家 | 受限 | — | 小企业营收增长师，从线索打分到内容策略再到营销活动，一条龙驱动营收增长 |
| 40-20 外卖券 | `MeituanLivingAssistant` | 单专家 | 受限 | — | 帮您一键领取美团优惠券，搜索附近团购美食并下单，探索今日活动，覆盖餐饮饮品等生活服务，省钱省心。 |
| Cordys CRM 助手 | `CordysCrm` | 单专家 | 受限 | — | 角色感知型CRM助手，覆盖线索到现金全链路。自动识别角色，提供查询、风险预警与漏斗分析。 |
| UU跑腿 | `UuptDelivery` | 单专家 | 受限 | — | 提供UU跑腿同城即时配送与现场帮帮服务，支持订单询价、发单下单、订单查询取消、跑男实时追踪及优惠券领取。 |
| 投标策略师 | `BiddingStrategist` | 单专家 | 受限 | — | 半策略师半故事讲述者，用叙事赢得竞标：提炼赢标主题、架构三幕式方案、打磨执行摘要，让方案赢在说服力。 |
| 福帮手 | `IndustrialParkInvestmentAttractionExpert` | 单专家 | 受限 | — | 仅用公开资料，按园区目标找对企业，逐家核验来源、适配理由、反证与未知，快速形成可行动名单。 |
| Linkfox | `LinkfoxExpertAmazonListingSpecialist` | 单专家 | 受限 | — | 聚焦亚马逊Listing全链路诊断与创作，结合竞品、关键词、评论和合规证据，输出可发布文案。 |

### 运营人力（17）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 伯乐乐 | `RecruitmentExpert` | 单专家 | 完整 | [wb-recruitment-expert](./agents/wb-recruitment-expert.md) | 精通人才招聘全流程，为团队找到最佳人才 |
| 暖心心 | `CustomerSupportExpert` | 单专家 | 完整 | [wb-customer-support-expert](./agents/wb-customer-support-expert.md) | 将每次沮丧的用户互动转化为忠实拥护者，用卓越服务创口碑 |
| 育才才 | `CorporateTrainingDesigner` | 单专家 | 完整 | [wb-corporate-training-designer](./agents/wb-corporate-training-designer.md) | 设计系统化企业培训课程和学习路径，让员工技能快速提升 |
| 留洋洋 | `StudyAbroadConsultant` | 单专家 | 完整 | [wb-study-abroad-consultant](./agents/wb-study-abroad-consultant.md) | 精通各国留学申请流程和院校信息 |
| 链优优 | `SupplyChainStrategist` | 单专家 | 完整 | [wb-supply-chain-strategist](./agents/wb-supply-chain-strategist.md) | 优化供应链每个环节，实现成本效率韧性的最佳平衡 |
| HR 运营团队 | `HrOperationsTeam` | 专家团 | 完整 | [wb-hr-operations-team-lead](./agents/wb-hr-operations-team-lead.md)、[wb-hr-operations-team-recruiter](./agents/wb-hr-operations-team-recruiter.md)、[wb-hr-operations-team-comp-analyst](./agents/wb-hr-operations-team-comp-analyst.md) 等 5 个 | 人力资源管理流程化，招聘筛选、薪酬体系设计、组织发展与HR运营流程化管理，助力企业人才战略落地 |
| 毕运营 | `SmbOperations` | 单专家 | 受限 | — | 小企业组织运营师，负责招聘入职、工具初始化和业务快照，让运营不掉链子 |
| i人事-利唐智语AI面谈官 | `IhrConference` | 单专家 | 受限 | — | 提供九大智能面谈大纲与线上实时指引，基于云录制自动生成结构化纪要与待办，全周期辅助管理者高效沟通。 |
| 鹏城信息AI专家 | `ResumeAssistant` | 单专家 | 受限 | — | 提供百分制专业评分、四十项深度清单润色、岗位匹配定制与多格式导出，全面打造高竞争力求职简历。 |
| 鹏城信息AI专家 | `InterviewSimulator` | 单专家 | 受限 | — | 模拟任意职位的真实面试官，覆盖技术产品销售人事等全岗位，提供逐题评分详细反馈与录用建议，助你高效备战面试。 |
| AI面试官 | `IhrAiInterviewer` | 单专家 | 受限 | — | 围绕岗位画像设计面试维度与题库，管理数字人面试模板，校验候选人信息并发起面试，回查面试记录与纪要。 |
| 鹅厂职业经纪人 | `CareerBroker` | 单专家 | 受限 | — | 陪你梳理职业画像，讨论发展与转型方向，并推荐课程、经验文章、内部案例和活水机会。 |
| 小Q | `QingflowHrExpert` | 单专家 | 受限 | — | 轻流MCP直连搭建，覆盖招聘、培训、绩效、入职与人力分析，AI驱动HR数字化转型。 |
| South Africa HR | `SouthAfricaHrAdmin` | 单专家 | 受限 | — | 南非人力行政专家，覆盖招聘、薪酬、签证、B-BBEE与劳动合规，可算成本、查费用、生成可视化交付物。 |
| 福帮手 | `FbsirBeikeYi` | 单专家 | 受限 | — | 在本地备课工作区读懂教材与旧稿，比较教学方案，写回可编辑成果并保留复核与复用线索。 |
| 腾讯招聘专家 | `Txzhaopin` | 单专家 | 完整 | [wb-txzhaopin](./agents/wb-txzhaopin.md) | 腾讯官方招聘助手：覆盖校招/社招全流程——需求沟通、搜简历、猎头推荐、发起面试、面试安排、面评填写与提交、雇主品牌（文案/物料审核/舆情/调研）、招聘数据与定… |
| 庄老师 | `FamilyEducationCoach` | 单专家 | 受限 | — | 运用焦点解决方法，以尊重与好奇为核心，帮家长化解亲子冲突、读懂孩子需求，给出可落地的沟通建议与经验。 |

### 项目质量（25）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 简明明 | `ExecutiveSummaryGenerator` | 单专家 | 完整 | [wb-executive-summary-generator](./agents/wb-executive-summary-generator.md) | 将冗长报告浓缩为高管可快速消化的精华摘要，节省每分钟 |
| 关德豪 | `SeniorProjectManager` | 单专家 | 完整 | [wb-senior-project-manager](./agents/wb-senior-project-manager.md) | 10年以上项目管理经验，精通瀑布和敏捷，是复杂项目定海神针 |
| 文档达 | `DocumentGenerationExpert` | 单专家 | 完整 | [wb-document-generation-expert](./agents/wb-document-generation-expert.md) | 自动化生成各类业务文档，大幅提升文档创建效率 |
| 流畅畅 | `WorkflowOptimizationExpert` | 单专家 | 完整 | [wb-workflow-optimization-expert](./agents/wb-workflow-optimization-expert.md) | 找到瓶颈修复流程自动化一切，让团队效率最大化 |
| 文通通 | `TechnicalDocumentationEngineer` | 单专家 | 完整 | [wb-technical-documentation-engineer](./agents/wb-technical-documentation-engineer.md) | 将复杂技术概念转化为清晰准确的文档，让技术知识可传播 |
| 调度达 | `AgentOrchestrator` | 单专家 | 完整 | [wb-agent-orchestrator](./agents/wb-agent-orchestrator.md) | 精通多智能体系统的编排和协调，让AI团队高效协作 |
| 压测测 | `PerformanceTestingExpert` | 单专家 | 完整 | [wb-performance-testing-expert](./agents/wb-performance-testing-expert.md) | 精通性能测试和基准评估，用数据证明性能改进而非凭感觉 |
| 接口探 | `ApiTestingExpert` | 单专家 | 完整 | [wb-api-testing-expert](./agents/wb-api-testing-expert.md) | 在用户之前发现API的每一个缺陷，确保接口稳定性和正确性 |
| 看板达 | `JiraWorkflowAdmin` | 单专家 | 完整 | [wb-jira-workflow-admin](./agents/wb-jira-workflow-admin.md) | 精通Jira配置和敏捷工作流设计，让工具真正服务于团队效率 |
| 牧羊羊 | `ProjectShepherd` | 单专家 | 完整 | [wb-project-shepherd](./agents/wb-project-shepherd.md) | 温和但坚定地引导项目按计划推进，确保里程碑准时交付 |
| 统筹筹 | `StudioOperationsManager` | 单专家 | 完整 | [wb-studio-operations-manager](./agents/wb-studio-operations-manager.md) | 全面管理工作室日常运营，从资源调配到流程优化 |
| 制片达 | `StudioProducer` | 单专家 | 完整 | [wb-studio-producer](./agents/wb-studio-producer.md) | 统筹项目从立项到交付的全过程，平衡创意预算和时间 |
| 选品品 | `ToolEvaluationExpert` | 单专家 | 完整 | [wb-tool-evaluation-expert](./agents/wb-tool-evaluation-expert.md) | 系统化评估推荐最适合团队的工具，避免浪费时间在错误工具上 |
| 析测测 | `TestResultsAnalyst` | 单专家 | 完整 | [wb-test-results-analyst](./agents/wb-test-results-analyst.md) | 像侦探解读证据一样分析测试结果，发现隐藏的质量问题 |
| 实验通 | `ExperimentTrackingManager` | 单专家 | 完整 | [wb-experiment-tracking-manager](./agents/wb-experiment-tracking-manager.md) | 系统化管理实验全生命周期，确保每个实验有假设有执行有结论 |
| 无碍碍 | `AccessibilityAuditor` | 单专家 | 完整 | [wb-accessibility-auditor](./agents/wb-accessibility-auditor.md) | 按WCAG标准审计界面可访问性，确保每个用户都能使用产品 |
| 截图图 | `EvidenceCollector` | 单专家 | 完整 | [wb-evidence-collector](./agents/wb-evidence-collector.md) | 不放过任何没有截图证据的问题，用视觉证据确保缺陷无处遁形 |
| 验真真 | `RealityChecker` | 单专家 | 完整 | [wb-reality-checker](./agents/wb-reality-checker.md) | 默认认为一切需要更多证据，需要压倒性证据才批准生产就绪 |
| 理文文 | `DocumentProcessingExpert` | 单专家 | 完整 | [wb-document-processing-expert](./agents/wb-document-processing-expert.md) | 文档处理套件：Excel 电子表格、Word 文档、PowerPoint 演示文稿和 PDF 文件的创建、编辑与转换 |
| 端测测 | `WebappTestingExpert` | 单专家 | 完整 | [wb-webapp-testing-expert](./agents/wb-webapp-testing-expert.md) | Web 应用测试助手，引导用户完成 Web 应用的启动、配置和测试流程 |
| 传令令 | `InternalCommsExpert` | 单专家 | 完整 | [wb-internal-comms-expert](./agents/wb-internal-comms-expert.md) | 内部沟通模板专家：状态报告、领导汇报、公司简报、FAQ、事故报告和项目更新 |
| 专业文档生成团队 | `OpenSpecDocTeam` | 专家团 | 完整 | [wb-open-spec-doc-team-lead](./agents/wb-open-spec-doc-team-lead.md)、[wb-open-spec-doc-team-researcher](./agents/wb-open-spec-doc-team-researcher.md)、[wb-open-spec-doc-team-generator](./agents/wb-open-spec-doc-team-generator.md) 等 4 个 | 企业级长文档生成，4角色协作完成深度调研、大纲规划、内容撰写与合规审核全流程 |
| 鹏城信息AI专家 | `AiMeetingNotes` | 单专家 | 受限 | — | 粘贴会议笔记或转写文本，自动提炼摘要、负责人、截止日期与行动项，归档可检索并联动待办清单跟踪执行。 |
| 腾讯云知知识评审专家 | `YunzhiDocQualityExpert` | 单专家 | 受限 | — | 面向云计算产品文档的一站式质量检测：七维体检（时效/结构/链接/排版/写作/货币/合规）+百分制评分+可视化HTML报告。 |
| 送报报 | `ReportDistributionAgent` | 单专家 | 完整 | [wb-report-distribution-agent](./agents/wb-report-distribution-agent.md) | 自动化管理报告生成和分发流程 |

### 法务安全（27）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 律守正 | `LegalComplianceReviewer` | 单专家 | 完整 | [wb-legal-compliance-reviewer](./agents/wb-legal-compliance-reviewer.md) | 确保业务运营和产品功能符合法律法规要求，防范合规风险 |
| 合规规 | `ComplianceAuditor` | 单专家 | 完整 | [wb-compliance-auditor](./agents/wb-compliance-auditor.md) | 全面审计企业运营合规性，确保符合行业标准 |
| 医合合 | `HealthcareMarketingComplianceExpert` | 单专家 | 完整 | [wb-healthcare-marketing-compliance-expert](./agents/wb-healthcare-marketing-compliance-expert.md) | 确保医疗营销内容符合法规要求，守护信息准确性 |
| 链审审 | `BlockchainSecurityAuditor` | 单专家 | 完整 | [wb-blockchain-security-auditor](./agents/wb-blockchain-security-auditor.md) | 专精区块链智能合约和DeFi协议安全审计 |
| 信链链 | `AgentIdentityTrustExpert` | 单专家 | 完整 | [wb-agent-identity-trust-expert](./agents/wb-agent-identity-trust-expert.md) | 构建AI智能体间的身份认证和信任机制 |
| 零知知 | `ZeroKnowledgeProofAdmin` | 单专家 | 完整 | [wb-zero-knowledge-proof-admin](./agents/wb-zero-knowledge-proof-admin.md) | 精通零知识证明技术的应用和管理 |
| 中文法律咨询团 | `ChatLawTeam` | 专家团 | 完整 | [wb-chat-law-team-lead](./agents/wb-chat-law-team-lead.md)、[wb-chat-law-team-info-intake](./agents/wb-chat-law-team-info-intake.md)、[wb-chat-law-team-legal-research](./agents/wb-chat-law-team-legal-research.md) 等 6 个 | 案情采集、法条研究、判例分析、建议撰写，为民事、婚姻、合同、劳动等高频场景出具专业法律咨询报告。 |
| 财税合规专家团 | `TaxComplianceTeam` | 专家团 | 完整 | [wb-tax-compliance-team-lead](./agents/wb-tax-compliance-team-lead.md)、[wb-tax-compliance-team-invoice-processor](./agents/wb-tax-compliance-team-invoice-processor.md)、[wb-tax-compliance-team-voucher-accountant](./agents/wb-tax-compliance-team-voucher-accountant.md) 等 6 个 | 覆盖票据处理、记账核算、报表编制、税务申报、合规审计五大环节的企业财税合规全链路管理专家团 |
| 花叔文档审稿专家 | `HuashuDocReviewer` | 单专家 | 完整 | [wb-huashu-doc-reviewer](./agents/wb-huashu-doc-reviewer.md) | 为「一人公司」打造的 AI 审稿专家。直接在 .docx 原文里加批注气泡和追踪修订，不返回新文档、不破坏原格式。 |
| 企业法务专家团 | `EnterpriseLegalTeam` | 专家团 | 完整 | [wb-enterprise-legal-team-lead](./agents/wb-enterprise-legal-team-lead.md)、[wb-enterprise-legal-team-commercial-contracts-counsel](./agents/wb-enterprise-legal-team-commercial-contracts-counsel.md)、[wb-enterprise-legal-team-corporate-ma-counsel](./agents/wb-enterprise-legal-team-corporate-ma-counsel.md) 等 9 个 | 面向企业法务的多角色专家团，覆盖合同、交易、隐私、产品、监管、AI 治理、雇佣与知识产权分诊。 |
| 诉讼法务专家 | `LitigationLegalExpert` | 单专家 | 完整 | [wb-litigation-legal-expert](./agents/wb-litigation-legal-expert.md) | 面向诉讼律师的案件支持专家，梳理案件、证据、时间线、质证准备、索赔图表和文书草稿。 |
| 法学生陪练 | `LawStudentCoach` | 单专家 | 完整 | [wb-law-student-coach](./agents/wb-law-student-coach.md) | 面向法学生的学习陪练，训练苏格拉底问答、案例摘要、IRAC、课程大纲和律考复习。 |
| 法律诊所督导 | `LegalClinicSupervisor` | 单专家 | 完整 | [wb-legal-clinic-supervisor](./agents/wb-legal-clinic-supervisor.md) | 面向法学院诊所导师的监督助手，支持客户接待、研究启动、期限追踪、学生入职和学期交接。 |
| 法律技能运营官 | `LegalBuilderHubExpert` | 单专家 | 完整 | [wb-legal-builder-hub-expert](./agents/wb-legal-builder-hub-expert.md) | 面向法律运营和技能开发者的治理助手，评估技能来源、工具权限、新鲜度、许可证和信任边界。 |
| 严守约 | `SmbCompliance` | 单专家 | 受限 | — | 小企业客户与合规官，处理客户反馈、客诉工单、CRM清理和合同风险审查 |
| 智能发票专家团 | `InvoiceVerifyWorkbuddy` | 专家团 | 受限 | — | 五位AI专家接力协作，通过上传文件、表格或文件夹，完成识别、税局验真、信用核查与归档 |
| 福帮手 | `FbsirBoardSecretaryAssistant` | 单专家 | 受限 | — | 面向公告、路演、投资者问答、互动回复和沟通稿，在对外使用前做合规红队审查并给出审批下一步。 |
| 小法同学 | `XiaofaLitigationAssistant` | 单专家 | 受限 | — | 诉讼助手：起草起诉状、要素式转换、证据整理、流程指引、强制执行、利息计算。输出 DOCX 格式，Word/WPS 直接编辑。7大法律技能，一站式自助办案。 |
| 腾讯电子签合同法务专家 | `ContractLegalExpert` | 单专家 | 受限 | — | 腾讯电子签合同法务专家擅长合同起草、审查、对比、法规检索，能在线发起签署，劳动/租赁/买卖全场景覆盖 |
| 腾讯云安全专家 | `TcSec` | 单专家 | 受限 | — | 调用云API对容器/主机安全、WAF、云防、云安全中心、堡垒机、密钥管理、数据安全告警/资产进行分析 |
| 法检 Pro | `LegalSearchPro` | 单专家 | 受限 | — | 识别检索意图与场景，按法源位阶检索法规与类案，验证效力评估相似度，适配14种输出可溯源报告。 |
| 何同守 | `ContractExpert` | 单专家 | 受限 | — | 覆盖合同起草、审查、谈判、背景评估与全生命周期管理；专业审查模式一键产出风险清单、审查报告与批注稿。 |
| 营文稳 | `MarketingReviewer` | 单专家 | 受限 | — | 9维度34条规则扫描营销文案，定位广告法与隐私合规风险，输出分级Excel与HTML审查报告。 |
| 权知明 | `IpExpert` | 单专家 | 受限 | — | 覆盖著作权、专利、商标、商业秘密与域名，指引专业库检索，做侵权/FTO/确权分析并输出可落地策略。 |
| 票证核验专家 | `InvoiceVerifyExpert` | 单专家 | 受限 | — | 支持增值税发票、全电发票、区块链发票、机动车销售发票、通行费发票等17种类型的真伪查验与明细解析 |
| 南非法务合规专家 | `SaLegalCompliance` | 单专家 | 受限 | — | 专注南非法务合规领域，覆盖公司注册、合同管理、知识产权保护、数据隐私合规、行业准入与争议解决等关键领域。 |
| AIGC 合规红队 | `FbsirAigcComplianceRedTeam` | 单专家 | 受限 | — | 福帮手 AIGC 发布前对抗审查：核验双标识、违禁词、虚假人设，输出风险等级、法条依据与安全改写。 |

### 行业顾问（35）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 林正刚 | `EntrepreneurshipCoach` | 单专家 | 完整 | [wb-entrepreneurship-coach](./agents/wb-entrepreneurship-coach.md) | 林老师分身+读书伙伴。送《创业可以学》，陪创业者读书，从读书中听痛点，痛点匹配时自然引出课程咨询。擅长GTM落地、敢见客户情绪层突破、顺序判断。 |
| 路小鲜 | `TripStarAgent` | 单专家 | 完整 | [wb-trip-star-agent](./agents/wb-trip-star-agent.md) | 生活服务管家，一站式搞定行程规划、景点/酒店/天气/预算与美团红包领取 |
| 创迪 | `IndieFounderCoach` | 单专家 | 完整 | [wb-indie-founder-coach](./agents/wb-indie-founder-coach.md) | 信奉精益创业与自力更生理念，帮助独立创业者用最少资源从0到1构建可持续盈利事业，覆盖创业全旅程关键决策 |
| AI 刘小排 | `AskLiuxiaopai` | 单专家 | 完整 | [wb-ask-liuxiaopai](./agents/wb-ask-liuxiaopai.md) | Raphael AI 创始人刘小排的数字分身，office-hours 风格陪你拆 idea：钉死具体的人、真痛点、第一笔钱、第一批用户在哪，再给一件今晚就能… |
| 运势分析师 | `FortuneConsultant` | 单专家 | 完整 | [wb-fortune-consultant](./agents/wb-fortune-consultant.md) | 传统命理参考工具——八字紫微排盘、塔罗梅花起卦、农历黄历查询，多体系交叉参考，仅供娱乐。 |
| 一人公司专家团 | `OpcTeam` | 专家团 | 完整 | [wb-opc-team-lead](./agents/wb-opc-team-lead.md)、[wb-opc-team-resource-auditor](./agents/wb-opc-team-resource-auditor.md)、[wb-opc-team-niche-strategist](./agents/wb-opc-team-niche-strategist.md) 等 9 个 | 基于由Easy创作的《一人企业方法论》，9位专家陪你走完从资源盘点、利基定位到MVP、转化、复盘的一人公司全流程共创 |
| 小企业经营团队 | `SmbTeam` | 专家团 | 受限 | — | 经营总管调度四位领域专家，覆盖财务、营收、客户合规和运营，小企业管理一站搞定 |
| ChaoGeek 0x孔明 | `ChaogeekKongming` | 单专家 | 受限 | — | 一人公司认知反缴械思维搭子：少问但问到根，补上下文、对齐意图，帮你驾驭智能体不外包判断力。 |
| 行业场景研究员 | `FbsirIndustrySceneResearcher` | 单专家 | 受限 | — | 围绕一个行业场景定位关键工作流缺口，并交付补位卡、3天行动计划、项目动作执行包和下一步建议。 |
| 专业高考顾问 | `GaokaoAdvisor` | 单专家 | 受限 | — | 辅助检索高考知识库并调用分数线、一分一段能力，整理带来源的真题、高校专业和志愿参考；同时提供全流程志愿填报引导，产出可转发的腾讯文档志愿报告 |
| KET备考专家团 | `KetPrepTeam` | 专家团 | 受限 | — | 剑桥认证考官领衔，为小学生提供KET全流程备考：学情测评、词汇语法地基、听说读写专项提分、考前冲刺模考，助力Merit（优秀）/Distinction（卓越）… |
| 马滢老师 | `FamilyEducationMa` | 单专家 | 受限 | — | 腾讯未保营地8年一线实践，融合三大循证体系，为家长提供亲子沟通、沉迷干预、家庭成长咨询 |
| 蜕变践行者 | `MetamorphosisPractitioner` | 单专家 | 受限 | — | 不是导师，是走过你想走的路的人。通过分享创业经历帮创业者觉醒心态问题，不说教只分享，让用户自己感悟。 |
| 福帮手 | `LiuxueYanxueExpert` | 单专家 | 受限 | — | 面向家庭生成留学研学首轮规划，兼顾高考窗口、预算风险、路径备选与后续承接行动建议。 |
| 终端老兵专家（陈丰伟） | `TerminalVeteran` | 单专家 | 受限 | — | 近三十年终端老兵，11条铁律+三层方法论，厂商策略/渠道选品/投资分析+行业报告 |
| 超级合伙人\|魔镜行动 | `FbsirSuperPartner` | 单专家 | 受限 | — | 带上目标或真实材料，立即得到可使用成品；宿主能力可用且获授权时执行并回执，再做72小时裁决。 |
| 选题顾问（WANFANG TOPIC） | `PaperTopicSelection` | 专家团 | 受限 | — | 基于万方数据帮你做论文选题：检索文献、推荐方向、评估新颖性、生成标题、出领域报告。说学科方向即可。 |
| 独董会 | `FbsirEightSeatBoard` | 专家团 | 受限 | — | 福帮手经营决策独立审议专家团｜按案组建必要席位，独立判断、交叉质询、保留异议，交付可追溯行动备忘录 |
| 技术公益专家团 | `SkillhubCharityExpertTeam` | 专家团 | 受限 | — | 星星带领六位专家，覆盖公益技能或Agent专家的需求分析、编写、测试评审、版权确认与打包交付全流程。 |
| 生辰命理大师 | `FortuneMaster` | 单专家 | 受限 | — | 用规则引擎精确排盘八字、紫微、奇门、六爻，再由AI理性解读，助你审慎看待人生格局与运势决策。 |
| 懒人出游规划师 | `LazyTravelPlanner` | 单专家 | 受限 | — | 专注国内3-7天2-4人自由行，整合实时口碑与一手数据，一站式产出含地图、预算与防坑的可落地行程书。 |
| 私人健身教练 | `PersonalFitnessCoach` | 单专家 | 受限 | — | 专业务实的私人健身教练，制定可执行的训练计划、动作指导与饮食宏量方案，安全第一，鼓励但不废话。 |
| 学习规划师 | `StudyPlanner` | 单专家 | 受限 | — | 严格导师+效率工具，帮你把模糊的备考目标变成可执行、可追踪、可调整的学习计划，不废话，只做实事。 |
| 看球搭子 | `WorldcupBuddy` | 单专家 | 受限 | — | 陪你看2026世界杯，懂球随性有料：查赛程比分、赛后复盘，还能算胜率、爆冷概率和晋级形势。 |
| 文博领域AI顾问 | `TanyuanCulturalHeritageExpert` | 单专家 | 受限 | — | 基于腾讯探元文博知识库，提供文物与世界遗产查询、知识问答、文物对比、文博攻略及研学方案等专业服务。 |
| 丁笃行 | `ConsultingPartners` | 单专家 | 受限 | — | 假设驱动的战略顾问，按需破题、取证、测算与撰写，产出证据扎实的决策报告与专业级PPT |
| 求职陪跑团 | `JobCompanionTeam` | 专家团 | 受限 | — | 5 角色陪跑型专家团，7 阶段接力覆盖自我盘点、目标定位、简历打磨、面试陪练、谈薪决策与入职复盘全流程。 |
| 门头沟营商顾问 | `MentougouBusinessGuide` | 单专家 | 受限 | — | 门头沟区营商政策专家，提供免费注册地址、税收筹划、补贴匹配、人才政策等一站式创业咨询服务 |
| 磐石CRM跟进拜访助手 | `PanshiCustomerVisitAgent` | 单专家 | 受限 | — | 磐石官方AI助手，查询跟进与拜访打卡，将iWiki/腾讯文档/企微文档或粘贴文本录入磐石CRM。 |
| South African Strategy | `SouthAfricaStrategyAdvisor` | 单专家 | 受限 | — | 专注南非市场的战略顾问，覆盖宏观环境、产业趋势、投资选址、进入模式与风险评估，提供数据驱动决策支持。 |
| VN Pub Affair | `VietnamPublicAffairs` | 单专家 | 受限 | — | 精通越南政府关系、政策解读、监管沟通、行业协会、公共舆论、社会责任、媒体关系和危机公关 |
| 青创领航员 | `InnovationStartupMentor` | 单专家 | 受限 | — | 以落地五关与最小闭环法，帮大学生把双创项目从想法推到落地：痛点验证、商业补全、评委预检，步步可执行。 |
| 福帮手 | `FbsirSuperIndependentBoard` | 单专家 | 受限 | — | 单一AI独立决策审议官，非法定董事会；挑战偏见、核验证据，交付可执行、可复审的决策产物。 |
| 欧明智 | `WorkbuddyUniversalMentor` | 单专家 | 受限 | — | WorkBuddy实战教练：覆盖入门引导、场景匹配、实战案例、Skill开发与自动化答疑全链路。 |
| 轻松出行 | `TcChengxinTravelExpert` | 单专家 | 受限 | — | 同程官方服务，可一键领取优惠券和红包，查询机票、火车、酒店、景点、规划旅行。我会结合实时旅行资源与账号权益，为您快速找到合适的出行选择，让每一次出发更简单、更… |

### 全球发展（21）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 埃及市场营销专家 | `EgyptMarketing` | 单专家 | 受限 | — | 中国企业出海埃及的CMO级营销引擎，覆盖数字生态、斋月营销、品牌本地化、消费者洞察与ROI预估全链路 |
| Sg Finance & Tax | `SgFinanceTax` | 单专家 | 受限 | — | 精通企业在新加坡经营中的税务、会计、银行、融资、外汇、支付、审计、补贴、保险和财务规划等内容 |
| 巴西商务拓展专家 | `BrazilCompanyQuery` | 单专家 | 受限 | — | 排查巴西企业工商与信用风险，尽调专利商标知识产权，分析市场拓展路径，降低商务拓展风险。 |
| Malaysia HR & Administration | `MalaysiaHrAdmin` | 单专家 | 受限 | — | 精通马来西亚招聘、劳动合同、薪酬福利、签证工签与社保，服务企业跨境人力行政咨询。 |
| Sg Business | `SgBizDev` | 单专家 | 受限 | — | 帮助企业在新加坡发现客户、伙伴、渠道、供应商与代理商，对接园区、展会、招商及确认市场进入路径 |
| Sg HR & Admin | `SgHrAdminExpert` | 单专家 | 受限 | — | 精通新加坡当地招聘、劳动合同、薪酬福利、签证工签、社保、办公场地、行政流程和员工管理等内容。 |
| Brazil Finance & Tax Expert | `BrazilRfbExpert` | 单专家 | 受限 | — | 服务企业出海巴西的财税全周期：本地补贴、税制设计、跨境资金规划与日常合规，内置完整财税政策。 |
| 阿联酋公共事务专家 | `UaePublicAffairs` | 单专家 | 受限 | — | 专注阿联酋政府关系、政策解读与监管沟通，为中企及投资机构提供专业公共事务咨询与风险评估服务。 |
| Egypt Public Affairs | `EgyptPublicAffairs` | 单专家 | 受限 | — | 精通埃及政府关系、政策解读、监管沟通、行业协会、危机公关和舆情管理，服务企业一站式公共事务咨询。 |
| Brazil Legal Expert | `BrazilLegal` | 单专家 | 受限 | — | 巴西公司注册、合同审查、知识产权、产品准入、劳动用工、数据合规及争议解决，助力企业合规出海巴西。 |
| UAE Marketing Expert | `UaeMarketingAdvisor` | 单专家 | 受限 | — | 覆盖阿联酋不同地区差异化营销。覆盖消费者画像、品牌本土化、渠道策略与用户增长，生成营销海报视频。 |
| 印尼法务合规专家 | `IndonesiaDigitalLawExpert` | 单专家 | 受限 | — | 聚焦外商投资、数据合规与商业交易，打通营商审批、金融监管与知识产权保护链路，赋能跨境SaaS与AI等新兴赛道全流程印尼法务保障。 |
| 泰国市场营销专家 | `ThaiMarketingCreative` | 单专家 | 受限 | — | 整合全链路用户洞察与行为决策，锚定本土松弛悦己情绪切口，打通泰语市场转化路径，输出泰国市场营销方案。 |
| 大马营销通 | `MalaysiaMarketing` | 单专家 | 受限 | — | 深谙马来西亚文化与宗教，覆盖消费者画像、品牌本地化、社媒投放与用户增长，生成营销海报与短视频。 |
| Malaysia Legal & Compliance | `MalaysiaLegal` | 单专家 | 受限 | — | 精通马来西亚公司注册、合同、知识产权、行业准入与数据合规，服务跨境法务合规咨询。 |
| 印尼商务拓展专家 | `IndonesiaBdExpert` | 单专家 | 受限 | — | 整合全链路客供与渠道资源，洞察园区展会招商契机，锚定市场进入路径，打造产业合作生态与合规风控护航。 |
| Indo Pub Affair | `IndonesiaPaExpert` | 单专家 | 受限 | — | 剖析印尼政商生态与合规风险，整合政策解读危机公关，融合本土宗教文化，输出落地GR策略。 |
| Thai HR&Admin | `ThailandHrAdmin` | 单专家 | 受限 | — | 精通泰国劳动法(LPA)、外籍员工工签合规、薪酬福利设计与本土职场文化适配，护航中资企业出海泰国全周期人力行政 |
| 阿联酋战略顾问专家 | `UaeStrategicAdvisor` | 单专家 | 受限 | — | 研判阿联酋七酋长国宏观环境与产业趋势，对比竞合格局与投资选址，评估进入模式与风险，输出出海战略建议 |
| 马来西亚财税金融专家 | `MalaysiaFinanceTax` | 单专家 | 受限 | — | 精通马来西亚税务、银行、外汇、审计、补贴、保险、伊斯兰金融及财政分析的财税金融全栈专家。 |
| Egypt Strategic Advisory | `EgyptStrategicAdvisory` | 单专家 | 受限 | — | 精通埃及宏观环境、产业趋势、竞争格局和风险管控，提供投资选址、进入模式和长期布局决策建议。 |

### 本地安装（3）

| 专家 | ID | 类型 | 状态 | Agent | 简介 |
|---|---|---|---|---|---|
| 腾讯轻量云专家 | `local:lighthouse-ops` | 单专家 | 完整 | [wb-local-lighthouse-ops](./agents/wb-local-lighthouse-ops.md) | Tencent Lighthouse Expert: quickly create Lighthouse servers with instance quer… |
| 商家宣传设计师 | `local:promo-page-designer` | 单专家 | 完整 | [wb-local-promo-page-designer](./agents/wb-local-promo-page-designer.md) | Designs promo pages and sales-report posters for merchants of any size or platf… |
| 企鹅教师助手 | `local:teaching-design-expert` | 单专家 | 完整 | [wb-local-teaching-design-expert](./agents/wb-local-teaching-design-expert.md) | An integrated teaching-design dispatcher expert for China's compulsory-educatio… |

## 受限专家

以下 199 个专家没有公开提示词，只有元数据；应用通过登录态门户下载，匿名请求返回 401。

| 专家 | ID | 类型 | 可见性 | 原因 |
|---|---|---|---|---|
| 钱守通 | `SmbFinance` | 单专家 | all | OPC / 开放平台包，需登录态门户下载 |
| 甄客来 | `SmbRevenue` | 单专家 | all | OPC / 开放平台包，需登录态门户下载 |
| 严守约 | `SmbCompliance` | 单专家 | all | OPC / 开放平台包，需登录态门户下载 |
| 毕运营 | `SmbOperations` | 单专家 | all | OPC / 开放平台包，需登录态门户下载 |
| 小企业经营团队 | `SmbTeam` | 专家团 | all | 缺少主理人提示词 |
| 爆款炼金师 | `ViralTopicMaster` | 单专家 | — | 整包未公开，门户下载需登录 |
| 刺桐说Pro-投资社群嘉宾团 | `Citongshuopro` | 专家团 | — | 缺少主理人提示词 |
| 智能发票专家团 | `InvoiceVerifyWorkbuddy` | 专家团 | — | 缺少主理人提示词 |
| 爆量君 | `JiayiAdsAnalyticsExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 吟游诗人基德创作专家 | `KiddContentExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| ChaoGeek 0x孔明 | `ChaogeekKongming` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 计算机等级考试专家团 | `NcreExpert` | 专家团 | — | 缺少主理人提示词 |
| MVP开发专家团 | `MvpDevExpertTeam` | 专家团 | — | 缺少主理人提示词 |
| 行业场景研究员 | `FbsirIndustrySceneResearcher` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 福帮手 | `FbsirBoardSecretaryAssistant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 专业高考顾问 | `GaokaoAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 万方数据 | `AcademicJournalSelector` | 专家团 | — | 缺少主理人提示词 |
| KET备考专家团 | `KetPrepTeam` | 专家团 | — | 缺少主理人提示词 |
| 通达信诊断师 | `TdxStockDiagnostician` | 单专家 | — | 整包未公开，门户下载需登录 |
| 通达信选股猎手 | `TdxStockHunter` | 单专家 | — | 整包未公开，门户下载需登录 |
| 通达信评估师 | `TdxValueAssessor` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 天御金融反诈 | `AntiScamAgent` | 单专家 | all | 整包未公开，门户下载需登录 |
| 40-20 外卖券 | `MeituanLivingAssistant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 科技侠来了 | `TopicEvaluator` | 单专家 | — | 整包未公开，门户下载需登录 |
| 腾讯云API专家 | `TencentcloudApi` | 单专家 | — | 整包未公开，门户下载需登录 |
| 福帮手 | `LongManuscriptExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 苍何 | `GeoDiagnosisExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 小法同学 | `XiaofaLitigationAssistant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 腾讯电子签合同法务专家 | `ContractLegalExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 天御营销保护 | `TianyuMarketingGuardian` | 单专家 | — | 整包未公开，门户下载需登录 |
| 天御账号保护 | `TianyuAccountGuardian` | 单专家 | — | 整包未公开，门户下载需登录 |
| i人事-利唐智语AI面谈官 | `IhrConference` | 单专家 | — | 整包未公开，门户下载需登录 |
| 马滢老师 | `FamilyEducationMa` | 单专家 | — | 整包未公开，门户下载需登录 |
| Makers 开发专家团 | `EdgeoneMakersExperts` | 专家团 | — | 缺少主理人提示词 |
| 腾讯云安全专家 | `TcSec` | 单专家 | — | 整包未公开，门户下载需登录 |
| 车赢赢 | `AutoConsultant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 蜕变践行者 | `MetamorphosisPractitioner` | 单专家 | — | 整包未公开，门户下载需登录 |
| 法检 Pro | `LegalSearchPro` | 单专家 | — | 整包未公开，门户下载需登录 |
| 懂秘 | `NewsBuddy` | 单专家 | — | 整包未公开，门户下载需登录 |
| 福帮手 | `LiuxueYanxueExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 何同守 | `ContractExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 营文稳 | `MarketingReviewer` | 单专家 | — | 整包未公开，门户下载需登录 |
| 星辰 | `SmartStockAnalyst` | 单专家 | — | 整包未公开，门户下载需登录 |
| 埃及市场营销专家 | `EgyptMarketing` | 单专家 | — | 整包未公开，门户下载需登录 |
| 汽车行业内容创作专家团 | `ContentCreationExpertProd` | 专家团 | — | 缺少主理人提示词 |
| Sg Finance & Tax | `SgFinanceTax` | 单专家 | — | 整包未公开，门户下载需登录 |
| 巴西商务拓展专家 | `BrazilCompanyQuery` | 单专家 | — | 整包未公开，门户下载需登录 |
| Malaysia HR & Administration | `MalaysiaHrAdmin` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 把专业内容画给外行看懂 | `VibeknowHanddraw` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `YahooFinanceCli` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| Sg Business | `SgBizDev` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `ResumeAssistant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `ApiDev` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `PromptEngineeringExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `InterviewSimulator` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `DevPipelineOrchestrator` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `GameDevelopmentStudio` | 专家团 | — | 缺少主理人提示词 |
| 鹏城信息AI专家 | `Eno` | 单专家 | — | 整包未公开，门户下载需登录 |
| AI编程方法论专家 | `SuperpowersZh` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `AiHumanizer` | 单专家 | — | 整包未公开，门户下载需登录 |
| AI师傅 | `AiShifu` | 单专家 | all | 整包未公开，门户下载需登录 |
| MAI Lab并购交易Agent | `MaiDealAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 贝锐花生壳 | `HskDevopsExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 终端老兵专家（陈丰伟） | `TerminalVeteran` | 单专家 | — | 整包未公开，门户下载需登录 |
| Cordys CRM 助手 | `CordysCrm` | 单专家 | — | 整包未公开，门户下载需登录 |
| Sg HR & Admin | `SgHrAdminExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 同舟股市投研专家 | `FinResearchExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| Brazil Finance & Tax Expert | `BrazilRfbExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 阿联酋公共事务专家 | `UaePublicAffairs` | 单专家 | — | 整包未公开，门户下载需登录 |
| Egypt Public Affairs | `EgyptPublicAffairs` | 单专家 | — | 整包未公开，门户下载需登录 |
| Brazil Legal Expert | `BrazilLegal` | 单专家 | — | 整包未公开，门户下载需登录 |
| UAE Marketing Expert | `UaeMarketingAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 印尼法务合规专家 | `IndonesiaDigitalLawExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 泰国市场营销专家 | `ThaiMarketingCreative` | 单专家 | — | 整包未公开，门户下载需登录 |
| 大马营销通 | `MalaysiaMarketing` | 单专家 | — | 整包未公开，门户下载需登录 |
| Malaysia Legal & Compliance | `MalaysiaLegal` | 单专家 | — | 整包未公开，门户下载需登录 |
| 权知明 | `IpExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 印尼商务拓展专家 | `IndonesiaBdExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| DataBrain | `DatabrainAgentV2` | 单专家 | — | 整包未公开，门户下载需登录 |
| Indo Pub Affair | `IndonesiaPaExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| Thai HR&Admin | `ThailandHrAdmin` | 单专家 | — | 整包未公开，门户下载需登录 |
| 阿联酋战略顾问专家 | `UaeStrategicAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 马来西亚财税金融专家 | `MalaysiaFinanceTax` | 单专家 | — | 整包未公开，门户下载需登录 |
| Egypt Strategic Advisory | `EgyptStrategicAdvisory` | 单专家 | — | 整包未公开，门户下载需登录 |
| 腾讯健康NGES医药营销专家团 | `NgesHealthcareMarketingTeam` | 专家团 | all | 缺少主理人提示词 |
| 小花创意 | `DesignPrototypeExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 鹏城信息AI专家 | `Code` | 单专家 | — | 整包未公开，门户下载需登录 |
| 腾讯云安全运营专家 | `Soe` | 单专家 | — | 整包未公开，门户下载需登录 |
| 超级合伙人\|魔镜行动 | `FbsirSuperPartner` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `Frontend` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `AiMeetingNotes` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `MarketAnalysisCn` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `DatabaseOperations` | 单专家 | — | 整包未公开，门户下载需登录 |
| 一站式视频创作专家 | `ChatcutVideoEditor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `NovelGenerator` | 单专家 | — | 整包未公开，门户下载需登录 |
| 腾讯健康-觅影-眼底彩照疾病分析专家 | `FundusDiseaseAnalysis` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `ContentWriter` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `AiVideoScript` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `ArxivWatcher` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹏城信息AI专家 | `FrontendSlides` | 单专家 | — | 整包未公开，门户下载需登录 |
| 选题顾问（WANFANG TOPIC） | `PaperTopicSelection` | 专家团 | — | 缺少主理人提示词 |
| 腾讯健康药箱-私域患教内容审核助手 | `PatientEducationContentReviewWordAssistant` | 单专家 | — | 整包未公开，门户下载需登录 |
| 独董会 | `FbsirEightSeatBoard` | 专家团 | all | 缺少主理人提示词 |
| UU跑腿 | `UuptDelivery` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 金数据 | `JinshujuExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 技术公益专家团 | `SkillhubCharityExpertTeam` | 专家团 | — | 缺少主理人提示词 |
| CloudQ | `SdkLogExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| DataBrain舆情分析专家 | `DatabrainOpinionExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 逐页讲解，一键成片 | `VibeknowPptExplain` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 一份文档，排成一条成片 | `VibeknowDesignVideo` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| AI面试官 | `IhrAiInterviewer` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsBioinfoExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsCdgptExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsDiagnosisExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsHpcExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsIggmExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsOriExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsScbertExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsScproteinExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 组小学 | `OmicsTfoldExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 女娲 | `Nuwa` | 单专家 | external_only | 仅外部渠道（external_only） |
| 投标策略师 | `BiddingStrategist` | 单专家 | external_only | 仅外部渠道（external_only） |
| 生辰命理大师 | `FortuneMaster` | 单专家 | external_only | 仅外部渠道（external_only） |
| 懒人出游规划师 | `LazyTravelPlanner` | 单专家 | external_only | 仅外部渠道（external_only） |
| 新闻资讯专家 | `NewsBriefingExpert` | 单专家 | external_only | 仅外部渠道（external_only） |
| 小说故事创作专家 | `NovelCreator` | 单专家 | external_only | 仅外部渠道（external_only） |
| 私人健身教练 | `PersonalFitnessCoach` | 单专家 | external_only | 仅外部渠道（external_only） |
| 个人知识库架构师 | `PersonalKnowledgeArchitect` | 单专家 | external_only | 仅外部渠道（external_only） |
| 提示词工程师 | `PromptEngineer` | 单专家 | external_only | 仅外部渠道（external_only） |
| 学习规划师 | `StudyPlanner` | 单专家 | external_only | 仅外部渠道（external_only） |
| 看球搭子 | `WorldcupBuddy` | 单专家 | external_only | 仅外部渠道（external_only） |
| 基金投研分析师 | `FundResearchAnalyst` | 单专家 | — | 整包未公开，门户下载需登录 |
| Python 全栈工程师 | `PythonFullstackEngineer` | 单专家 | — | 整包未公开，门户下载需登录 |
| 热点猎手 | `TrendHunter` | 单专家 | — | 整包未公开，门户下载需登录 |
| 微信视频号运营策略师 | `WechatChannelsStrategist` | 单专家 | — | 整包未公开，门户下载需登录 |
| 文博领域AI顾问 | `TanyuanCulturalHeritageExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 相信光么 | `BelieveInLight` | 专家团 | — | 缺少主理人提示词 |
| 丁笃行 | `ConsultingPartners` | 单专家 | — | 整包未公开，门户下载需登录 |
| 鹅厂职业经纪人 | `CareerBroker` | 单专家 | — | 整包未公开，门户下载需登录 |
| 表单管理专家 | `JinshujuFormExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| AI表格专家 | `JinshujuTableExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 腾讯健康-觅影-肺部CT影像的肺炎辅助评估专家 | `PneumoniaAiAnalyst` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 卡仔 | `NgoChallengeAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| 新股专家 | `NewShareExpert` | 单专家 | all | 整包未公开，门户下载需登录 |
| 票证核验专家 | `InvoiceVerifyExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 资本市场路演研究团 | `RoadshowResearchTeam` | 专家团 | — | 缺少主理人提示词 |
| DataBrain X TideRider | `TideriderSentiment` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 福帮手 | `IndustrialParkInvestmentAttractionExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| 求职陪跑团 | `JobCompanionTeam` | 专家团 | — | 缺少主理人提示词 |
| 天御对公信贷 | `CorpCreditDueDiligence` | 单专家 | — | 整包未公开，门户下载需登录 |
| 小Q | `QingflowHrExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 门头沟营商顾问 | `MentougouBusinessGuide` | 单专家 | — | 整包未公开，门户下载需登录 |
| 磐石CRM跟进拜访助手 | `PanshiCustomerVisitAgent` | 单专家 | — | 整包未公开，门户下载需登录 |
| 科研专家团 | `EmpiricalResearchTeam` | 专家团 | — | 缺少主理人提示词 |
| South African Strategy | `SouthAfricaStrategyAdvisor` | 单专家 | — | 整包未公开，门户下载需登录 |
| South Africa HR | `SouthAfricaHrAdmin` | 单专家 | — | 整包未公开，门户下载需登录 |
| Vietnam Finance & Tax Expert | `VietnamFinanceTaxExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| VN Pub Affair | `VietnamPublicAffairs` | 单专家 | — | 整包未公开，门户下载需登录 |
| 南非法务合规专家 | `SaLegalCompliance` | 单专家 | — | 整包未公开，门户下载需登录 |
| 营销增长专家团 | `MarketingGrowthTeam` | 专家团 | — | 缺少主理人提示词 |
| 技能匠人 | `SkillSmith` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 腾讯云报价助手 | `TencentCloudQuoteAssistant` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 青创领航员 | `InnovationStartupMentor` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| HR数智专家 | `HrDigitalExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| AIGC 合规红队 | `FbsirAigcComplianceRedTeam` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 社交搭子 | `CampusConversationCoach` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 活动操盘手 | `CampusEventNavigator` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 求职冲刺 | `CampusJobSearchCoach` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 生涯领航员 | `CareerNavigator` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 小修同学 | `ComputerOperationsAdvisor` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| Evan老师 | `EnglishWritingCoach` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 备考军师 | `ExamPreparationPlanner` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 小记同学 | `NoteClassRepresentative` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 学运趋势解读师 | `StudyFortuneCompass` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 论小舟 | `ThesisWritingMentor` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 福帮手 | `FbsirSuperIndependentBoard` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 欧明智 | `WorkbuddyUniversalMentor` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 福帮手 | `FbsirMomDialogueExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 秘宝 | `MibaoMediaArchivist` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 贴图头条 | `TietuToutiao` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 福帮手 | `FbsirBeikeYi` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| Linkfox | `LinkfoxExpertAmazonListingSpecialist` | 单专家 | — | 整包未公开，门户下载需登录 |
| AI尽调专家团 | `DdDueDiligenceTeam` | 专家团 | — | 缺少主理人提示词 |
| 轻松出行 | `TcChengxinTravelExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 贝安 | `AbExperimentAnalyst` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 绩效管理专家 | `PerfManagementExpert` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 阿拉丁 | `AladinTestDesign` | 单专家 | internal_only | 仅内部可见（internal_only） |
| CPQ 报价专家 | `Cpq` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 流通通 | `WorkflowAssistant` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 觅诊 | `MiZhenExpert` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 哈勃AI评测专家 | `HubbleEvalExpert` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 腾讯云知（乐享） | `LexiangPptExpert` | 单专家 | internal_only | 仅内部可见（internal_only） |
| AICoding 架构专家团 | `AicodingArchitectureExpertTeam` | 专家团 | — | 缺少主理人提示词 |
| 小T HR智能助手 | `Xiaot` | 单专家 | internal_only | 仅内部可见（internal_only） |
| 问图 | `Wentu` | 单专家 | — | 整包未公开，门户下载需登录 |
| 庄老师 | `FamilyEducationCoach` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 甄需明 | `CloudRequirementExpert` | 单专家 | — | OPC / 开放平台包，需登录态门户下载 |
| 腾讯云知知识评审专家 | `YunzhiDocQualityExpert` | 单专家 | — | 整包未公开，门户下载需登录 |
| MigraQ | `MigraQExpert` | 单专家 | external_only | 仅外部渠道（external_only） |

## 启用方式

这个目录默认不会被 kimi-code 自动扫描。需要全部加载时，在 `config.toml` 顶层加：

```toml
extra_agent_dirs = ["workbuddy-agents-all/agents"]
```

也可以只把需要的 `agents/<name>.md` 复制到 `.agents/agents/workbuddy/`。全部加载会引入数百个 Agent，主 Agent 的选择成本会明显上升；日常建议只启用工程向的 13 个。

两级路由：`/skill:workbuddy-expert 代码 SeniorDeveloper`；skill 位于 `.agents/skills/workbuddy-expert/`，按“分类 → 专家 ID”加载对应提示词。

## 说明

- `agents/<name>.md` 是生成的 Kimi Code Agent；`catalog.json` 是机器可读全量目录。
- 所有 Agent 都显式声明了 `tools` 和 `subagents`；权限按角色分类。
- 专家团成员会作为独立 Agent 生成，主理人的 `subagents` 只列出实际可用的成员。
- 受限专家没有生成占位 Agent，避免把空壳加入目录。
