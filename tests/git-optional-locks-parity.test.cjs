'use strict';

/**
 * #5048 — GIT_OPTIONAL_LOCKS=0 must reach every read-only git spawn.
 *
 * By default several read-only git commands refresh the index and take an
 * *optional* `.git/index.lock` to write the refreshed copy back. That write is
 * a contender for the lock a real `git add` / `git commit` needs, so a read can
 * fail someone else's commit with
 * `Unable to create '.git/index.lock': File exists`. `GIT_OPTIONAL_LOCKS=0`
 * disables only those optional index operations.
 *
 * ## Why this file is split in two
 *
 * **Part A proves the env behaviorally.** It calls each real seam — the actual
 * `execGit`, `readGitSignals` (through `detectSignals`), `gitExec`, the
 * statusline's `readGitStatus`, and both pre-write hooks' local `git()` — with
 * `node:child_process` intercepted, and asserts on the options object the
 * production code hands the OS. An earlier revision of this file asserted the
 * same fact by reading `src/` and `hooks/` as text and regex-matching for the
 * variable inside a ±24-line window. That was a source-grep test
 * (`RULESET.TESTS.no-source-grep`), and it was not merely unfashionable: a
 * *comment* naming GIT_OPTIONAL_LOCKS satisfied the window with no env set at
 * all, and a spawn routed through a variable or a wrapper was invisible to the
 * scan. Observing the spawn removes both failure modes — the observable is the
 * value that reaches the OS, so a comment cannot forge it and an unlisted route
 * cannot hide it.
 *
 * **Part B is the no-silent-gap guard, and stays structural.** Its job is a
 * question the behavioral probes structurally cannot answer: not "does this
 * known seam set the variable" but "is there a git spawn site nobody has
 * accounted for". A new `git status` in a new module has no probe to call, so
 * Part B enumerates the spawn sites and requires every read-only one to be
 * *classified* — index-refreshing (must be owned by a Part-A probe) or
 * explicitly index-free with a written reason. The allowlist is CLOSED: an
 * unrecognized read-only subcommand fails here rather than passing silently.
 * That is the difference between a list and an allowlist, and it is what makes
 * the header's "cannot be added silently" true.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { recordSpawns, gitSubcommand } = require('./helpers/git-optional-locks-probe.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// Runtime surfaces only. scripts/ is build-and-CI tooling that runs once per job
// against a checkout nobody is committing into, and gsd-core/bin/lib is
// generated from src/ — neither is the shipped read path this issue is about.
const SCAN_DIRS = ['src', 'hooks'];
const SCAN_EXT = new Set(['.cts', '.js', '.cjs', '.ts']);

/**
 * Git subcommands that open (and may refresh) the index on a read-only call.
 * These are the ones GIT_OPTIONAL_LOCKS=0 actually changes behaviour for.
 * `git diff` only refreshes with an index operand, so it is matched on argv.
 */
const INDEX_REFRESHING = new Set(['status', 'diff-index', 'diff-files']);

/**
 * Index-free read-only commands, with the reason each is exempt. This is a
 * CLOSED allowlist: a read-only subcommand that is neither here nor
 * index-refreshing fails Part B, so adding a new read-only command is a
 * deliberate act with a written justification rather than an omission.
 * An empty or token reason would defeat the guard, so `every exemption carries a
 * checkable reason` enforces that every entry says something a reviewer could
 * verify.
 */
