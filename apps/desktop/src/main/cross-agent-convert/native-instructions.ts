import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  isBinaryVersionNotOlder,
  normalizeBinaryVersion,
} from '../agent-binaries/binary-version-probe.js';

type Settings = Record<string, unknown>;
const PLUGIN_IDS = ['cc-plugin-agents-md@builtin', 'agents-md@builtin'];
const DISABLE_ENV = [
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'CLAUDE_CODE_SAFE_MODE',
];
// Configuration redirection/parent policy observed in the managed 2.1.296 CLI.
// This detector does not resolve those alternate sources, so their state is unknown.
const EXTERNAL_SETTINGS_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
  'CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS',
];

/** Read-only presence check; never execute policy helpers or project hooks. */
export async function hasClaudeManagedPolicy(homeDir: string): Promise<boolean> {
  const policyRoot =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code';
  const paths = [
    path.join(policyRoot, 'managed-settings.json'),
    path.join(policyRoot, 'managed-settings.d'),
    path.join(homeDir, '.claude', 'remote-settings.json'),
    ...(process.platform === 'darwin'
      ? [
          '/Library/Managed Preferences/com.anthropic.claudecode.plist',
          path.join(
            '/Library/Managed Preferences',
            path.basename(homeDir),
            'com.anthropic.claudecode.plist',
          ),
          path.join(homeDir, 'Library', 'Preferences', 'com.anthropic.claudecode.plist'),
        ]
      : []),
  ];
  for (const file of paths) {
    try {
      await fs.stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  if (process.platform === 'win32') {
    // reg.exe uses exit 1 for both "absent" and "access denied". Query value
    // names via .NET instead: only a proven absence exits 0; denial/timeout is unknown.
    // The script is fixed, has no user input, reads no value content and never writes.
    const script =
      "$ErrorActionPreference='Stop'; try { foreach ($base in @([Microsoft.Win32.Registry]::LocalMachine, [Microsoft.Win32.Registry]::CurrentUser)) { $key=$base.OpenSubKey('SOFTWARE\\Policies\\ClaudeCode', $false); if ($null -ne $key) { try { if ($key.GetValueNames() -contains 'Settings') { exit 1 } } finally { $key.Dispose() } } }; exit 0 } catch { exit 2 }";
    return new Promise<boolean>((resolve) => {
      execFile(
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 3000, maxBuffer: 1024 },
        (error) => resolve(Boolean(error)),
      );
    });
  }
  return false;
}

function object(value: unknown): Settings | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Settings)
    : undefined;
}

function enabled(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== false &&
    value !== 0 &&
    value !== '' &&
    value !== '0' &&
    value !== 'false'
  );
}

function envBlocksNativeLoading(env: Settings | undefined, platform: NodeJS.Platform): boolean {
  return Object.entries(env ?? {}).some(([name, value]) => {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    return (
      (DISABLE_ENV.includes(key) && enabled(value)) ||
      (EXTERNAL_SETTINGS_ENV.includes(key) && Boolean(value))
    );
  });
}

/**
 * Only positive evidence removes a migration suggestion. 2.1.277 introduced the
 * built-in, but 2.1.281 is the first release supporting gateways/telemetry-off too.
 * Sources: https://github.com/anthropics/claude-code/blob/v2.1.296/CHANGELOG.md
 * and mods/agents-md/README.md in that same release. Never infer from model names.
 */
