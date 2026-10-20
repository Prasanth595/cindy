//! Native configuration order and project trust determine which directories
//! may contribute .rules. Only .rules contents leave this reader; config values,
//! credentials, Hook definitions and scripts never enter the rule package.
use codex_config::{
    AbsolutePathBuf, ConfigLayerSource, ConfigLayerStackOrdering, LoaderOverrides,
    NoopThreadConfigLoader, loader::load_config_layers_state,
};
use codex_execpolicy::PolicyParser;
use serde_json::{Value, json};
use std::{io::{self, Read}, path::Path};

pub async fn discover(home: &str, cwd: &str) -> Result<Value, &'static str> {
    discover_with_overrides(home, cwd, LoaderOverrides::default()).await
}

async fn discover_with_overrides(home: &str, cwd: &str, overrides: LoaderOverrides) -> Result<Value, &'static str> {
    let home = AbsolutePathBuf::from_absolute_path(home).map_err(|_| "INVALID_SOURCE_HOME")?;
    let cwd = AbsolutePathBuf::from_absolute_path(cwd).map_err(|_| "INVALID_SOURCE_CWD")?;
    let stack = load_config_layers_state(
        &crate::source_fs::SourceFileSystem, home.as_path(), Some(cwd.clone()), &[],
        overrides, &NoopThreadConfigLoader,
    ).await.map_err(|_| "SOURCE_CONFIG_READ_FAILED")?;
    let mut files = Vec::new();
    let mut layers = Vec::new();
    let mut parser = PolicyParser::new();
    let mut total_bytes = 0;
    for layer in stack.get_layers(ConfigLayerStackOrdering::LowestPrecedenceFirst, true) {
        let Some(folder) = layer.config_folder() else { continue; };
        let ignored = stack.ignore_user_and_project_exec_policy_rules()
            && matches!(layer.name, ConfigLayerSource::User { .. } | ConfigLayerSource::Project { .. });
        let enabled = layer.disabled_reason.is_none() && !ignored;
        layers.push(json!({
            "sourceId": folder.as_path(), "version": layer.version, "enabled": enabled,
            "kind": match layer.name {
                ConfigLayerSource::User { .. } => "user",
                ConfigLayerSource::Project { .. } => "project",
                _ => "system",
            },
        }));
        if !enabled { continue; }
        // Same file selection, symlink behavior and ordering as native core's
        // collect_policy_files. A missing directory alone means no source.
        let directory = folder.as_path().join("rules");
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err("SOURCE_DIRECTORY_READ_FAILED"),
        };
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| "SOURCE_DIRECTORY_READ_FAILED")?;
            if entry.path().extension().and_then(|v| v.to_str()) == Some("rules")
                && entry.file_type().map_err(|_| "SOURCE_DIRECTORY_READ_FAILED")?.is_file()
            { paths.push(entry.path()); }
        }
        paths.sort();
        for path in paths {
            let text = read_rule(&path).map_err(|_| "SOURCE_RULE_READ_FAILED")?;
            total_bytes += text.len();
            if total_bytes > 4 * 1024 * 1024 { return Err("SOURCE_RULES_TOO_LARGE"); }
            let source_id = path.to_str().ok_or("INVALID_SOURCE_PATH")?;
            parser.parse(source_id, &text).map_err(|_| "INVALID_RULES")?;
            files.push(json!({"sourceId": source_id, "text": text}));
        }
    }
    Ok(json!({
        "schemaVersion": 1, "engineVersion": crate::ENGINE_VERSION,
        "codexHome": home.as_path(), "cwd": cwd.as_path(), "layers": layers, "files": files,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Permissions/source tier: production native discovery with isolated
    // managed roots. No user's HOME, config, credentials, Hooks or commands.
    #[tokio::test]
    async fn discovers_ordered_files_without_importing_hooks_and_rejects_damage() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        let cwd = root.path().join("project");
        std::fs::create_dir_all(home.join("rules")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(home.join("rules/z.rules"), "prefix_rule(pattern=[\"probe\"], decision=\"prompt\")").unwrap();
        std::fs::write(home.join("rules/a.rules"), "prefix_rule(pattern=[\"other\"])").unwrap();
        std::fs::write(home.join("rules/hooks.json"), "not a rule").unwrap();
        let load = || discover_with_overrides(home.to_str().unwrap(), cwd.to_str().unwrap(), LoaderOverrides::without_managed_config_for_tests());
        let result = load().await.unwrap();
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0]["sourceId"].as_str().unwrap().ends_with("a.rules"));
        assert!(files[1]["sourceId"].as_str().unwrap().ends_with("z.rules"));
        std::fs::write(home.join("rules/z.rules"), "invalid(").unwrap();
        assert_eq!(load().await.unwrap_err(), "INVALID_RULES");
    }

    #[tokio::test]
    async fn project_rules_follow_native_trust_in_the_selected_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let cwd = root.path().join("project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(cwd.join(".git")).unwrap();
        std::fs::create_dir_all(cwd.join(".codex/rules")).unwrap();
        std::fs::write(cwd.join(".codex/config.toml"), "").unwrap();
        std::fs::write(cwd.join(".codex/rules/project.rules"), "prefix_rule(pattern=[\"project-probe\"], decision=\"forbidden\")").unwrap();
        let load = || discover_with_overrides(home.to_str().unwrap(), cwd.to_str().unwrap(), LoaderOverrides::without_managed_config_for_tests());
        assert!(load().await.unwrap()["files"].as_array().unwrap().is_empty());
        let canonical = std::fs::canonicalize(&cwd).unwrap();
        let key = serde_json::to_string(canonical.to_str().unwrap()).unwrap();
        std::fs::write(home.join("config.toml"), format!("[projects.{key}]\ntrust_level = \"trusted\"\n")).unwrap();
        assert_eq!(load().await.unwrap()["files"].as_array().unwrap().len(), 1);
    }
}

fn read_rule(path: &Path) -> io::Result<String> {
    let mut text = String::new();
    std::fs::File::open(path)?.take(4 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    if text.len() > 4 * 1024 * 1024 { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(text)
}
