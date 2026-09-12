//! 常驻多智能体生命周期与 Team 轮次协商编排器。

use crate::native::event_store::{EventStore, RawWireEvent};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// 子代理初始化配置
#[derive(Debug, Clone)]
pub struct SubagentConfig {
    pub id: String,
    pub system_prompt: String,
    pub max_turns: usize,
}

/// 常驻子代理操作句柄
pub struct SubagentHandle {
    pub id: String,
    tx: mpsc::Sender<String>,
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<String>>>,
    worker_task: Arc<JoinHandle<()>>,
}

impl SubagentHandle {
    /// 向常驻子代理发送驱动消息
    pub async fn send_message(
        &self,
        message: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.tx
            .send(message.to_string())
            .await
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
        Ok(())
    }

    /// 轮询子代理响应，支持外部等待
    pub async fn poll_response(&self) -> Option<String> {
        let mut rx = self.rx.lock().await;
        rx.recv().await
    }

    /// 强制终止子代理后台任务
    pub fn abort(&self) {
        self.worker_task.abort();
    }
}

/// 常驻子代理调度管理器
pub struct PersistentSubagentManager {
    store: Arc<dyn EventStore>,
}

impl PersistentSubagentManager {
    /// 创建调度管理器
    pub fn new(store: Arc<dyn EventStore>) -> Self {
        Self { store }
    }

    /// 生成常驻长生命周期子代理
    pub fn spawn_persistent(&self, config: SubagentConfig) -> SubagentHandle {
        let (in_tx, mut in_rx) = mpsc::channel::<String>(32);
        let (out_tx, out_rx) = mpsc::channel::<String>(32);
        let agent_id = config.id.clone();
        let store = Arc::clone(&self.store);

        let worker_task = tokio::spawn(async move {
            let mut turn_count = 0;
            while let Some(msg) = in_rx.recv().await {
                if turn_count >= config.max_turns {
                    let _ = out_tx.send("[Aborted: Turn limit reached]".into()).await;
                    break;
                }

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;

                // 记录进入子代理专用事件存储流，捕获并记录错误，保证 worker 健壮不崩溃
                if let Err(e) = store.append_event(&RawWireEvent {
                    id: ulid::Ulid::new().to_string(),
                    session_id: agent_id.clone(),
                    event_type: "subagent.message".into(),
                    payload: serde_json::json!({ "content": msg }),
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: now,
                }) {
                    tracing::error!("Failed to record subagent event for {}: {:?}", agent_id, e);
                }

                let response = format!("Subagent [{}] executed step: Ack '{}'", agent_id, msg);
                turn_count += 1;

                if out_tx.send(response).await.is_err() {
                    break;
                }
            }
        });

        SubagentHandle {
            id: config.id,
            tx: in_tx,
            rx: Arc::new(tokio::sync::Mutex::new(out_rx)),
            worker_task: Arc::new(worker_task),
        }
    }

    /// 原生实现 Team 轮次协商调度器，带单步超时保护
    pub async fn run_team_round_robin(
        &self,
        agents: &[SubagentHandle],
        initial_prompt: &str,
        rounds: usize,
    ) -> Vec<String> {
        let mut transcript = Vec::new();
        let mut current_input = initial_prompt.to_string();

        for _ in 0..rounds {
            for agent in agents {
                if agent.send_message(&current_input).await.is_ok() {
                    let poll_future = agent.poll_response();
                    if let Ok(Some(reply)) =
                        tokio::time::timeout(Duration::from_secs(15), poll_future).await
                    {
                        current_input = reply.clone();
                        transcript.push(format!("{}: {}", agent.id, reply));
                    } else {
                        transcript.push(format!("{}: [Timeout waiting for response]", agent.id));
                    }
                }
            }
        }
        transcript
    }

    /// 四阶段结构化辩论编排实现（参考 TS debate-coordinator.ts 阶段流程）
    pub async fn run_structured_debate(
        &self,
        agents: &[SubagentHandle],
        topic: &str,
    ) -> Vec<(DebateStage, String, String)> {
        let mut debate_log = Vec::new();
        let stages = [
            DebateStage::Opening,
            DebateStage::FreeDebate,
            DebateStage::Closing,
            DebateStage::Consensus,
        ];

        let mut current_context = format!("Debate topic: {}", topic);

        for stage in stages {
            for agent in agents {
                let prompt = format!("[Stage: {:?}] Current context: {}", stage, current_context);
                if agent.send_message(&prompt).await.is_ok() {
                    let poll_future = agent.poll_response();
                    if let Ok(Some(reply)) =
                        tokio::time::timeout(Duration::from_secs(15), poll_future).await
                    {
                        current_context = reply.clone();
                        debate_log.push((stage, agent.id.clone(), reply));
                    } else {
                        debate_log.push((
                            stage,
                            agent.id.clone(),
                            "[Timeout waiting for argument]".into(),
                        ));
                    }
                }
            }
        }

        debate_log
    }