export async function claudeReadsAgentsMd(input: {
  version: string | null;
  workingDir: string;
  userSettingsPath: string;
  env: NodeJS.ProcessEnv;
  /** Only environment-name matching varies; filesystem paths use the host's native semantics. */
  envPlatform?: NodeJS.Platform;
  /** Managed policy is not resolved by this detector. Its presence stays unknown. */
  managedPolicyPresent: boolean;
  /** Known instruction root, when provided by the caller (also isolates unit fixtures). */
  instructionRoot?: string;
}): Promise<boolean> {
  const version = input.version && normalizeBinaryVersion(input.version);
  if (!version || version.includes('-') || !isBinaryVersionNotOlder(version, '2.1.281'))
    return false;
  const envPlatform = input.envPlatform ?? process.platform;
  if (input.managedPolicyPresent || envBlocksNativeLoading(input.env, envPlatform)) return false;
  try {
    const readSettings = async (file: string): Promise<Settings> => {
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
      }
      const parsed = object(JSON.parse(raw));
      if (!parsed) throw new Error('Unknown settings shape');
      return parsed;
    };
    const user = await readSettings(input.userSettingsPath);
    const settings = [user];
    const directories: string[] = [];
    // The subprocess resolves cwd to its physical directory. Walk that same tree,
    // including ancestors hidden by a symlink/junction. Failure stays unknown.
    const workingDir = await fs.realpath(input.workingDir);
    const instructionRoot = input.instructionRoot
      ? await fs.realpath(input.instructionRoot)
      : undefined;
    // An ancestor CLAUDE.md can claim the project. Looking above the project root
    // is deliberately conservative when the engine's root cannot be proven here.
    for (let dir = workingDir; ; dir = path.dirname(dir)) {
      directories.push(dir);
      settings.push(await readSettings(path.join(dir, '.claude', 'settings.json')));
      settings.push(await readSettings(path.join(dir, '.claude', 'settings.local.json')));
      if (dir === instructionRoot || path.dirname(dir) === dir) break;
    }
    for (const layer of settings) {
      if (layer.env !== undefined && !object(layer.env)) return false;
      if (layer.enabledPlugins !== undefined && !object(layer.enabledPlugins)) return false;
      if (envBlocksNativeLoading(object(layer.env), envPlatform)) return false;
      if (
        layer.claudeMdExcludes !== undefined &&
        (!Array.isArray(layer.claudeMdExcludes) || layer.claudeMdExcludes.length > 0)
      )
        return false;
      if (layer.policyHelper !== undefined) return false;
      const permissions = object(layer.permissions);
      if (layer.permissions !== undefined && !permissions) return false;
      if (permissions?.deny !== undefined) {
        if (
          !Array.isArray(permissions.deny) ||
          permissions.deny.some((rule) => typeof rule !== 'string' || /^Read(?:\(|$)/.test(rule))
        )
          return false;
      }
      const plugins = object(layer.enabledPlugins);
      if (PLUGIN_IDS.some((id) => plugins?.[id] !== undefined && plugins[id] !== true))
        return false;
    }
    // Plugin options are user/flag/managed only; project/local options are ignored
    // by upstream. Recognize both IDs and the legacy option, conservatively on conflicts.
    const modes: boolean[] = [];
    if (user.pluginConfigs !== undefined && !object(user.pluginConfigs)) return false;
    const optionIds = isBinaryVersionNotOlder(version, '2.1.285')
      ? PLUGIN_IDS
      : ['agents-md@builtin'];
    for (const id of optionIds) {
      const config = object(object(user.pluginConfigs)?.[id]);
      if (object(user.pluginConfigs)?.[id] !== undefined && !config) return false;
      if (!config) continue;
      const options = object(config.options);
      if (!options) return false;
      const mode = options.instructionFiles;
      const legacy = options.projectInstructions;
      if (mode === 'claude-md-and-agents-md') {
        modes.push(true);
        continue;
      }
      if (mode !== undefined && mode !== 'claude-md-or-agents-md') return false;
      if (legacy === 'both') modes.push(true);
      else if (legacy !== undefined && legacy !== 'agents-fallback') return false;
      else modes.push(false);
    }
    // Two historical IDs with conflicting modes cannot establish "load both".
    const both = modes.length > 0 && modes.every(Boolean);
    if (!both) {
      for (const dir of directories) {
        for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
          try {
            await fs.stat(path.join(dir, name));
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
