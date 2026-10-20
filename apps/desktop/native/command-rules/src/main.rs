//! Deterministic command policy helper. It never executes the command being checked.
//! Native syntax, file boundaries, host_executable matching and shell parsing belong
//! to the pinned Codex crates, not a second Cindy implementation.
use codex_execpolicy::{Decision, MatchOptions, PolicyParser, RuleMatch};
use codex_shell_command::bash::{
    parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, Read};
mod discover;
mod source_fs;

const ENGINE_VERSION: &str = "0.145.0";
const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuleFile {
    source_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    engine_version: String,
    revision: String,
    files: Vec<RuleFile>,
    argv: Vec<String>,
    #[serde(default)]
    analysis_argv: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum Operation {
    Evaluate(Request),
    #[serde(rename_all = "camelCase")]
    Discover { schema_version: u32, engine_version: String, codex_home: String, cwd: String },
}

/// Pi's native PowerShell tool adds process flags which Codex's wrapper
/// recognizer does not accept. Remove only this exact, inert process preamble
/// for AST analysis; the complete original argv remains in the response.
fn pi_powershell_commands(argv: &[String]) -> Option<Vec<Vec<String>>> {
    let [shell, no_profile, non_interactive, execution_policy, bypass, command, script] = argv else {
        return None;
    };
    if !no_profile.eq_ignore_ascii_case("-NoProfile")
        || !non_interactive.eq_ignore_ascii_case("-NonInteractive")
        || !execution_policy.eq_ignore_ascii_case("-ExecutionPolicy")
        || !bypass.eq_ignore_ascii_case("Bypass")
        || !command.eq_ignore_ascii_case("-Command")
    {
        return None;
    }
    codex_shell_command::powershell::parse_powershell_command_into_plain_commands(&[
        shell.clone(), "-Command".into(), script.clone(),
    ])
}

/// Mirrors core::exec_policy::commands_for_exec_policy at the pinned commit.
/// No heuristics fallback is supplied to the policy: a native safelist is not
/// an explicit user allow rule. Complex scripts keep native wrapper semantics.
fn commands_for_policy(argv: &[String]) -> (Vec<Vec<String>>, &'static str) {
    if let Some(commands) = parse_shell_lc_plain_commands(argv).filter(|c| !c.is_empty()) {
        return (commands, "plain");
    }
    if let Some(commands) =
        codex_shell_command::powershell::parse_powershell_command_into_plain_commands(argv)
            .or_else(|| pi_powershell_commands(argv))
            .filter(|c| !c.is_empty())
    {
        return (commands, "powershell");
    }
    if let Some(command) = parse_shell_lc_single_command_prefix(argv) {
        return (vec![command], "heredoc");
    }
    (vec![argv.to_vec()], "original")
}

fn evaluate(request: Request) -> Result<Value, &'static str> {
    if request.schema_version != 1 || request.engine_version != ENGINE_VERSION {
        return Err("UNSUPPORTED_RULES_VERSION");
    }
    if request.revision.is_empty() || request.argv.is_empty() {
        return Err("INVALID_REQUEST");
    }
    let mut parser = PolicyParser::new();
    for file in &request.files {
        // A shared parser with a separate parse call per file is the native
        // multi-file contract. Concatenating Starlark modules changes scope.
        parser.parse(&file.source_id, &file.text).map_err(|_| "INVALID_RULES")?;
    }
    let policy = parser.build();
    // Script-file transports provide their exact native shell-analysis input
    // separately. The physical execution argv is preserved and echoed.
    let (commands, analysis) = commands_for_policy(request.analysis_argv.as_ref().unwrap_or(&request.argv));
    let options = MatchOptions { resolve_host_executables: true };
    let matches: Vec<_> = commands.iter()
        .map(|command| policy.matches_for_command_with_options(command, None, &options))
        .collect();
    let decisions: Vec<_> = matches.iter()
        .map(|matched| matched.iter().map(RuleMatch::decision).max())
        .collect();
    let decision = if decisions.contains(&Some(Decision::Forbidden)) {
        "forbidden"
    } else if decisions.contains(&Some(Decision::Prompt)) {
        "prompt"
    } else if decisions.iter().all(|d| *d == Some(Decision::Allow)) {
        "allow"
    } else {
        "unmatched"
    };
    Ok(json!({
        "schemaVersion": 1, "engineVersion": ENGINE_VERSION,
        "revision": request.revision, "argv": request.argv,
        "decision": decision, "analysis": analysis,
        "commands": commands, "decisions": decisions, "matches": matches,
    }))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut input = Vec::new();
    let result = io::stdin().take(MAX_REQUEST_BYTES + 1).read_to_end(&mut input)
        .map_err(|_| "REQUEST_READ_FAILED")
        .and_then(|_| {
            if input.len() as u64 > MAX_REQUEST_BYTES { return Err("REQUEST_TOO_LARGE"); }
            serde_json::from_slice::<Operation>(&input).map_err(|_| "INVALID_REQUEST")
        });
    let result = match result {
        Ok(Operation::Evaluate(request)) => evaluate(request),
        Ok(Operation::Discover { schema_version, engine_version, codex_home, cwd }) => {
            if schema_version != 1 || engine_version != ENGINE_VERSION {
                Err("UNSUPPORTED_RULES_VERSION")
            } else { discover::discover(&codex_home, &cwd).await }
        }
        Err(error) => Err(error),
    };
    // Do not emit parser diagnostics containing the user's rule text to stderr
    // or logs. Failures are distinct protocol results, never `unmatched`.
    println!("{}", result.unwrap_or_else(|code| json!({"error": code})));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check(rules: &[&str], argv: &[&str]) -> Result<Value, &'static str> {
        evaluate(Request { schema_version: 1, engine_version: ENGINE_VERSION.into(), revision: "fixture".into(),
            files: rules.iter().enumerate().map(|(i, text)| RuleFile { source_id: i.to_string(), text: (*text).into() }).collect(),
            argv: argv.iter().map(|v| (*v).into()).collect(), analysis_argv: None })
    }
    const POLICY: &str = r#"
