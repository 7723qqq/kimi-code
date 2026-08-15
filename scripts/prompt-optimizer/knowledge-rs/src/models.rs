use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    CodingStyle,
    Pitfall,
    Architecture,
    Workflow,
}

impl Category {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "coding-style" => Ok(Self::CodingStyle),
            "pitfall" => Ok(Self::Pitfall),
            "architecture" => Ok(Self::Architecture),
            "workflow" => Ok(Self::Workflow),
            _ => Err(format!("Invalid category: {s}. Must be one of: coding-style, pitfall, architecture, workflow")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CodingStyle => "coding-style",
            Self::Pitfall => "pitfall",
            Self::Architecture => "architecture",
            Self::Workflow => "workflow",
        }
    }
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Human,
    AiLearned,
    AiConfirmed,
}

impl Source {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "human" => Ok(Self::Human),
            "ai-learned" => Ok(Self::AiLearned),
            "ai-confirmed" => Ok(Self::AiConfirmed),
            _ => Err(format!("Invalid source: {s}. Must be one of: human, ai-learned, ai-confirmed")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::AiLearned => "ai-learned",
            Self::AiConfirmed => "ai-confirmed",
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub category: Category,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub scope: Option<String>,
    pub confidence: f64,
    pub source: Source,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub entry: KnowledgeEntry,
    pub relevance: f64,
    pub match_source: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stats {
    pub total: usize,
    pub by_category: std::collections::HashMap<String, usize>,
    pub by_source: std::collections::HashMap<String, usize>,
    pub avg_confidence: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_roundtrip() {
        for (s, cat) in [
            ("coding-style", Category::CodingStyle),
            ("pitfall", Category::Pitfall),
            ("architecture", Category::Architecture),
            ("workflow", Category::Workflow),
        ] {
            assert_eq!(Category::from_str(s).unwrap(), cat);
            assert_eq!(cat.as_str(), s);
            assert_eq!(cat.to_string(), s);
        }
    }

    #[test]
    fn category_rejects_unknown() {
        let err = Category::from_str("nope").unwrap_err();
        assert!(err.contains("Invalid category"), "got: {err}");
        assert!(err.contains("pitfall"), "got: {err}");
    }

    #[test]
    fn source_roundtrip() {
        for (s, src) in [
            ("human", Source::Human),
            ("ai-learned", Source::AiLearned),
            ("ai-confirmed", Source::AiConfirmed),
        ] {
            assert_eq!(Source::from_str(s).unwrap(), src);
            assert_eq!(src.as_str(), s);
            assert_eq!(src.to_string(), s);
        }
    }

    #[test]
    fn source_rejects_unknown() {
        let err = Source::from_str("robot").unwrap_err();
        assert!(err.contains("Invalid source"), "got: {err}");
    }
}