    /// 运行结构化辩论并提炼共识度与跨智能体引用图谱
    pub async fn run_debate_with_consensus(
        &self,
        agents: &[SubagentHandle],
        topic: &str,
    ) -> (
        Vec<(DebateStage, String, String)>,
        ConsensusEvaluation,
        Vec<AgentMention>,
    ) {
        let logs = self.run_structured_debate(agents, topic).await;
        let mentions = extract_cross_references(&logs);
        let evaluation = evaluate_consensus(&logs);
        (logs, evaluation, mentions)
    }

    /// 运行带角色身份与立场驱动的四阶段结构化辩论编排
    pub async fn run_structured_debate_with_roles(
        &self,
        agents: &[SubagentHandle],
        participants: &[DebateParticipant],
        topic: &str,
    ) -> Vec<(DebateStage, String, String)> {
        let mut debate_log = Vec::new();
        let stages = [
            DebateStage::Opening,
            DebateStage::FreeDebate,
            DebateStage::Closing,
            DebateStage::Consensus,
        ];

        let mut transcript_so_far = String::new();

        for stage in stages {
            for (idx, agent) in agents.iter().enumerate() {
                let p = participants.get(idx);
                let role = p.map(|x| x.role.as_str()).unwrap_or("Participant");
                let stance = p.and_then(|x| x.stance.as_deref()).unwrap_or("Neutral");

                let prompt = match stage {
                    DebateStage::Opening => {
                        format!(
                            "[Stage: Opening]\nTopic: {}\nYour Role: {}\nAssigned Stance: {}\nTask: Present your opening position clearly, stating your primary arguments and core assumptions.",
                            topic, role, stance
                        )
                    }
                    DebateStage::FreeDebate => {
                        format!(
                            "[Stage: FreeDebate]\nTopic: {}\nYour Role: {}\nAssigned Stance: {}\nDebate transcript so far:\n{}\nTask: Challenge or support points made by others (mentioning @agent_id), provide evidence, and defend or refine your stance.",
                            topic, role, stance, transcript_so_far
                        )
                    }
                    DebateStage::Closing => {
                        format!(
                            "[Stage: Closing]\nTopic: {}\nYour Role: {}\nAssigned Stance: {}\nDebate transcript so far:\n{}\nTask: Deliver your closing arguments. Summarize key debates, address major counterarguments, and state your final recommendation.",
                            topic, role, stance, transcript_so_far
                        )
                    }
                    DebateStage::Consensus => {
                        format!(
                            "[Stage: Consensus]\nTopic: {}\nFull debate transcript:\n{}\nTask: Identify common ground and remaining disagreements.\nFormat your response with explicit points:\n- [x] 共识: <agreed point>\n- [ ] 分歧: <unresolved conflict>",
                            topic, transcript_so_far
                        )
                    }
                };

                if agent.send_message(&prompt).await.is_ok() {
                    let poll_future = agent.poll_response();
                    if let Ok(Some(reply)) =
                        tokio::time::timeout(Duration::from_secs(15), poll_future).await
                    {
                        transcript_so_far
                            .push_str(&format!("\n[{:?}] {}: {}", stage, agent.id, reply));
                        debate_log.push((stage, agent.id.clone(), reply));
                    } else {
                        debate_log.push((
                            stage,
                            agent.id.clone(),
                            "[Timeout waiting for argument]".into(),
                        ));
                    }
                }
            }
        }

        debate_log
    }

    /// 运行带角色身份与立场的结构化辩论，并提取共识评估与跨智能体引用
    pub async fn run_debate_with_roles_and_consensus(
        &self,
        agents: &[SubagentHandle],
        participants: &[DebateParticipant],
        topic: &str,
    ) -> (
        Vec<(DebateStage, String, String)>,
        ConsensusEvaluation,
        Vec<AgentMention>,
    ) {
        let logs = self
            .run_structured_debate_with_roles(agents, participants, topic)
            .await;
        let mentions = extract_cross_references(&logs);
        let evaluation = evaluate_consensus(&logs);
        (logs, evaluation, mentions)
    }
}

/// 辩论参与者配置（包含智能体 ID、角色名称与分配立场）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DebateParticipant {
    pub id: String,
    pub role: String,
    pub stance: Option<String>,
}