def add(command, decision):
    prefix_rule(pattern=["probe", command], decision=decision)
[add(command, "allow") for command in ["one", "two"]]
prefix_rule(pattern=["probe", "ask"], decision="prompt")
prefix_rule(pattern=["probe", "deny"], decision="forbidden")
"#;

    #[test]
    fn native_syntax_and_shell_decisions() {
        for (script, expected) in [
            ("probe one", "allow"), ("probe ask", "prompt"), ("probe deny", "forbidden"),
            ("probe one && probe two", "allow"), ("probe one && probe ask", "prompt"),
            ("probe one | probe deny", "forbidden"), ("probe one; unknown", "unmatched"),
            ("probe oneness", "unmatched"), ("probe \"one\"", "allow"),
            ("probe \"$dynamic\"", "unmatched"), ("probe one > output", "unmatched"),
            ("probe one <<EOF\nbody\nEOF", "allow"),
        ] {
            let result = check(&[POLICY], &["bash", "-lc", script]).unwrap();
            assert_eq!(result["decision"], expected, "{script}");
        }
    }

    #[test]
    fn multi_file_strict_precedence_and_native_validation() {
        let allow = "prefix_rule(pattern=[\"probe\"], decision=\"allow\")";
        assert_eq!(check(&[allow, POLICY], &["probe", "deny"]).unwrap()["decision"], "forbidden");
        assert_eq!(check(&[POLICY, allow], &["probe", "ask"]).unwrap()["decision"], "prompt");
        assert_eq!(check(&["invalid("], &["probe"]).unwrap_err(), "INVALID_RULES");
        assert_eq!(check(&["prefix_rule(pattern=[\"probe\"], not_match=[\"probe\"])"], &["probe"]).unwrap_err(), "INVALID_RULES");
        assert_eq!(check(&[], &["probe"]).unwrap()["decision"], "unmatched");
    }

    #[test]
    fn protocol_errors_are_not_unmatched() {
        let input = json!({"operation":"evaluate", "schemaVersion":999,"engineVersion":ENGINE_VERSION,
            "revision":"fixture","files":[],"argv":["probe"]});
        let Operation::Evaluate(request) = serde_json::from_value(input).unwrap() else { panic!() };
        assert_eq!(evaluate(request).unwrap_err(), "UNSUPPORTED_RULES_VERSION");
    }

    #[cfg(unix)]
    #[test]
    fn native_host_executable_identity_is_retained() {
        let rules = r#"host_executable(name="probe", paths=["/native/bin/probe"])
prefix_rule(pattern=["probe", "ask"], decision="prompt")"#;
        assert_eq!(check(&[rules], &["/native/bin/probe", "ask"]).unwrap()["decision"], "prompt");
        assert_eq!(check(&[rules], &["/different/bin/probe", "ask"]).unwrap()["decision"], "unmatched");
    }

    #[cfg(windows)]
    #[test]
    fn pi_powershell_preamble_keeps_native_ast_analysis() {
        for (script, decision) in [("probe one; probe ask", "prompt"), ("probe one | probe deny", "forbidden")] {
            let result = check(&[POLICY], &["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).unwrap();
            assert_eq!(result["decision"], decision);
            assert_eq!(result["analysis"], "powershell");
        }
    }
}