const INDEX_FREE = {
  'diff': 'git diff A B compares two trees and never reads the index; `git diff` with no operand does refresh, and `refreshesIndex` matches that argv.',
  'log': 'walks the commit graph only.',
  'rev-parse': 'reads .git config and refs, not the index.',
  'rev-list': 'walks the commit graph only.',
  'worktree': '`worktree list` reads .git/worktrees, not the index.',
  'ls-tree': 'reads tree objects only.',
  'show': 'reads a tree or blob object only.',
  'ls-files': 'reads the index but never refreshes or rewrites it.',
  'describe': 'reads commit objects only.',
  'branch': '`branch --show-current` / `branch <name>` reads refs; the listing form never refreshes the index.',
  'worktree-list': 'alias spelling of `worktree list`; reads .git/worktrees.',
  'symbolic-ref': 'reads .git/HEAD or a ref file; no index access.',
  'merge-base': 'walks the commit graph to find common ancestors; no index access.',
  'cat-file': 'reads a single object out of the object database; no index access.',
  'check-ignore': 'consults .gitignore (and the index for pathspec matching) but never refreshes or writes the index.',
  'ls-remote': 'contacts a remote and reads its refs; never opens the local index.',
};

/**
 * Subcommands that MUTATE. A writing command legitimately needs the optional
 * lock, so requiring GIT_OPTIONAL_LOCKS=0 there would be wrong. `git commit` /
 * `git add` take the lock anyway and ignore the variable.
 */
const MUTATING = new Set([
  'add', 'commit', 'rm', 'mv', 'reset', 'checkout', 'restore', 'revert',
  'merge', 'rebase', 'cherry-pick', 'stash', 'clean', 'apply', 'stage',
  'update-index', 'write-tree', 'commit-tree', 'gc', 'prune', 'fetch', 'pull',
  'push', 'clone', 'init', 'remote', 'tag', 'config', 'blame', 'bisect',
]);

// ---------------------------------------------------------------------------
// Part A — behavioral: what the real seams hand the OS
// ---------------------------------------------------------------------------

/**
 * Invoke `fn` with child_process intercepted; return the recorded spawns.
 * Restoring happens in `finally`, but the RETURN is outside it — a `return`
 * inside `finally` discards an in-flight throw (no-unsafe-finally).
 */
function captureSpawns(fn, stdoutFor) {
  const restore = recordSpawns(undefined, stdoutFor);
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  const calls = restore();
  if (thrown) throw thrown;
  return calls;
}

function gitSpawns(calls) {
  return calls.filter(c => /(^|[\\/])git$/.test(c.file) || c.file === 'git');
}

function assertLockedOut(spawns, label) {
  assert.ok(spawns.length > 0, `${label}: no git spawn was intercepted, so nothing was proven`);
  for (const spawn of spawns) {
    assert.equal(
      spawn.env.GIT_OPTIONAL_LOCKS,
      '0',
      `${label}: git ${spawn.argv.slice(1).join(' ')} reached the OS without GIT_OPTIONAL_LOCKS=0`,
    );
  }
}

