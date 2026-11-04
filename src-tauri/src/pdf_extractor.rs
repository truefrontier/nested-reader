//! PDF text post-processing for Markdown structure and paragraph consolidation
//!
//! This module takes raw text from pdf-extract and applies:
//! 1. Heading inference based on typography (ALL CAPS, short lines, spacing)
//! 2. Paragraph consolidation (joins mid-paragraph line breaks into flowing prose)
//!
//! Input: flat text with hard line breaks from PDF visual layout
//! Output: Markdown with # headings and natural paragraph flow

/// Apply Markdown structure inference and paragraph consolidation to extracted PDF text
pub fn add_structure_and_reflow(raw_text: &str) -> String {
    let lines: Vec<&str> = raw_text.lines().collect();
    let mut result = Vec::new();
    let mut current_paragraph = Vec::new();
    
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        
        // Skip empty lines
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        
        // Check if this line is a heading
        let heading = detect_heading(trimmed, line, i, &lines);
        
        if let Some(heading_text) = heading {
            // Flush any accumulated paragraph
            if !current_paragraph.is_empty() {
                result.push(current_paragraph.join(" "));
                current_paragraph.clear();
            }
            result.push(heading_text);
            i += 1;
            continue;
        }
        
        // Regular text line - decide if it continues current paragraph or starts new one
        if !current_paragraph.is_empty() {
            // Check if previous line ended a sentence and this starts a new one
            let prev_line: &&str = current_paragraph.last().unwrap();
            let ends_sentence = prev_line.ends_with('.') || 
                               prev_line.ends_with('!') || 
                               prev_line.ends_with('?') ||
                               prev_line.ends_with(".]") ||
                               prev_line.ends_with("†]") ||
                               prev_line.ends_with(".)");
            
            let starts_new = trimmed.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) &&
                            (trimmed.len() > 50 || // Long line = likely new sentence
                             trimmed.starts_with("The ") || 
                             trimmed.starts_with("This ") ||
                             trimmed.starts_with("That ") ||
                             trimmed.starts_with("Cadence ") ||
                             trimmed.starts_with("No ") ||
                             trimmed.starts_with("On ") ||
                             trimmed.starts_with("And "));
            
            // Start new paragraph if previous ended and this looks like a new start
            if ends_sentence && starts_new {
                result.push(current_paragraph.join(" "));
                current_paragraph.clear();
                result.push(String::new()); // Paragraph break
            }
        }
        
        current_paragraph.push(trimmed);
        i += 1;
    }
    
    // Flush final paragraph
    if !current_paragraph.is_empty() {
        result.push(current_paragraph.join(" "));
    }
    
    // Join and clean up excessive newlines
    let mut markdown = result.join("\n");
    while markdown.contains("\n\n\n") {
        markdown = markdown.replace("\n\n\n", "\n\n");
    }
    
    markdown.trim().to_string()
}

/// Detect if a line is a heading and return the formatted heading, or None if it's body text
fn detect_heading(trimmed: &str, line: &str, i: usize, lines: &[&str]) -> Option<String> {
    // Skip very short lines (likely artifacts)
    if trimmed.len() < 5 {
        return None;
    }
    
    // Detect ALL CAPS lines as potential headings
    let alpha_chars: Vec<char> = trimmed.chars().filter(|c| c.is_alphabetic()).collect();
    let is_all_caps = alpha_chars.len() > 3 && alpha_chars.iter().all(|c| c.is_uppercase());
    
    // Skip if it looks like a page number, figure caption, or reference
    if trimmed.starts_with("Page ") || 
       trimmed.starts_with("Figure ") || 
       trimmed.starts_with("Table ") ||
       trimmed.chars().filter(|c| c.is_numeric()).count() > trimmed.len() / 3 {
        return None;
    }
    
    // Detect short lines that are likely titles
    let is_short = trimmed.len() < 80;
    let is_very_short = trimmed.len() < 40;
    let ends_naturally = !trimmed.ends_with('.') &&
                        !trimmed.ends_with(',') &&
                        !trimmed.ends_with(';') &&
                        !trimmed.ends_with(':');
    
    // Check if next line is empty (suggests this line is a heading)
    let followed_by_empty = i + 1 < lines.len() && lines[i + 1].trim().is_empty();
    
    // Check if preceded by empty line
    let preceded_by_empty = i == 0 || lines[i - 1].trim().is_empty();
    
    // Check if surrounded by multiple empty lines (strong separator)
    let followed_by_double_empty = i + 2 < lines.len() && 
                                    lines[i + 1].trim().is_empty() && 
                                    lines[i + 2].trim().is_empty();
    
    // Check if line has significant leading whitespace (centered titles)
    let leading_spaces = line.len() - line.trim_start().len();
    let is_centered = leading_spaces > 20;
    
    // H1: ALL CAPS, very short, standalone with strong separation
    if is_all_caps && is_very_short && preceded_by_empty && followed_by_double_empty && ends_naturally {
        return Some(format!("# {}", trimmed));
    }
    
    // H2: ALL CAPS, short, centered or with blank line separation
    if is_all_caps && is_short && preceded_by_empty && followed_by_empty && 
       (is_centered || is_very_short) && ends_naturally {
        return Some(format!("## {}", trimmed));
    }
    
    // H3: Questions or "What/How/Where" patterns followed by blank line
    if is_short && trimmed.len() > 15 && trimmed.len() < 100 && 
       preceded_by_empty && followed_by_empty && ends_naturally &&
       (trimmed.ends_with('?') || 
           (trimmed.starts_with("What ") || 
            trimmed.starts_with("How ") ||
            trimmed.starts_with("Where ") ||
            trimmed.starts_with("Why ") ||
            trimmed.starts_with("When ")) && trimmed.contains(" ")) {
        return Some(format!("### {}", trimmed));
    }
    
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consolidates_paragraph_lines() {
        let input = "First line of paragraph that\ncontinues on the next line and\nfinishes here.\n\nSecond paragraph starts.";
        let output = add_structure_and_reflow(input);
        
        assert!(output.contains("First line of paragraph that continues on the next line and finishes here."));
        assert!(output.contains("Second paragraph starts."));
    }

    #[test]
    fn detects_all_caps_headings() {
        let input = "INTRODUCTION\n\nThis is body text.";
        let output = add_structure_and_reflow(input);
        
        assert!(output.contains("# INTRODUCTION") || output.contains("## INTRODUCTION"));
    }

    #[test]
    fn detects_question_headings() {
        let input = "What is the solution?\n\nBody text here.";
        let output = add_structure_and_reflow(input);
        
        assert!(output.contains("### What is the solution?"));
    }
}