/// 结构化辩论阶段定义（对齐 TS StructuredDebateCoordinator 状态）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum DebateStage {
    Opening,
    FreeDebate,
    Closing,
    Consensus,
}

/// 辩论共识评估结果
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ConsensusEvaluation {
    /// 共识度评分 (0.0 ~ 1.0)
    pub score: f64,
    /// 共同认同的关键观点
    pub consensus_points: Vec<String>,
    /// 尚未消解的分歧议题
    pub unresolved_conflicts: Vec<String>,
    /// 是否达成有效共识（score >= 0.70）
    pub reached_consensus: bool,
}

/// 跨智能体提及与引用记录
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentMention {
    /// 引用发起方
    pub source_agent: String,
    /// 被引用的目标智能体
    pub target_agent: String,
    /// 引用上下文片段
    pub snippet: String,
}

/// 从辩论发言记录中提取跨智能体提及与引用
pub fn extract_cross_references(entries: &[(DebateStage, String, String)]) -> Vec<AgentMention> {
    let mut mentions = Vec::new();
    let mut known_agents = std::collections::BTreeSet::new();
    for (_, agent, _) in entries {
        known_agents.insert(agent.clone());
    }

    for (_, source_agent, content) in entries {
        for target in &known_agents {
            if target == source_agent {
                continue;
            }
            let pattern1 = format!("@{}", target);
            let pattern2 = format!("agent {}", target);
            let lower_content = content.to_lowercase();
            let lower_target = target.to_lowercase();

            if content.contains(&pattern1)
                || lower_content.contains(&pattern2)
                || lower_content.contains(&format!("[{}]", lower_target))
            {
                let snippet = if content.len() > 120 {
                    format!("{}...", &content[..120])
                } else {
                    content.clone()
                };
                mentions.push(AgentMention {
                    source_agent: source_agent.clone(),
                    target_agent: target.clone(),
                    snippet,
                });
            }
        }
    }
    mentions
}

