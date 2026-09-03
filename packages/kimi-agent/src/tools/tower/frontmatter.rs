use std::collections::BTreeMap;

const FENCE: &str = "---";

pub fn render_frontmatter(fields: &[(&str, &str)]) -> Result<String, String> {
    let mut lines = vec![FENCE.to_string()];
    for &(key, value) in fields {
        if value.contains('\n') || value.contains('\r') {
            return Err(format!(
                "frontmatter value for \"{key}\" must be single-line"
            ));
        }
        lines.push(format!("{key}: {value}"));
    }
    lines.push(FENCE.to_string());
    Ok(lines.join("\n"))
}

pub fn parse_frontmatter(text: &str) -> (BTreeMap<String, String>, String) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some(FENCE) {
        return (BTreeMap::new(), text.to_string());
    }

    let close_idx = lines.iter().enumerate().skip(1).find_map(|(idx, line)| {
        if line.trim() == FENCE {
            Some(idx)
        } else {
            None
        }
    });

    let Some(close) = close_idx else {
        return (BTreeMap::new(), text.to_string());
    };

    let mut fields = BTreeMap::new();
    for line in &lines[1..close] {
        if let Some(pos) = line.find(':').filter(|pos| *pos > 0) {
            let key = line[..pos].trim().to_string();
            let value = line[pos + 1..].trim().to_string();
            fields.insert(key, value);
        }
    }

    let body = lines[close + 1..].join("\n").trim().to_string();
    (fields, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frontmatter_roundtrip() {
        let fields = vec![
            ("type", "inbox"),
            ("from", "worker-1"),
            ("to", "tower"),
            ("subject", "Task done"),
        ];
        let rendered = render_frontmatter(&fields).unwrap();
        let (parsed, body) = parse_frontmatter(&format!("{rendered}\n\nHere is the body text."));
        assert_eq!(parsed.get("type").unwrap(), "inbox");
        assert_eq!(parsed.get("from").unwrap(), "worker-1");
        assert_eq!(parsed.get("to").unwrap(), "tower");
        assert_eq!(parsed.get("subject").unwrap(), "Task done");
        assert_eq!(body, "Here is the body text.");
    }
}
