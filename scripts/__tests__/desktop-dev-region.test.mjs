import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyDesktopDevStartupConfig,
  applyWorktreeIsolationEnv,
  desktopUserDataDirForRegion,
  desktopUserDataDirNameForRegion,
  foldCaseOption,
  isolationNameFromWorktree,
  resolveDesktopDevRegion,
  resolveDesktopDevStartupConfig,
  resolveWorktreeIsolationFromCwd,
  stripDesktopDevRegionArgs,
  worktreeNameFromPath,
  worktreeRootFromPath,
} from "../shared/desktop-dev-region.mjs";

test("desktop shared userData follows the region identity", () => {
  assert.equal(desktopUserDataDirNameForRegion(), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("global"), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("cn"), "Cindy");
  assert.equal(desktopUserDataDirNameForRegion("dev"), "CindyDev");
  assert.throws(
    () => desktopUserDataDirNameForRegion("us"),
    /expected cn, global or dev/,
  );
});

test("desktop userData path follows platform appData rules and selected region", () => {
  assert.equal(
    desktopUserDataDirForRegion("global", "darwin", {}, "/Users/tester"),
    "/Users/tester/Library/Application Support/CindyGlobal",
  );
  assert.equal(
    desktopUserDataDirForRegion(
      "cn",
      "linux",
      { XDG_CONFIG_HOME: "/tmp/config" },
      "/home/tester",
    ),
    "/tmp/config/Cindy",
  );
  assert.equal(
    desktopUserDataDirForRegion(
      "dev",
      "win32",
      { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      "C:\\Users\\tester",
    ),
    "C:\\Users\\tester\\AppData\\Roaming\\CindyDev",
  );
});

test("desktop dev region defaults to global and keeps the legacy env fallback", () => {
  assert.equal(resolveDesktopDevRegion([], {}), "global");
  assert.equal(resolveDesktopDevRegion([], { CINDY_AUTH_REGION: "cn" }), "cn");
});

test("desktop dev region accepts both CLI forms and overrides the legacy env", () => {
  assert.equal(resolveDesktopDevRegion(["--region=global"], {}), "global");
  assert.equal(
    resolveDesktopDevRegion(["--region", "cn"], {
      CINDY_AUTH_REGION: "global",
    }),
    "cn",
  );
});

test("desktop dev region rejects missing, duplicate, and unsupported values", () => {
  assert.throws(
    () => resolveDesktopDevRegion(["--region"], {}),
    /requires a value/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=us"], {}),
    /expected cn, global or dev/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=cn", "--region", "global"], {}),
    /may only be specified once/,
  );
});

test("remote dev selects the repository manifest matching the region", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: [],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=cn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
});

test("local dev applies the explicit region to the child environment", () => {
  const env = { VITE_CINDY_AUTH_REGION: "global" };
  assert.deepEqual(
    applyDesktopDevStartupConfig({
      argv: ["start", "--", "--region=cn"],
      env,
      mode: "local",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: undefined,
    },
  );
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "cn",
    VITE_CINDY_AUTH_REGION: "cn",
  });
});

test("--endpoints-cdn keeps the selected region and bypasses the default local manifest", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global", "--endpoints-cdn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: true,
      endpointManifestFile: undefined,
    },
  );
});

test("--endpoints-cdn applies the selected region to the child process environment", () => {
  const env = {};
  applyDesktopDevStartupConfig({
    argv: ["--region=global", "--endpoints-cdn"],
    env,
    mode: "remote",
  });
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "global",
    VITE_CINDY_AUTH_REGION: "global",
    XDT_ENDPOINTS_CDN: "1",
  });
});

test("direct dev consumes the region flag before launching Electron Forge", () => {
  assert.deepEqual(
    stripDesktopDevRegionArgs([
      "start",
      "--",
      "--region",
      "global",
      "--passive",
    ]),
    ["start", "--", "--passive"],
  );
  assert.deepEqual(stripDesktopDevRegionArgs(["start", "--region=global"]), [
    "start",
  ]);
});