describe('#5048 every read-only seam hands GIT_OPTIONAL_LOCKS=0 to the OS', () => {
  test('execGit — the shared git seam', () => {
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const calls = captureSpawns(() => {
      // `status` is index-refreshing, so this is the case that matters.
      execGit(['status', '--porcelain']);
      // Index-free calls ride the same env; assert one so the shared env is
      // pinned for the whole seam and not only for the refreshing subclass.
      execGit(['rev-parse', '--show-toplevel']);
    });
    assertLockedOut(gitSpawns(calls), 'execGit');
  });

  test('a caller can still opt back in through opts.env (the escape hatch is real)', () => {
    // execGit spreads opts.env LAST on purpose, so a caller that genuinely wants
    // the optional index write (a status whose freshness it wants persisted)
    // can re-enable it. Without this, "set it everywhere" would be a trap.
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const calls = captureSpawns(() => {
      execGit(['status'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    });
    const spawns = gitSpawns(calls);
    assert.ok(spawns.length > 0, 'no git spawn intercepted');
    assert.equal(spawns[0].env.GIT_OPTIONAL_LOCKS, '1');
  });

  test('smart-entry readGitSignals, reached through detectSignals', () => {
    // readGitSignals is module-private; detectSignals is its only caller and is
    // exported, so this drives the real code path rather than a stand-in.
    const { detectSignals } = require('../gsd-core/bin/lib/smart-entry.cjs');
    const calls = captureSpawns(() => {
      detectSignals(REPO_ROOT);
    });
    const git = gitSpawns(calls);
    assert.ok(git.length > 0, 'smart-entry spawned no git; the probe is broken');
    // `status` must be among them — that is the index-refreshing call the fix
    // is about. If a refactor removes it, say so instead of passing vacuously.
    assert.ok(
      git.some(s => gitSubcommand(s.argv) === 'status'),
      `smart-entry no longer runs \`git status\`; saw ${git.map(s => s.argv.join(' ')).join(' | ')}`,
    );
    assertLockedOut(git, 'smart-entry');
  });

  test('pristine-baseline gitExec', () => {
    const { gitExec } = require('../gsd-core/bin/lib/pristine-baseline.cjs');
    const calls = captureSpawns(() => {
      gitExec(REPO_ROOT, ['log', '--format=%H', '-1']);
    });
    assertLockedOut(gitSpawns(calls), 'gitExec');
  });

  test('gsd-statusline readGitStatus', () => {
    const { readGitStatus } = require('../hooks/gsd-statusline.js');
    const calls = captureSpawns(
      () => readGitStatus(REPO_ROOT),
      // A plausible `--porcelain=v2 --branch` answer, so the function runs its
      // real post-spawn parsing instead of failing on an empty string.
      argv => (/--branch/.test(argv.join(' '))
        ? '# branch.oid deadbeef\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb staged.cjs\n'
        : ''),
    );
    const git = gitSpawns(calls);
    assert.ok(git.length > 0, 'readGitStatus spawned no git; the probe is broken');
    assert.ok(
      git.some(s => gitSubcommand(s.argv) === 'status'),
      `readGitStatus no longer runs \`git status\`; saw ${git.map(s => s.argv.join(' ')).join(' | ')}`,
    );
    assertLockedOut(git, 'gsd-statusline');
  });
});

/**
 * The two pre-write hooks are standalone scripts: they read a JSON envelope on
 * stdin and exit, and their `git()` helper is module-private with no export. So
 * they are driven the way they actually run — as a subprocess with
 * `node:child_process` intercepted by a preload, and a real envelope on stdin.
 * The hook's own allow/block decision is irrelevant here; the assertion is on
 * the env the captured `git()` handed the OS.
 */
const HOOK_CAPTURE_PRELOAD = `
  const fs = require('node:fs');
  const childProcess = require('node:child_process');
  const calls = [];
  const record = (callee) => (file, args, opts) => {
    calls.push({ file: String(file), argv: (Array.isArray(args) ? args : [args]).map(String),
                 env: (opts && opts.env) || {} });
    return { status: 0, stdout: 'root\\n', stderr: '', error: undefined };
  };
  for (const name of ['execFileSync', 'spawnSync', 'execSync', 'exec']) {
    childProcess[name] = record(name);
  }
  process.on('exit', () => {
    try { fs.writeFileSync(process.env.GSD_LOCKS_CAPTURE, JSON.stringify(calls)); } catch {}
  });
`;

/**
 * The two pre-write hooks read DIFFERENT envelope shapes off stdin, and each
 * bails out before reaching any git() call if its own path field is missing —
 * so driving them with one shared payload silently proves nothing. Each hook
 * therefore carries the minimum envelope that reaches a git() call.
 *
 * gsd-windsurf-pre-write.js: Cascade pre_write_code, tool_info.file_path.
 * gsd-worktree-path-guard.js: tool_input.file_path (falling back to
 *   tool_input.path for the Kimi shape).
 */
const HOOK_ENVELOPES = {
  'hooks/gsd-windsurf-pre-write.js': root => JSON.stringify({
    agent_action_name: 'pre_write_code',
    trajectory_id: 't',
    execution_id: 'e',
    timestamp: '2026-01-01T00:00:00Z',
    model_name: 'test',
    tool_info: { file_path: path.join(root, 'probe.txt'), edits: [] },
  }),
  'hooks/gsd-worktree-path-guard.js': root => JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: path.join(root, 'probe.txt'), content: 'x' },
  }),
};

