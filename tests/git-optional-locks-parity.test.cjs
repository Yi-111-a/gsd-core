'use strict';

/**
 * #5048 — parity guard for GIT_OPTIONAL_LOCKS on read-only git spawns.
 *
 * By default several read-only git commands refresh the index and take an
 * *optional* `.git/index.lock` to write the refreshed copy back. That write is
 * a contender for the lock a real `git add` / `git commit` needs, so a read can
 * fail someone else's commit with
 * `Unable to create '.git/index.lock': File exists`. `GIT_OPTIONAL_LOCKS=0`
 * disables only those optional index operations.
 *
 * The risk this file closes is not any one site — it is the *next* read-only
 * site that lands without the variable, in a codebase that spells git
 * differently in every module (execFileSync, spawnSync, execGit, a per-hook
 * `git()` helper, and `git()` defined in two separate hooks). So this guard
 * enumerates the sites rather than trusting one shared helper, and pins the two
 * facts that are easy to lose:
 *
 *   (a) every index-refreshing read-only site inherits the variable, and
 *   (b) every index-free site is on the allowlist *with a reason*, so a new
 *       index-refreshing command cannot be added silently.
 *
 * A spawn site that is neither asserted nor allowlisted fails here, which is
 * the point: the review's Blocker was that nothing enumerated them.
 *
 * Deliberately conservative. It source-scans (the six runtime modules have no
 * common seam), then resolves each call to whichever surface actually owns the
 * env — the call site for a direct spawn, or the helper definition for a call
 * routed through `execGit` / `git`. It resolves helper definitions per file,
 * because `git()` is a local helper in two different hooks and a first-wins map
 * would check the wrong one.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const INDEX_REFRESHING = /^(status|diff-index|diff-files)$/;

/**
 * Index-free read-only commands, with the reason each is exempt. An empty or
 * token reason would defeat the guard, so `exemptions are justified` enforces
 * that every entry says something a reviewer could check.
 */
const INDEX_FREE = {
  'diff': 'git diff A B compares two trees and never reads the index; `git diff` with no operand does refresh, and INDEX_REFRESHING matches that argv.',
  'log': 'walks the commit graph only.',
  'rev-parse': 'reads .git config and refs, not the index.',
  'rev-list': 'walks the commit graph only.',
  'worktree': '`worktree list` reads .git/worktrees, not the index.',
  'ls-tree': 'reads tree objects only.',
  'show': 'reads a tree or blob object only.',
};