test("local server debugging retains its endpoint manifest", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: { XDT_ENDPOINT_MANIFEST_FILE: "config/custom-endpoint.json" },
      mode: "local",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/custom-endpoint.json",
    },
  );
});

// ── worktree 自动隔离（issue #2635）──────────────────────────────────────────

const worktreeCwd = (...segments) => path.join(".cindy-worktrees", ...segments);

test("worktreeNameFromPath extracts the name from worktree root and nested cwd", () => {
  assert.equal(worktreeNameFromPath(worktreeCwd("epic-thompson")), "epic-thompson");
  assert.equal(
    worktreeNameFromPath(worktreeCwd("epic-thompson", "apps", "desktop")),
    "epic-thompson",
  );
  // 迁移前的旧目录形态同样识别
  assert.equal(
    worktreeNameFromPath(path.join(".xdt-worktrees", "legacy-tree")),
    "legacy-tree",
  );
  // 非 worktree 路径一律 null
  assert.equal(worktreeNameFromPath(path.join("somewhere", "else")), null);
  assert.equal(worktreeNameFromPath("."), null);
});

test("worktreeRootFromPath returns the checkout root prefix used for the sandbox digest", () => {
  assert.equal(
    worktreeRootFromPath(worktreeCwd("epic-thompson", "apps", "desktop")),
    worktreeCwd("epic-thompson"),
  );
  assert.equal(
    worktreeRootFromPath(path.join(".xdt-worktrees", "legacy-tree")),
    path.join(".xdt-worktrees", "legacy-tree"),
  );
  assert.equal(worktreeRootFromPath(path.join("somewhere", "else")), null);
});

const isolationNamePattern = (base) => new RegExp(`^${base}-[0-9a-f]{6}$`);

test("worktree dev launch auto-derives the named isolation sandbox", () => {
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: {},
    }).worktreeName,
    isolationNamePattern("epic-thompson"),
  );
  // 嵌套 cwd 与 worktree 根派生同一个沙箱名
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson", "apps", "desktop"),
      argv: ["start", "--"],
      env: {},
    }).worktreeName,
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: {},
    }).worktreeName,
  );
  // 旧目录形态同样命中
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: path.join(".xdt-worktrees", "legacy-tree"),
      argv: [],
      env: {},
    }).worktreeName,
    isolationNamePattern("legacy-tree"),
  );
});

test("auto sandbox names include a checkout digest so same-named worktrees never collide", () => {
  // 两个 clone 里同名 worktree（或名为 dev 的 worktree）不能落进同一个沙箱，
  // 否则会共享登录数据与派生 deviceId（review-pr P2, PR #2640）。
  const nameOf = (root) =>
    resolveWorktreeIsolationFromCwd({
      cwd: path.join(root, ".cindy-worktrees", "same-name"),
      argv: [],
      env: {},
    }).worktreeName;
  const first = nameOf(path.join("clone-a"));
  const second = nameOf(path.join("clone-b"));
  assert.match(first, isolationNamePattern("same-name"));
  assert.match(second, isolationNamePattern("same-name"));
  assert.notEqual(first, second);
  assert.ok(first.length <= 32);
  assert.ok(second.length <= 32);
});