/// 评估辩论各阶段（重点为 Consensus 阶段）的共识度并提取结论
pub fn evaluate_consensus(entries: &[(DebateStage, String, String)]) -> ConsensusEvaluation {
    let consensus_entries: Vec<&(DebateStage, String, String)> = entries
        .iter()
        .filter(|(stage, _, _)| *stage == DebateStage::Consensus)
        .collect();

    let target_entries = if !consensus_entries.is_empty() {
        consensus_entries
    } else {
        entries.iter().collect()
    };

    let mut agree_signals = 0;
    let mut conflict_signals = 0;
    let mut consensus_points = Vec::new();
    let mut unresolved_conflicts = Vec::new();

    let agree_keywords = [
        "agree",
        "concur",
        "consensus",
        "aligned",
        "common ground",
        "both",
        "accept",
        "赞同",
        "达成共识",
        "一致认为",
        "认可",
        "共同",
        "同意",
    ];
    let conflict_keywords = [
        "disagree",
        "differ",
        "conflict",
        "diverge",
        "however",
        "oppose",
        "objection",
        "分歧",
        "不同意",
        "反对",
        "异议",
        "争论",
        "争议",
        "矛盾",
    ];

    for (_, agent, text) in &target_entries {
        let lower = text.to_lowercase();
        for kw in agree_keywords {
            if lower.contains(kw) {
                agree_signals += 1;
            }
        }
        for kw in conflict_keywords {
            if lower.contains(kw) {
                conflict_signals += 1;
            }
        }

        // 提取带标记的结论点
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("- [x]")
                || trimmed.starts_with("1.")
                || trimmed.starts_with("- 共识:")
                || trimmed.starts_with("- consensus:")
            {
                consensus_points.push(format!("{agent}: {trimmed}"));
            } else if trimmed.starts_with("- [ ]")
                || trimmed.starts_with("- 分歧:")
                || trimmed.starts_with("- conflict:")
            {
                unresolved_conflicts.push(format!("{agent}: {trimmed}"));
            }
        }
    }

    let total = agree_signals + conflict_signals;
    let score = if total == 0 {
        0.5
    } else {
        (agree_signals as f64) / (total as f64)
    };

    let reached_consensus = score >= 0.70 || (agree_signals > 0 && conflict_signals == 0);

    ConsensusEvaluation {
        score: (score * 100.0).round() / 100.0,
        consensus_points,
        unresolved_conflicts,
        reached_consensus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::event_store::SqliteEventStore;

    #[tokio::test]
    async fn test_persistent_subagent_round_robin() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let manager = PersistentSubagentManager::new(store);

        let a1 = manager.spawn_persistent(SubagentConfig {
            id: "agent_alpha".into(),
            system_prompt: "You are alpha".into(),
            max_turns: 5,
        });

        let a2 = manager.spawn_persistent(SubagentConfig {
            id: "agent_beta".into(),
            system_prompt: "You are beta".into(),
            max_turns: 5,
        });

        let transcript = manager
            .run_team_round_robin(&[a1, a2], "Start debate", 1)
            .await;
        assert_eq!(transcript.len(), 2);
        assert!(transcript[0].starts_with("agent_alpha:"));
        assert!(transcript[1].starts_with("agent_beta:"));
    }

    #[tokio::test]
    async fn test_persistent_subagent_structured_debate() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let manager = PersistentSubagentManager::new(store);

        let d1 = manager.spawn_persistent(SubagentConfig {
            id: "debater_pro".into(),
            system_prompt: "Affirmative".into(),
            max_turns: 10,
        });

        let d2 = manager.spawn_persistent(SubagentConfig {
            id: "debater_con".into(),
            system_prompt: "Negative".into(),
            max_turns: 10,
        });

        let logs = manager
            .run_structured_debate(&[d1, d2], "Rust vs TypeScript")
            .await;
        // 4个阶段 × 2个辩手 = 8条记录
        assert_eq!(logs.len(), 8);
        assert_eq!(logs[0].0, DebateStage::Opening);
        assert_eq!(logs[2].0, DebateStage::FreeDebate);
        assert_eq!(logs[4].0, DebateStage::Closing);
        assert_eq!(logs[6].0, DebateStage::Consensus);
    }

    #[tokio::test]
    async fn test_persistent_subagent_structured_debate_with_roles() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let manager = PersistentSubagentManager::new(store);

        let d1 = manager.spawn_persistent(SubagentConfig {
            id: "architect".into(),
            system_prompt: "Systems Architect".into(),
            max_turns: 10,
        });

        let d2 = manager.spawn_persistent(SubagentConfig {
            id: "security".into(),
            system_prompt: "Security Auditor".into(),
            max_turns: 10,
        });

        let participants = vec![
            DebateParticipant {
                id: "architect".into(),
                role: "Lead Architect".into(),
                stance: Some("Monolith First".into()),
            },
            DebateParticipant {
                id: "security".into(),
                role: "Security Officer".into(),
                stance: Some("Microservices Isolation".into()),
            },
        ];

        let (logs, eval, mentions) = manager
            .run_debate_with_roles_and_consensus(
                &[d1, d2],
                &participants,
                "Microservices vs Monolith",
            )
            .await;

        // 4 阶段 × 2 辩手 = 8 条记录
        assert_eq!(logs.len(), 8);
        assert_eq!(logs[0].0, DebateStage::Opening);
        assert_eq!(logs[2].0, DebateStage::FreeDebate);
        assert_eq!(logs[4].0, DebateStage::Closing);
        assert_eq!(logs[6].0, DebateStage::Consensus);
        assert!(eval.score >= 0.0);
        assert_eq!(mentions.len(), 6);
        assert!(
            mentions
                .iter()
                .any(|m| m.source_agent == "security" && m.target_agent == "architect")
        );
    }

    #[test]
    fn test_extract_cross_references() {
        let entries = vec![
            (
                DebateStage::Opening,
                "pro".into(),
                "I believe Rust is better".into(),
            ),
            (
                DebateStage::FreeDebate,
                "con".into(),
                "Responding to @pro, I disagree strongly".into(),
            ),
            (
                DebateStage::Closing,
                "pro".into(),
                "As mentioned by agent con, there are trade-offs".into(),
            ),
        ];

        let mentions = extract_cross_references(&entries);
        assert_eq!(mentions.len(), 2);
        assert_eq!(mentions[0].source_agent, "con");
        assert_eq!(mentions[0].target_agent, "pro");
        assert_eq!(mentions[1].source_agent, "pro");
        assert_eq!(mentions[1].target_agent, "con");
    }

    #[test]
    fn test_evaluate_consensus() {
        let entries = vec![
            (DebateStage::Consensus, "pro".into(), "I agree that Rust provides safety.\n- [x] Memory safety\n- [ ] Garbage collection overhead".into()),
            (DebateStage::Consensus, "con".into(), "We have reached consensus on safety benefits.\n- 共识: High performance".into()),
        ];

        let eval = evaluate_consensus(&entries);
        assert!(eval.score >= 0.7);
        assert!(eval.reached_consensus);
        assert_eq!(eval.consensus_points.len(), 2);
        assert_eq!(eval.unresolved_conflicts.len(), 1);

        let serialized =
            serde_json::to_string(&eval).expect("should serialize ConsensusEvaluation");
        assert!(serialized.contains("reached_consensus"));
    }
}