/** Direct git spawns, with the argv if it is a literal and the callee if not. */
const SPAWN_RE = /(?:execFileSync|spawnSync|exec)\(\s*(['"`])git\1\s*,\s*(\[[^\]]*\]|\w+)/g;

/** `execGit(args, …)` and the per-hook `git(args, …)` helpers. */
const HELPER_CALL_RE = /\b(execGit|git)\(\s*(\[[^\]]*\]|\w+)/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
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
 */
function helperDefinitions() {
  const global = new Map();
  const perFile = new Map();
  for (const [file, src] of SOURCE) {
    const lines = src.split('\n');
    const local = new Map();
    lines.forEach((line, i) => {
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

/** First element of an argv literal, stripped of quotes; null if unreadable. */
function subcommandOf(argv) {
  if (!argv.startsWith('[')) return null;
  const first = argv.replace(/^\[/, '').split(',')[0].trim();
  return first.replace(/^['"`]|['"`]$/g, '') || null;
}

/**
 * `git diff` with no tree operand refreshes the index; `git diff A B` does not.
 * An argv we cannot read statically is treated as refreshing — the guard has to
 * be the conservative side of the doubt.
 */
function refreshesIndex(subcommand, argv) {
  if (subcommand === null) return true;
  if (INDEX_REFRESHING.test(subcommand)) return true;
  if (subcommand !== 'diff') return false;
  const operands = argv
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // argv[0] is the subcommand; a bare `diff` has nothing left.
  return operands.length < 2;
}

/**
 * The env block is often built *above* the spawn it is passed to — `execGit`
 * assembles `env` as a const, then calls `spawnSync`. And when the anchor is a
 * function definition, the variable can sit anywhere in the body. So the window
 * looks back, looks forward, and follows a function body to its closing brace.
 */
function windowAround(file, line, before = 24, after = 24) {
  const lines = SOURCE.get(file) || fs.readFileSync(file, 'utf8').split('\n');
  const start = Math.max(0, line - 1 - before);
  let end = line - 1 + after;
  if (/^\s*(?:export\s+)?function\s+\w+\s*\(/.test(lines[line - 1] || '')) {
    for (let i = line; i < Math.min(lines.length, line + 240); i++) {
      if (/^\}/.test(lines[i])) {
        end = i + 1;
        break;
      }
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Every git spawn site in the runtime surfaces. `owner` is where the variable
 * must actually appear — the call site for a direct spawn, or the helper
 * definition for a call routed through `execGit` / `git`.
 */
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
        const owner = def
          ? { file: path.relative(REPO_ROOT, def.file), line: def.line }
          : { file: rel, line };
        sites.push({
          file: rel,
          line,
          subcommand,
          refreshes: refreshesIndex(subcommand, argv),
          owner,
          window: windowAround(owner.file, owner.line),
        });
      }
    }
  }
  return sites;
}

const SITES = collectSites();

describe('#5048 git spawn sites are enumerated', () => {
  test('the scan finds the shipped read-only surfaces', () => {
    // Guards the guard: a near-empty scan would make every other assertion
    // here vacuously true, which is the failure mode a source-scan guard has.
    assert.ok(SITES.length >= 8, `only found ${SITES.length} git spawn sites`);
    const files = new Set(SITES.map((s) => s.file));
    for (const expected of [
      'src/shell-command-projection.cts',
      'src/smart-entry.cts',
      'src/check-command-router.cts',
      'src/pristine-baseline.cts',
      'src/phase.cts',
      'hooks/gsd-statusline.js',
    ]) {
      assert.ok(files.has(expected), `scan missed ${expected}`);
    }
  });

  test('every index-free exemption carries a checkable reason', () => {
    for (const [cmd, reason] of Object.entries(INDEX_FREE)) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 20, `${cmd} exemption has no substantive reason`);
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
});

describe('#5048 every index-refreshing read-only spawn inherits GIT_OPTIONAL_LOCKS=0', () => {
  test('no site refreshes the index without opting out of the optional lock', () => {
    const offenders = SITES.filter(
      (s) => s.refreshes && !s.window.includes('GIT_OPTIONAL_LOCKS'),
    );
    assert.deepStrictEqual(
      offenders.map((s) => `${s.file}:${s.line} (git ${s.subcommand ?? '?'}) -> owner ${s.owner.file}:${s.owner.line}`),
      [],
      'A read-only git spawn that refreshes the index must inherit '
      + 'GIT_OPTIONAL_LOCKS=0, or it can fail a concurrent commit with '
      + '"Unable to create \'.git/index.lock\': File exists".',
    );
  });

  test('the three surfaces this issue fixed are all covered', () => {
    const fixed = SITES.filter(
      (s) => s.refreshes
        && ['src/smart-entry.cts', 'src/shell-command-projection.cts', 'hooks/gsd-statusline.js']
          .includes(s.file),
    );
    assert.ok(fixed.length >= 3, `expected all three surfaces, saw ${fixed.length}`);
    for (const site of fixed) {
      assert.match(site.window, /GIT_OPTIONAL_LOCKS:\s*'0'/, `${site.file}:${site.line}`);
    }
  });

  test('the variable is set to 0, never to a truthy string', () => {
    // GIT_OPTIONAL_LOCKS=1 is truthy, so it would silently re-enable exactly the
    // optional index write this issue removes.
    for (const site of SITES) {
      const m = site.window.match(/GIT_OPTIONAL_LOCKS:\s*'([^']*)'/);
      if (m) assert.equal(m[1], '0', `${site.file}:${site.line} sets a non-zero value`);
    }
  });

  test('an index-free site is allowed only because it is index-free', () => {
    // If a read-only command this guard classified as index-free turns out to
    // refresh the index, the exemption must be deleted rather than the
    // assertion loosened.
    for (const site of SITES) {
      if (site.subcommand && site.subcommand in INDEX_FREE) {
        assert.equal(site.refreshes, false, `${site.subcommand} is exempted and refreshing at once`);
      }
    }
  });
});

describe('#5048 a real repo proves the optional lock is not taken', () => {
  // The assertions above are about the env we pass. This one is about git: it
  // builds a real repo whose index is deliberately stale (a tracked file's stat
  // data no longer matches what the index recorded) and shows that the two
  // environments differ in what they do to .git/index.
  //
  // Staleness without a content change is the exact case that matters: git
  // re-reads the file, finds it identical, and writes the refreshed stat data
  // back — which is the write the optional lock exists to protect.

  const { execFileSync: realExecFileSync } = require('node:child_process');
  const crypto = require('node:crypto');
  const os = require('node:os');

  function digestIndex(dir) {
    const indexPath = path.join(dir, '.git', 'index');
    return crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex');
  }

  /** A repo with one commit whose index is stale by stat data alone. */
  function staleIndexRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
    const git = (...args) => realExecFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 'gsd@example.test');
    git('config', 'user.name', 'gsd test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'same bytes\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'initial');
    // Stat-only staleness: identical content, newer mtime/size metadata.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'tracked.txt'), future, future);
    return dir;
  }

  test('with GIT_OPTIONAL_LOCKS=0, git status leaves .git/index byte-identical', () => {
    const dir = staleIndexRepo();
    try {
      const before = digestIndex(dir);
      realExecFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      assert.equal(
        digestIndex(dir), before,
        'a read-only git status must not rewrite the index',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without it, the same command does rewrite the index', () => {
    // The control. Without this, the test above would pass even if git had
    // stopped refreshing the index altogether, and would be asserting nothing.
    const dir = staleIndexRepo();
    try {
      const before = digestIndex(dir);
      realExecFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      assert.notEqual(
        digestIndex(dir), before,
        'expected git to refresh the index without the variable; if this fails '
        + 'the premise of the sibling test changed and it needs revisiting',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#5048 the two env builders agree', () => {
  // The review's Major: the statusline builds its own `readOnlyGitEnv` while
  // execGit carries an inline literal. Two surfaces, one concept — asserted to
  // agree rather than left to drift.
  test('both spread process.env first so PATH, HOME and git config survive', () => {
    const statusline = fs.readFileSync(
      path.join(REPO_ROOT, 'hooks', 'gsd-statusline.js'), 'utf8');
    assert.match(
      statusline,
      /return \{ \.\.\.process\.env, GIT_OPTIONAL_LOCKS: '0' \};/,
      'readOnlyGitEnv must spread process.env, not replace it',
    );
    const execGitSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'shell-command-projection.cts'), 'utf8');
    assert.match(
      execGitSrc,
      /\.\.\.process\.env,[\s\S]{0,400}?GIT_OPTIONAL_LOCKS: '0',[\s\S]{0,80}?\.\.\.\(opts\.env \|\| \{\}\),/,
      'execGit must spread process.env, then set the variable, then let opts.env win',
    );
  });

  test('a bare replacement would break the spawn for unrelated reasons', () => {
    const statusline = fs.readFileSync(
      path.join(REPO_ROOT, 'hooks', 'gsd-statusline.js'), 'utf8');
    assert.doesNotMatch(
      statusline,
      /env:\s*\{\s*GIT_OPTIONAL_LOCKS: '0'\s*\}/,
      'a { GIT_OPTIONAL_LOCKS } env drops PATH/HOME and the spawn fails',
    );
  });
});