test("auto sandbox name applies the checkout volume's case-folding semantics", async () => {
  // 摘要默认按平台猜大小写；自动路径必须复用 restart 的卷探测结果，否则 macOS
  // 大小写敏感卷上两个只差大小写的 checkout 会得到同一摘要（review-pr P2, PR #2640）。
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cindy-worktree-name-"));
  const worktreeRoot = path.join(tempRoot, ".cindy-worktrees", "same-name");
  await mkdir(worktreeRoot, { recursive: true });
  try {
    assert.deepEqual(
      resolveWorktreeIsolationFromCwd({ cwd: worktreeRoot, argv: [], env: {} }),
      {
        worktreeName: isolationNameFromWorktree(
          worktreeRoot,
          foldCaseOption(worktreeRoot),
        ),
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("foldCaseOption falls back to the platform default for a missing checkout", () => {
  assert.deepEqual(
    foldCaseOption(path.join(".cindy-worktrees", "definitely-missing-checkout")),
    {},
  );
});

test("worktree dev launch honors explicit isolation/sharing intent and never overrides it", () => {
  for (const argv of [
    ["--isolated"],
    ["--isolated=feature-a"],
    ["--passive"],
    ["start", "--", "--isolated=feature-a"],
  ]) {
    assert.equal(
      resolveWorktreeIsolationFromCwd({
        cwd: worktreeCwd("epic-thompson"),
        argv,
        env: {},
      }),
      null,
      `argv ${JSON.stringify(argv)} must suppress auto-isolation`,
    );
  }
  // 裸 dev 路径上的 --preserve-running 不豁免自动隔离：Electron 侧不认这个参数
  // （只有 restart 会翻译成 XDT_SCHEDULER_PASSIVE=1），豁免它会共享 userData 却
  // 正常调度 + 正常单实例锁，造成定时任务重复 / 无法再开预览（review-pr P1）。
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: ["--preserve-running"],
      env: {},
    }).worktreeName,
    isolationNamePattern("epic-thompson"),
  );
  // XDT_ISOLATED / XDT_USER_DATA_DIR / XDT_SCHEDULER_PASSIVE 单独出现**均不豁免**：
  // 它们都可能是宿主 Desktop（以 --isolated / --passive 模式运行）留在 process.env
  // 的变量，会沿 Electron → agent 子进程继承（buildCodexEnv / PI spawn env 复制
  // process.env）——agent 在 worktree 跑裸 dev:remote 时若凭它们豁免会复用宿主
  // userData（单实例锁冲突退出 / passive 并发开沙箱）或重新共享 profile/deviceId
  // 互踢（review-pr P1×3，PR #2640）。restart 链路仅由 XDT_RESTART_MANAGED 识别。
  for (const env of [
    { XDT_ISOLATED: "1" },
    { XDT_USER_DATA_DIR: "C:\\custom\\profile" },
    { XDT_SCHEDULER_PASSIVE: "1" },
    { XDT_ISOLATED: "1", XDT_USER_DATA_DIR: "C:\\custom\\profile", XDT_SCHEDULER_PASSIVE: "1" },
  ]) {
    assert.match(
      resolveWorktreeIsolationFromCwd({
        cwd: worktreeCwd("epic-thompson"),
        argv: [],
        env,
      }).worktreeName,
      isolationNamePattern("epic-thompson"),
      `env ${JSON.stringify(env)} must not suppress auto-isolation (agent inheritance)`,
    );
  }
  // restart 链路显式表态：参数契约由 restart 自己负责（无参 / --passive 默认
  // --isolated=dev，--shared / --preserve-running 共享），自动隔离兜底不得静默覆盖
  // restart 已选定的沙箱（review-pr P1，PR #2640）
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1" },
    }),
    null,
  );
  // restart --passive：XDT_RESTART_MANAGED + XDT_SCHEDULER_PASSIVE 都在 → 不干预
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1", XDT_SCHEDULER_PASSIVE: "1" },
    }),
    null,
  );
});

test("worktree dev launch outside a managed worktree keeps the shared-profile semantics", () => {
  assert.equal(
    resolveWorktreeIsolationFromCwd({ cwd: path.join("base", "repo"), argv: [], env: {} }),
    null,
  );
  assert.equal(
    resolveWorktreeIsolationFromCwd({ cwd: ".", argv: [], env: {} }),
    null,
  );
});

