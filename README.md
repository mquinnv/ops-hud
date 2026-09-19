# ops-hud

A terminal-based CI dashboard that shows GitHub Actions runs and Buildkite
builds side by side, across multiple repositories, in a single grid. Similar
to `gh run watch`, but for more than one workflow and more than one provider
at once.

![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🎯 **Auto-Detection**: Automatically monitors the current directory's GitHub repository when run without arguments
- 🔀 **Two Providers, One Grid**: GitHub Actions runs and Buildkite builds render as the same kind of card, side by side
- 📊 **Multi-Repository Monitoring**: Watch runs from multiple repositories and organizations simultaneously
- 🔄 **Auto-Refresh**: Configurable refresh interval with smooth animated spinner
- 🎨 **Color-Coded Status**: Visual indicators for run status (running, success, failure, queued)
- ⌨️ **Keyboard Navigation**: Navigate between runs using arrow keys or vim-style keys
- 📐 **Dynamic Layout**: Automatically adjusts grid layout based on terminal size and number of runs
- 🔧 **Configurable**: Support for configuration files and command-line arguments
- 📦 **Job Details**: View individual job status and current running steps
- 📝 **Event Log**: Built-in event log with configurable log levels (INFO/DEBUG/TRACE)
- 💾 **Persistent Settings**: Remembers your preferences between sessions
- 📊 **Enhanced Status Bar**: Two-line status display with keyboard shortcuts reference, plus a visible warning when a provider is failing
- 🔔 **Pull Request Monitoring**: Optional display of open pull requests (`--show-prs`)
- 🐳 **Docker Compose Monitoring**: Optional display of Docker service status (`--show-docker`)

## Prerequisites

- Node.js 18+
- `gh` CLI tool installed and authenticated, for GitHub Actions monitoring
- A Buildkite API access token, for Buildkite monitoring (see below)
- Docker (optional, required only for Docker service monitoring)

Both providers are optional and independent: run with just `gh` authenticated,
just a Buildkite token set, or both.

## Installation

### From npm (recommended)

```bash
npm install -g ops-hud
```

### From source

```bash
# Clone the repository
git clone https://github.com/mquinnv/ops-hud.git
cd ops-hud

# Install dependencies
bun install

# Build the project
bun run build

# Link globally (optional)
bun link
```

## Usage

### Basic Usage

When in a GitHub repository directory, monitor that repository:

```bash
ops-hud
```

Monitor specific repositories:

```bash
ops-hud --repo owner/repo1 owner/repo2
```

Or using the shorthand:

```bash
ops-hud -r owner/repo1 owner/repo2
```

Monitor whichever repository owns a given checkout, by path:

```bash
ops-hud .
ops-hud ~/Projects/remix
```

A path (like `--repo`) is a *hard* scope: organizations listed in your config
file are ignored for that run, so the dashboard shows exactly one repository.
This is what makes ops-hud useful as a per-project pane in a tmux split. If the
path isn't a directory, or has no `github.com` remote, ops-hud exits with an
error rather than starting an empty dashboard.

Buildkite pipelines for the scoped checkout are derived from its repository —
unless a `buildkite.pipelines` list is set. A non-empty list in a *global*
`~/.ops-hud.json` overrides that derivation for **every** checkout, so each
per-project pane would show the same listed pipelines. Put such a list in a
project's own `.ops-hud.json`, or pass `--pipeline` for that one run, instead.

### Monitor Organization Repositories

```bash
ops-hud --org mquinnv --org phenixcrm
```

### Custom Refresh Interval

```bash
ops-hud --interval 10  # Refresh every 10 seconds
```

### Using Configuration File

```bash
ops-hud --config ~/.ops-hud.json
```

### Show Pull Requests

```bash
ops-hud --show-prs  # Display open PRs in header
```

### Show Docker Services

```bash
ops-hud --show-docker  # Display Docker Compose service status
ops-hud -d             # Short form
```

### Combined Features

```bash
ops-hud --show-prs --show-docker  # Show both PRs and Docker services
ops-hud -p -d                     # Short form
```

### Choosing providers

```bash
ops-hud --no-buildkite   # GitHub Actions only
ops-hud --no-github      # Buildkite only
```

`--no-github` disables GitHub Actions *runs* only. Pull requests are governed
separately by `--show-prs`, so `ops-hud --no-github --show-prs` still shows
PRs — GitHub is still used to resolve the current checkout's repository and
to fetch PRs, just not to list workflow runs.

### Buildkite options

```bash
ops-hud --bk-org my-buildkite-org        # Skip org auto-detection
ops-hud --pipeline backend frontend      # Watch specific pipeline slugs
```

## Buildkite setup

Buildkite support needs an API access token with, at minimum, the
`read_builds` and `read_pipelines` scopes, plus `read_organizations` unless
you name your organization (see below — auto-detecting it lists your
organizations). Add `write_builds` if you want to cancel or rebuild from the
dashboard, and `read_build_logs` if you want to view logs. (The cancel/rebuild requests are implemented against Buildkite's
documented REST reference, but have not yet been exercised against a live
token — if one 405s, that's a code bug, not a config problem.)

Provide the token as an environment variable:

```bash
export BUILDKITE_API_TOKEN=bkua_xxxxxxxx
```

`$BUILDKITE_API_TOKEN` always takes precedence over a `buildkite.token` set in
the config file. Prefer the environment variable — a token committed to a
config file on disk is a plaintext credential, so only use `buildkite.token`
for a value you're comfortable having sit unencrypted in `~/.ops-hud.json`.

### Organization

If your token reaches exactly one Buildkite organization, ops-hud detects it
automatically — this needs the `read_organizations` scope. If the token lacks
that scope, or reaches more than one organization, name it explicitly:

```json
{
  "buildkite": {
    "org": "my-buildkite-org"
  }
}
```

or pass `--bk-org my-buildkite-org` on the command line (the flag wins over
the config file).

### Mapping a checkout to its pipeline(s)

By default, ops-hud finds the Buildkite pipeline(s) for a repository by
matching the pipeline's configured repository URL (a git remote) against the
GitHub repositories you're already watching. A pipeline whose "Repository"
setting points at `git@github.com:owner/repo.git` is matched to `owner/repo`
automatically — no extra configuration needed if your pipelines already point
at the right remotes.

If that derivation doesn't find the right pipeline (or you want to watch a
pipeline whose GitHub checkout isn't otherwise in scope), list pipeline slugs
explicitly — this always wins over derivation from repositories:

```json
{
  "buildkite": {
    "pipelines": ["my-pipeline", "my-other-pipeline"]
  }
}
```

or with `--pipeline my-pipeline my-other-pipeline`. With no repositories
scoped and no explicit pipeline list, ops-hud watches builds across the whole
organization.

## What shows on the grid

- **Runs in flight**: queued, running or blocked.
- **Runs that finish while ops-hud is open**, including fast ones that start
  and finish between two refreshes. (Buildkite is fetched at most every 15s to
  stay inside its API rate limit, so a quick build may appear after it has
  already finished.)
- **Recent history**: runs that finished in the `showCompletedFor` minutes
  before you launched ops-hud (default 60; set it to `0` for an empty grid on
  launch).

Finished runs stay until you dismiss them (`d`, or `D` for all). Anything
older can be brought back with `U`.

## Configuration

Create a `.ops-hud.json` file in your home directory or project root (see
`example.ops-hud.json`):

```json
{
  "repositories": [
    "owner/repo1",
    "owner/repo2"
  ],
  "organizations": [
    "mquinnv",
    "phenixcrm"
  ],
  "refreshInterval": 5000,
  "maxWorkflows": 20,
  "showCompletedFor": 60,
  "buildkite": {
    "org": "my-buildkite-org",
    "pipelines": []
  }
}
```

`buildkite.pipelines` is left empty on purpose: an empty list means "derive
the pipelines from the repositories in scope". A non-empty list *replaces*
that derivation everywhere, so a copied example slug would be watched instead
of your real pipelines (and 404). Only fill it in with slugs you actually
want. Older config files that still contain `filterStatus` keep loading; that
key was never used and is now ignored.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositories` | string[] | [] | Specific repositories to monitor |
| `organizations` | string[] | [] | Organizations to monitor |
| `refreshInterval` | number | 5000 | Refresh interval in milliseconds |
| `maxWorkflows` | number | 20 | Maximum number of runs to display |
| `showCompletedFor` | number | 60 | Minutes of recent history shown on launch; `0` for none |
| `buildkite.token` | string | — | Buildkite API token; `$BUILDKITE_API_TOKEN` takes precedence |
| `buildkite.org` | string | auto-detected | Buildkite organization slug |
| `buildkite.pipelines` | string[] | derived from `repositories` | Explicit Buildkite pipeline slugs to watch |

## Command-line flags

| Flag | Description |
|------|-------------|
| `-r, --repo <repositories...>` | Specific repositories to watch (`owner/repo`) |
| `-c, --config <path>` | Path to configuration file |
| `-o, --org <organizations...>` | Organizations to monitor |
| `-i, --interval <seconds>` | Refresh interval in seconds (default: 5) |
| `-p, --show-prs` | Show open pull requests in header |
| `-d, --show-docker` | Show Docker Compose service status in header |
| `--bk-org <org>` | Buildkite organization slug |
| `--pipeline <slugs...>` | Buildkite pipeline slugs to watch |
| `--no-buildkite` | Disable the Buildkite provider |
| `--no-github` | Disable GitHub Actions runs (PRs are governed by `--show-prs`) |

## Keyboard Shortcuts

### Navigation
| Key | Action |
|-----|--------|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `←` / `h` | Move selection left |
| `→` / `l` | Move selection right |
| `Enter` | Open selected run in browser |
| `?` | Show help |
| `q` / `Ctrl+C` | Quit |

### Run Management
| Key | Action |
|-----|--------|
| `d` | Dismiss a finished run, or hide a blocked one until its status changes |
| `D` | Dismiss ALL completed runs |
| `k` | Kill/cancel running run |
| `U` | Resurrect older run (undo dismiss) |
| `r` | Force refresh |

### Event Log
| Key | Action |
|-----|--------|
| `F9` | Toggle event log visibility |
| `F10` | Cycle log level (INFO → DEBUG → TRACE) |
| `a` | Toggle auto-show on startup |
| `Ctrl+k` | Increase event log height |
| `Ctrl+d` | Decrease event log height |

## Status Indicators

### Run Status
- 🟡 **Yellow (●)**: Run is running
- 🟢 **Green (✓)**: Run completed successfully
- 🔴 **Red (✗)**: Run failed
- ⚪ **Gray (○)**: Run is queued
- ⚪ **Gray (⊘)**: Run was cancelled
- ⚪ **Gray (⊜)**: Run was skipped

### Docker Service Status
- 🟢 **Green (✓)**: Service is running and healthy
- 🟢 **Green (●)**: Service is running (no health check)
- 🟡 **Yellow (●)**: Service health is starting
- 🔴 **Red (✗)**: Service is unhealthy
- 🟡 **Yellow (↻)**: Service is restarting
- 🟡 **Yellow (⏸)**: Service is paused
- ⚪ **Gray (○)**: Service is stopped/exited

## Event Log

The built-in event log helps you track what's happening in your repositories:

- **INFO Level**: Shows important events like run status changes
- **DEBUG Level**: Includes refresh notifications and system messages
- **TRACE Level**: Shows all messages including detailed state updates

Press `F9` to toggle the event log, and `F10` to cycle through log levels. The log automatically filters messages based on your selected level. Your preferences (height, auto-show, log level) are saved between sessions.

## Diagnostics: when the dashboard looks empty or wrong

An empty grid isn't silent: it shows a diagnostic for each configured
provider that contributed nothing, right in the empty-state panel — for
example, a Buildkite token that doesn't reach any organization, or a
repository that has no matching Buildkite pipeline. Error-level diagnostics
are shown in red; informational ones (like "no Buildkite token configured")
in white.

If one provider is failing while the other still has runs on screen — say
Buildkite's token was just revoked while GitHub Actions runs keep rendering
fine — the failure doesn't just scroll away into the event log. The status
bar holds a red `⚠` warning summarizing the most recent error-level
diagnostic until a refresh resolves it.

## Docker Monitoring

The Docker monitoring feature shows the status of services defined in `docker-compose.yml` files in your monitored repositories. It automatically:

- Detects docker-compose files in repository roots
- Shows service health status if health checks are configured
- Displays exposed ports for each service
- Groups services by repository
- Updates status in real-time with the same refresh interval as workflows

**Note**: Docker must be installed and running on your system for this feature to work. The tool will gracefully handle cases where Docker is not available.

## Development

```bash
# Run in development mode
bun dev

# Build the project
bun run build

# Run linting
bun run lint

# Format code
bun run format
```

## Project Structure

```
ops-hud/
├── src/
│   ├── index.ts       # CLI entry point
│   ├── cli.ts          # Commander program and flag definitions
│   ├── app.ts          # Main application logic
│   ├── dashboard.ts    # Terminal UI components
│   ├── config.ts       # Configuration management
│   ├── providers/       # GitHub Actions and Buildkite providers
│   └── types.ts         # TypeScript type definitions
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

## Troubleshooting

### No runs appearing

1. Ensure `gh` is authenticated: `gh auth status`
2. Check repository access: `gh repo list`
3. Verify workflows exist: `gh run list --repo owner/repo`
4. For Buildkite, check the empty-state panel and the status bar for a
   diagnostic explaining why — a missing/rejected token or an unmatched
   pipeline both show up there.

### Performance issues

- Reduce the number of monitored repositories
- Increase the refresh interval

## Upgrading from gh-hud

ops-hud is the renamed, Buildkite-aware successor to gh-hud (2.0.0). If
you're upgrading:

- The binary is now `ops-hud`, not `gh-hud`. Reinstall with
  `npm install -g ops-hud` (and `npm uninstall -g gh-hud` when you're done
  with the old one).
- Config files: `.ops-hud.json` (project directory, home directory, or
  `~/.config/ops-hud/config.json`) are checked first; if none of those exist,
  ops-hud still reads a pre-existing `.gh-hud.json` in the same three
  locations. Nothing is deleted or migrated automatically — copy your old
  config to the new filename whenever it's convenient.
- Saved preferences (event log height, auto-show, log level) are read from
  `~/.gh-hud-prefs.json` if `~/.ops-hud-prefs.json` doesn't exist yet. The
  first time ops-hud saves preferences, it writes the new file; the old one
  is left alone.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Author

Michael Quinn

## Acknowledgments

- Built with [blessed](https://github.com/chjj/blessed) for terminal UI
- Uses GitHub CLI (`gh`) and the Buildkite REST API for CI data
- Inspired by `gh run watch`