function runHookAndCapture(t, hookRel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
  t.after(() => helpers.cleanup(root));
  const preload = path.join(root, 'preload.cjs');
  const out = path.join(root, 'spawns.json');
  fs.writeFileSync(preload, HOOK_CAPTURE_PRELOAD);

  const result = runNode(
    ['--require', preload, path.join(REPO_ROOT, hookRel)],
    { input: HOOK_ENVELOPES[hookRel](root), env: { ...process.env, GSD_LOCKS_CAPTURE: out }, timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS },
  );
  assert.ok(result.outcome === 'exited', `driving ${hookRel} did not exit cleanly: ${result.outcome}`);
  assert.ok(fs.existsSync(out), `${hookRel} produced no spawn capture`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

describe('#5048 the two pre-write hooks set the variable on their own git()', () => {
  for (const hook of Object.keys(HOOK_ENVELOPES)) {
    test(`${hook} — driven as the real hook process`, (t) => {
      const calls = runHookAndCapture(t, hook);
      const git = gitSpawns(calls);
      assert.ok(git.length > 0, `${hook} spawned no git through its own helper`);
      assertLockedOut(git, hook);
    });
  }
});

// ---------------------------------------------------------------------------
// Part B — structural: no git spawn site goes unaccounted for
// ---------------------------------------------------------------------------

/** Direct git spawns, with the argv if it is a literal and the callee if not. */
const SPAWN_RE =
  /(?:execFileSync|spawnSync|execSync|exec)\(\s*(['"`])git\1\s*,\s*(\[[^\]]*\]|\w+)/g;

/** `execGit(args, …)` and the per-hook `git(args, …)` helpers. */
const HELPER_CALL_RE = /\b(execGit|git)\(\s*(\[[^\]]*\]|\w+)/g;

/**
 * A git spawn routed through a variable or a wrapper — the shape the first
 * SPAWN_RE missed, which is how F2(c)'s "an unseen site passes silently" arose.
 * Matching the *call* to any expression (not just `git`) and then classifying by
 * what the argument resolves to keeps `gitCmd(...)` and `run(argv)` visible.
 */
const ROUTED_SPAWN_RE =
  /\b(?:execFileSync|spawnSync|execSync|exec)\(\s*([A-Za-z_$][\w$]*)\s*,\s*(\[[^\]]*\])/g;

/** Build output directories that must not be scanned. */
const SKIP_DIRS = new Set(['dist', 'node_modules']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // hooks/dist/ is gitignored build output (npm run build:hooks copies the
      // hooks there for installation). Scanning it would count every hook site
      // twice — once as source, once as its own copy — which is precisely the
      // noise that makes a scan guard get switched off.
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const SCANNED = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));
const SOURCE = new Map(SCANNED.map((f) => [f, fs.readFileSync(f, 'utf8')]));

/**
 * Where each git helper is *defined*. A call site inherits the variable from its
 * helper, not from its own argument object: `execGit` is defined in one module
 * and called from five others, so without this resolution every caller reads as
 * an offender and the guard would be noise.
 *
 * splitLines, not split('\n'): Windows git-autocrlf yields \r\n, and a
 * CRLF-fragile split here would silently shift every line number on Windows
 * (DEFECT.WINDOWS-CRLF-TEST-PORTABILITY).
 */
function helperDefinitions() {
  const global = new Map();
  const perFile = new Map();
  for (const [file, src] of SOURCE) {
    const local = new Map();
    splitLines(src).forEach((line, i) => {
      const m = /^\s*(?:export\s+)?function\s+(execGit|git)\s*\(/.exec(line);
      if (!m) return;
      local.set(m[1], { file, line: i + 1 });
      if (!global.has(m[1])) global.set(m[1], { file, line: i + 1 });
    });
    perFile.set(file, local);
  }
  return { global, perFile };
}

const HELPERS = helperDefinitions();

/** git global options that consume the following token as their value. */
const VALUE_TAKING = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

/** Split an argv LITERAL (source text) into tokens, honouring quotes. */
function tokenizeArgv(argv) {
  if (!argv.startsWith('[')) return null;
  const body = argv.replace(/^\[/, '').replace(/\]$/, '');
  const tokens = [];
  let cur = '';
  let quote = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === ',') { tokens.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  tokens.push(cur.trim());
  return tokens.filter(t => t.length > 0);
}

/**
 * The subcommand of an argv literal, skipping leading git global options and
 * the values they consume. `['-C', cloneDir, 'checkout', …]` is a `checkout`,
 * not a `-C`. Returns null when the argv is not a readable literal — which the
 * classifier treats as the conservative side of the doubt.
 */
function subcommandOf(argv) {
  const tokens = tokenizeArgv(argv);
  if (tokens === null) return null;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) return tokens[i];
    if (VALUE_TAKING.test(tokens[i])) i++;
  }
  return null;
}

/**
 * Classification of one git spawn: 'refreshing' | 'free' | 'mutating' |
 * 'unclassified'. `unclassified` is the F2(b) fix — it used to be a silent pass
 * for any subcommand not in the hardcoded INDEX_REFRESHING list, so `branch`,
 * `stash`, `describe --dirty` and friends sailed through unflagged.
 */
function classify(subcommand, argv) {
  if (subcommand === null) return 'unclassified';
  if (MUTATING.has(subcommand)) return 'mutating';
  if (INDEX_REFRESHING.has(subcommand)) return 'refreshing';
  if (subcommand === 'diff') {
    const tokens = tokenizeArgv(argv) || [];
    // tokens[0] is the subcommand; a bare `diff` has nothing left after it.
    return tokens.length < 2 ? 'refreshing' : 'free';
  }
  if (subcommand in INDEX_FREE) return 'free';
  return 'unclassified';
}

/** Every git spawn site in the runtime surfaces, with its classification. */
function collectSites() {
  const sites = [];
  for (const [file, src] of SOURCE) {
    const rel = path.relative(REPO_ROOT, file);
    for (const re of [SPAWN_RE, HELPER_CALL_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const argv = m[2];
        const callee = re === HELPER_CALL_RE ? m[1] : null;
        const line = src.slice(0, m.index).split('\n').length;
        const subcommand = subcommandOf(argv);
        const def = callee
          ? (HELPERS.perFile.get(file) || new Map()).get(callee) || HELPERS.global.get(callee)
          : null;
        sites.push({
          file: rel,
          line,
          subcommand,
          kind: classify(subcommand, argv),
          owner: def ? { file: path.relative(REPO_ROOT, def.file), line: def.line } : { file: rel, line },
        });
      }
    }
  }
  return sites;
}

const SITES = collectSites();

describe('#5048 no git spawn site is unaccounted for', () => {
  test('the enumeration finds the shipped read-only surfaces', () => {
    // Guards the guard: a near-empty scan would make every other assertion here
    // vacuously true, which is the failure mode a source-scan guard has.
    // Asserted structurally, not by filename — upstream's #5139 gate-modules
    // refactor moved two git calls out of src/check-command-router.cts and
    // turned an earlier filename-pinned draft into a red build for an unrelated
    // refactor.
    assert.ok(SITES.length >= 8, `only found ${SITES.length} git spawn sites`);
    assert.ok(
      new Set(SITES.map((s) => s.file)).size >= 4,
      'git is expected to be spawned from more than one module',
    );

    const execGitDef = HELPERS.global.get('execGit');
    assert.ok(execGitDef, 'the shared execGit seam was not found');
    assert.match(
      path.relative(REPO_ROOT, execGitDef.file),
      /^src[\\/]/,
      'execGit must live under src/',
    );
    assert.ok(
      SITES.some((s) => s.file === 'hooks/gsd-statusline.js'),
      'the statusline git spawn was not found',
    );
    assert.ok(
      SITES.some((s) => s.subcommand === 'status' && s.kind === 'refreshing'),
      'no index-refreshing `git status` site found; the scan is probably broken',
    );
  });

  test('every read-only site is classified; an unknown subcommand fails here', () => {
    // The point of the closed allowlist. A site whose subcommand this guard
    // cannot classify is NOT silently allowed: adding a new read-only git
    // command has to be a deliberate act with a written INDEX_FREE reason.
    const unclassified = SITES.filter(
      s => s.kind === 'unclassified' && s.subcommand !== null,
    );
    assert.deepStrictEqual(
      unclassified.map(s => `${s.file}:${s.line} -> git ${s.subcommand}`),
      [],
      'These read-only git subcommands are neither index-refreshing, mutating, '
      + 'nor on the INDEX_FREE allowlist. If one is genuinely index-free, add it '
      + 'to INDEX_FREE with a reason a reviewer can check; if it refreshes the '
      + 'index, it needs GIT_OPTIONAL_LOCKS=0.',
    );
  });

  test('every index-free exemption carries a checkable reason', () => {
    for (const [cmd, reason] of Object.entries(INDEX_FREE)) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 20, `${cmd} exemption has no substantive reason`);
    }
  });

  test('a site is never exempted as index-free and refreshing at once', () => {
    // If a command on the allowlist turns out to refresh, the exemption must be
    // deleted rather than the assertion loosened.
    for (const site of SITES) {
      if (site.subcommand && site.subcommand in INDEX_FREE) {
        assert.notEqual(site.kind, 'refreshing', `${site.subcommand} is exempted and refreshing at once`);
      }
    }
  });

  test('a helper-routed call resolves to the helper that owns the env', () => {
    // The failure this catches: execGit is called from five modules and defined
    // in a sixth, so an unresolved caller would either be a false offender or,
    // worse, silently skipped.
    const routed = SITES.filter((s) => s.owner.file !== s.file);
    assert.ok(routed.length >= 3, `expected callers routed through a helper, saw ${routed.length}`);
    for (const site of routed) {
      assert.ok(site.owner.line > 0, `${site.file}:${site.line} resolved to no owner line`);
    }
  });

  test('every index-refreshing site is owned by a seam Part A drives', () => {
    // Closes the loop between the two halves: an index-refreshing site whose
    // owner is neither probed behaviorally above nor routed through execGit is
    // a hole — nothing asserts its env. `hooks/gsd-pr-bran-*.js` are the
    // scripted hook wrappers the spawn scan resolves to `git()`.
    const probedOwners = new Set([
      'src/shell-command-projection.cts',
      'src/smart-entry.cts',
      'src/pristine-baseline.cts',
      'hooks/gsd-statusline.js',
      'hooks/gsd-windsurf-pre-write.js',
      'hooks/gsd-worktree-path-guard.js',
    ]);
    const uncovered = SITES.filter(
      s => s.kind === 'refreshing' && s.subcommand === 'status' && !probedOwners.has(s.owner.file),
    );
    assert.deepStrictEqual(
      uncovered.map(s => `${s.file}:${s.line} -> owner ${s.owner.file}:${s.owner.line}`),
      [],
      'An index-refreshing `git status` site exists whose env is asserted by '
      + 'neither a Part-A behavioral probe nor the execGit seam. Add a probe.',
    );
  });
});

// Referenced by the classification table above; exported so the closure is
// auditable from the test rather than re-derived at each call site.
module.exports = { classify, collectSites, INDEX_FREE, MUTATING, INDEX_REFRESHING, ROUTED_SPAWN_RE };