test("worktree dev launch falls back to the default sandbox for invalid names", () => {
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("invalid-name-with-1234567890-1234567890-1234567890-123"),
      argv: [],
      env: {},
    }),
    { worktreeName: null },
  );
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("has space"),
      argv: [],
      env: {},
    }),
    { worktreeName: null },
  );
});

// ── restart 一跳标记 / 裸 preserve-running（review-pr P1，PR #2640）─────────────

test("restart marker is one-hop: honored during launch decision but stripped from the Electron env", () => {
  // 判定必须用含 XDT_RESTART_MANAGED 的环境：restart 链路（无参 / --passive 默认
  // --isolated=dev，--shared / --preserve-running 共享）靠它识别「受 restart 管理」
  // 而免于自动隔离（review-pr P2 指正）。标记的删除发生在 dev-remote-env 判定之后、
  // 传给 Electron 的 env 上（防 agent 子进程继承）。
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1" },
    }),
    null,
  );
  // restart --passive 透传 XDT_SCHEDULER_PASSIVE=1 → 共享意图被识别不干预
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1", XDT_SCHEDULER_PASSIVE: "1" },
    }),
    null,
  );
  // restart --isolated：XDT_RESTART_MANAGED + XDT_ISOLATED 都在 → 豁免（restart 链路
  // 参数契约，隔离沙箱语义由 restart 自己管理）
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1", XDT_ISOLATED: "1", XDT_USER_DATA_DIR: "C:\\custom\\profile" },
    }),
    null,
  );
  // 无标记（agent 子进程场景）→ worktree 裸启动命中自动隔离（#2635 防护恢复）
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: {},
    }).worktreeName,
    isolationNamePattern("epic-thompson"),
  );
});

test("bare dev:remote with --preserve-running in a worktree is isolated (no silent shared userData)", () => {
  // 裸路径（不经 restart）--preserve-running 不被豁免：Electron 侧不认该参数，
  // 豁免会导致共享 userData 却正常调度 + 正常单实例锁（定时任务重复 / 预览失败）。
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: ["--preserve-running"],
      env: {},
    }).worktreeName,
    isolationNamePattern("epic-thompson"),
  );
  // 继承的 XDT_SCHEDULER_PASSIVE 单独出现不豁免（agent 子进程场景，防绕过隔离）
  assert.match(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_SCHEDULER_PASSIVE: "1" },
    }).worktreeName,
    isolationNamePattern("epic-thompson"),
  );
  // 但 restart 链路的 --preserve-running 经 XDT_RESTART_MANAGED 表达共享意图
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1", XDT_SCHEDULER_PASSIVE: "1" },
    }),
    null,
  );
});

// ── 自动隔离的环境处理（review-pr P1，PR #2640）──────────────────────────────

