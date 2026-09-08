//! 步骤级生命周期钩子与强制止轮检查点。

use std::sync::Arc;

/// 步骤执行结果摘要
#[derive(Debug, Clone)]
pub struct StepResult {
    pub step_index: usize,
    pub has_tool_calls: bool,
    pub tokens_used: usize,
}

pub type StopHookFn = Arc<dyn Fn(&StepResult) -> bool + Send + Sync>;

/// 引擎执行配置
#[derive(Clone)]
pub struct EngineConfig {
    pub max_tokens_limit: usize,
    pub stop_hook: Option<StopHookFn>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            // 默认模型上限 128,000 的 80% 警戒线
            max_tokens_limit: 102_400,
            stop_hook: None,
        }
    }
}

/// 原生单轮循环状态评估器
pub struct TurnLoop {
    config: EngineConfig,
    consecutive_no_tool_steps: usize,
}

impl TurnLoop {
    /// 构造循环评估器
    pub fn new(config: EngineConfig) -> Self {
        Self {
            config,
            consecutive_no_tool_steps: 0,
        }
    }

    /// 在每个 step 边界评估是否需要终止回合
    pub fn evaluate_step_stop(&mut self, result: &StepResult) -> bool {
        // 1. Token 累计使用超过阈值（如模型窗口 80%），强制止轮
        if result.tokens_used >= self.config.max_tokens_limit {
            return true;
        }

        // 2. 连续 3 步无工具调用，触发默认止轮保护
        if !result.has_tool_calls {
            self.consecutive_no_tool_steps += 1;
        } else {
            self.consecutive_no_tool_steps = 0;
        }

        if self.consecutive_no_tool_steps >= 3 {
            return true;
        }

        // 3. 外部注入的自定义止轮闭包
        if let Some(ref hook) = self.config.stop_hook
            && hook(result)
        {
            return true;
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_stop_consecutive_no_tools() {
        let mut turn_loop = TurnLoop::new(EngineConfig::default());
        let step_empty = StepResult {
            step_index: 0,
            has_tool_calls: false,
            tokens_used: 100,
        };

        assert!(!turn_loop.evaluate_step_stop(&step_empty));
        assert!(!turn_loop.evaluate_step_stop(&step_empty));
        // 第 3 步连续无工具调用，触发止轮
        assert!(turn_loop.evaluate_step_stop(&step_empty));
    }

    #[test]
    fn test_step_stop_tokens_exceeded() {
        let mut turn_loop = TurnLoop::new(EngineConfig::default());
        let step_overflow = StepResult {
            step_index: 0,
            has_tool_calls: true,
            tokens_used: 105_000,
        };
        // Token 超过默认 102_400 限制，直接止轮
        assert!(turn_loop.evaluate_step_stop(&step_overflow));
    }
}