test("applyWorktreeIsolationEnv clears host-inherited launch overrides and injects the sandbox", () => {
  // 宿主 dev Desktop → agent 子进程：XDT_DESKTOP_DEV_MODE 是 wrapper 注入 Electron
  // 的继承信号；userData / epoch / device override / passive / 旧隔离名都可能是宿主
  // 残留，必须清除，否则 resolveDevCliFlags 会复用宿主 profile/deviceId。
  const inherited = {
    XDT_DESKTOP_DEV_MODE: "remote",
    XDT_USER_DATA_DIR: "C:\\host\\sandbox",
    XDT_USER_DATA_DIR_EPOCH: "1",
    XDT_DEVICE_ID_OVERRIDE: "dev-host-abc",
    XDT_BROWSER_RUNTIME_DIR: "C:\\host\\sandbox\\browser-runtime",
    XDT_SCHEDULER_PASSIVE: "1",
    XDT_ISOLATED_NAME: "host-sandbox",
    XDT_ISOLATED_AUTH: "1",
    XDT_ALLOW_DEV_OAUTH_WRITE: "1",
    XDT_ISOLATED_AUTH_PROOF: "host-proof",
    UNRELATED: "keep",
  };
  const env = applyWorktreeIsolationEnv(inherited, "epic-thompson");
  assert.equal(env.XDT_USER_DATA_DIR, undefined);
  assert.equal(env.XDT_USER_DATA_DIR_EPOCH, undefined);
  assert.equal(env.XDT_DEVICE_ID_OVERRIDE, undefined);
  // 宿主固定的 browser runtime 目录必须清掉，新 Electron 才会按新 userData 重算
  // （否则持久 Cookie/登录态仍写在宿主目录；review-pr P1, PR #2640）。
  assert.equal(env.XDT_BROWSER_RUNTIME_DIR, undefined);
  assert.equal(env.XDT_SCHEDULER_PASSIVE, undefined);
  // isolated-auth 授权只在 restart 本次调用内有效，裸 dev 没有授权路径。
  assert.equal(env.XDT_ISOLATED_AUTH, undefined);
  assert.equal(env.XDT_ALLOW_DEV_OAUTH_WRITE, undefined);
  assert.equal(env.XDT_ISOLATED_AUTH_PROOF, undefined);
  assert.equal(env.XDT_ISOLATED, "1");
  assert.equal(env.XDT_ISOLATED_NAME, "epic-thompson");
  assert.equal(env.UNRELATED, "keep");
  // 宿主信号本身保留（wrapper 会重新注入），便于下游诊断
  assert.equal(env.XDT_DESKTOP_DEV_MODE, "remote");
  // 纯函数：不改入参
  assert.equal(inherited.XDT_USER_DATA_DIR, "C:\\host\\sandbox");
  assert.equal(inherited.XDT_ISOLATED_NAME, "host-sandbox");
  assert.equal(inherited.XDT_BROWSER_RUNTIME_DIR, "C:\\host\\sandbox\\browser-runtime");
});

test("applyWorktreeIsolationEnv clears restart-derived userData even without the dev-host marker", () => {
  // XDT_USER_DATA_DIR_EPOCH=1 是 restart 派生目录的可信纪元信号；裸 dev 路径上出现
  // 它只可能是继承自宿主（restart 链路自身带 XDT_RESTART_MANAGED，不会进入自动隔离）。
  const env = applyWorktreeIsolationEnv(
    {
      XDT_USER_DATA_DIR: "/host/sandbox",
      XDT_USER_DATA_DIR_EPOCH: "1",
      XDT_DEVICE_ID_OVERRIDE: "dev-host-abc",
      XDT_BROWSER_RUNTIME_DIR: "/host/sandbox/browser-runtime",
    },
    "epic-thompson",
  );
  assert.equal(env.XDT_USER_DATA_DIR, undefined);
  assert.equal(env.XDT_USER_DATA_DIR_EPOCH, undefined);
  assert.equal(env.XDT_DEVICE_ID_OVERRIDE, undefined);
  assert.equal(env.XDT_BROWSER_RUNTIME_DIR, undefined);
  assert.equal(env.XDT_ISOLATED, "1");
  assert.equal(env.XDT_ISOLATED_NAME, "epic-thompson");
});

test("applyWorktreeIsolationEnv respects a human-set userData override", () => {
  // 人肉在 shell 里显式设 XDT_USER_DATA_DIR（无宿主信号）时按 docs「已手动设则尊重」
  // 保留；自动隔离只补隔离意图与独立 deviceId，不静默改目录（review-pr P1, PR #2640）。
  // isolated-auth 标记例外：它们不是用户配置，裸 dev 一律清除。
  const env = applyWorktreeIsolationEnv(
    {
      XDT_USER_DATA_DIR: "D:\\my\\custom-profile",
      XDT_DEVICE_ID_OVERRIDE: "my-device",
      XDT_BROWSER_RUNTIME_DIR: "D:\\my\\browser-runtime",
      XDT_ISOLATED_AUTH: "1",
      XDT_ALLOW_DEV_OAUTH_WRITE: "1",
      XDT_ISOLATED_AUTH_PROOF: "human-proof",
    },
    "epic-thompson",
  );
  assert.equal(env.XDT_USER_DATA_DIR, "D:\\my\\custom-profile");
  assert.equal(env.XDT_DEVICE_ID_OVERRIDE, "my-device");
  assert.equal(env.XDT_BROWSER_RUNTIME_DIR, "D:\\my\\browser-runtime");
  assert.equal(env.XDT_ISOLATED_AUTH, undefined);
  assert.equal(env.XDT_ALLOW_DEV_OAUTH_WRITE, undefined);
  assert.equal(env.XDT_ISOLATED_AUTH_PROOF, undefined);
  assert.equal(env.XDT_ISOLATED, "1");
  assert.equal(env.XDT_ISOLATED_NAME, "epic-thompson");
});

test("applyWorktreeIsolationEnv drops an inherited isolation name when the worktree name is invalid", () => {
  // worktree 名不合法 → 回落默认沙箱；若沿用宿主 --isolated=<名> 留下的名字，
  // userData/deviceId 会落回宿主沙箱（review-pr P1, PR #2640）。
  const env = applyWorktreeIsolationEnv(
    { XDT_ISOLATED_NAME: "host-sandbox", XDT_DESKTOP_DEV_MODE: "remote" },
    null,
  );
  assert.equal(env.XDT_ISOLATED, "1");
  assert.equal(env.XDT_ISOLATED_NAME, undefined);
});

test("applyWorktreeIsolationEnv leaves unrelated env untouched and never mutates its input", () => {
  const original = { A: "1" };
  assert.deepEqual(applyWorktreeIsolationEnv(original, null), {
    A: "1",
    XDT_ISOLATED: "1",
  });
  assert.deepEqual(original, { A: "1" });
});

test("remote dev replaces inherited manifests for every selected region", () => {
  const manifests = {
    cn: "config/endpoint.json",
    global: "config/endpoint.global.json",
    dev: "config/endpoint.dev.json",
  };
  for (const inherited of [
    ...Object.values(manifests),
    "config/custom-endpoint.json",
  ]) {
    for (const [region, manifest] of Object.entries(manifests)) {
      const env = {
        CINDY_AUTH_REGION: "cn",
        VITE_CINDY_AUTH_REGION: "cn",
        XDT_ENDPOINT_MANIFEST_FILE: inherited,
      };
      applyDesktopDevStartupConfig({ argv: [`--region=${region}`], env });
      assert.equal(env.CINDY_AUTH_REGION, region);
      assert.equal(env.VITE_CINDY_AUTH_REGION, region);
      assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, manifest);
      // The downstream dev wrapper parses the environment again without CLI flags.
      applyDesktopDevStartupConfig({ argv: [], env });
      assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, manifest);
    }
  }
});

test("switching regions in the same environment also switches the endpoint file", () => {
  const env = {};
  for (const region of ["cn", "global", "dev", "cn"]) {
    const config = applyDesktopDevStartupConfig({
      argv: [`--region=${region}`],
      env,
    });
    assert.equal(config.region, region);
    assert.equal(
      env.XDT_ENDPOINT_MANIFEST_FILE,
      `config/endpoint${region === "cn" ? "" : `.${region}`}.json`,
    );
  }
});

test("remote CDN startup removes inherited files and remains CDN through the child wrapper", () => {
  for (const argv of [
    ["--region=global", "--endpoints-cdn"],
    ["--region=global"],
  ]) {
    const env = {
      XDT_ENDPOINT_MANIFEST_FILE: "config/endpoint.json",
      XDT_ENDPOINTS_CDN: "1",
    };
    applyDesktopDevStartupConfig({ argv, env });
    assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, undefined);
    assert.deepEqual(applyDesktopDevStartupConfig({ argv: [], env }), {
      region: "global",
      endpointsCdn: true,
      endpointManifestFile: undefined,
    });
  }
});
