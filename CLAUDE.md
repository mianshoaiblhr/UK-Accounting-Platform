# 🎨 My Design & Frontend Stack — Single Source of Truth

> **How to use this file**
> - **Option A (recommended):** Save this file as `CLAUDE.md` in a new project's root. Claude Code reads it automatically on startup.
> - **Option B:** Paste the whole file into a Claude Code chat and say *"set up my design stack from this file."*
>
> When Claude sees this file, it should: verify prerequisites, install every skill listed under **§3**, install the base libraries under **§4** (only if the project uses them), and confirm the MCP servers under **§5** are connected. Skills are **project-scoped** — they must be re-installed per project. Skills only activate after Claude Code is **restarted** in the project directory.

---

## 1. What this stack is for
A curated set of **17 design/frontend "skills"** + supporting libraries and MCP servers that make Claude build **high-quality, non-generic UI** (strong layout, typography, motion, spacing) instead of boilerplate. Use it on every website / landing page / dashboard / app project.

## 2. Prerequisites (install once per machine)
```bash
# Node.js + npm (via Homebrew on macOS)
brew install node

# GitHub CLI (for repo work) — optional
brew install gh

# Python 3 (required by some skills' helper scripts)
python3 --version   # macOS ships it; else: brew install python3
```

## 3. The 17 Skills (install into EVERY project)

Run all commands from the **project root**. This installs everything in one pass:

```bash
# --- Taste Skill: 13 anti-slop design skills (Vercel skills CLI) ---
npx --yes skills add https://github.com/Leonxlnx/taste-skill --skill '*' --agent claude-code --copy -y

# --- claude-code-templates: 3 skills ---
npx --yes claude-code-templates@latest --skill creative-design/frontend-design   -d . -y
npx --yes claude-code-templates@latest --skill development/senior-frontend       -d . -y
npx --yes claude-code-templates@latest --skill creative-design/ui-design-system  -d . -y

# --- UI/UX Pro Max: 1 skill (uipro CLI) ---
npm install -g uipro-cli   # once per machine
uipro init --ai claude     # per project
```

### Skill reference

| Skill | Source | What it does |
|---|---|---|
| **ui-ux-pro-max** | uipro-cli | Design intelligence: 67 styles, 96 palettes, 57 font pairings, UX guidelines across many stacks |
| **frontend-design** | claude-code-templates | Distinctive, production-grade UI; avoids generic AI aesthetics |
| **senior-frontend** | claude-code-templates | React/Next/TS engineering, perf optimization, bundle analysis |
| **ui-design-system** | claude-code-templates | Design tokens, component docs, dev handoff |
| **design-taste-frontend** | Taste Skill | Flagship v2 anti-slop frontend framework |
| **design-taste-frontend-v1** | Taste Skill | Previous (v1) version |
| **gpt-taste** | Taste Skill | Elite UX/UI + advanced GSAP motion, editorial typography, bento grids |
| **high-end-visual-design** | Taste Skill | Premium high-end visual direction |
| **redesign-existing-projects** | Taste Skill | Redesign / uplift existing UIs |
| **full-output-enforcement** | Taste Skill | Enforces complete, non-lazy output |
| **stitch-design-taste** | Taste Skill | Design-taste variant |
| **minimalist-ui** | Taste Skill | Clean editorial style — warm monochrome, typographic contrast, flat bento |
| **industrial-brutalist-ui** | Taste Skill | Raw mechanical/brutalist — Swiss print × terminal aesthetics |
| **image-to-code** | Taste Skill | Generate design images, analyze them, then build matching UI |
| **brandkit** | Taste Skill | Premium brand-kit / identity image generation |
| **imagegen-frontend-web** | Taste Skill | Web design reference images (one per section) |
| **imagegen-frontend-mobile** | Taste Skill | Mobile app screen concept images |

## 4. Base libraries (install per project, only if used)
```bash
npm install framer-motion   # React animation
npm install gsap            # GSAP animation + ScrollTrigger etc.
```

| Library | Purpose |
|---|---|
| **framer-motion** | Declarative React animations |
| **gsap** | Timeline / scroll-driven animation (ScrollTrigger, etc.) |

## 5. MCP servers (user-scoped — global, install once per machine)
```bash
# 21st.dev Magic — generate UI components from prompts
claude mcp add magic -s user -- npx -y @21st-dev/magic@latest API_KEY=<YOUR_21ST_KEY>

# Higgsfield — custom HTTP connector (needs interactive auth via /mcp)
claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp -s user
```

| Server | Type | Notes |
|---|---|---|
| **magic** (21st.dev) | stdio | UI component generation. Needs 21st.dev API key. |
| **higgsfield** | HTTP | Authorize in an interactive terminal: run `claude`, then `/mcp` → higgsfield → Authenticate. |

> ⚠️ Never commit real API keys. Keep `<YOUR_21ST_KEY>` out of git; MCP config lives in `~/.claude.json`.

## 6. Instructions to Claude (standing preferences)
- Treat this file as the **single source of truth** for my design environment.
- For any UI/UX or frontend work, **use these skills** (design taste, layout, typography, motion) — aim for polished, distinctive results, not generic templates.
- When starting a **new project**, offer to install the full skill set from §3.
- Prefer **framer-motion** / **gsap** for animation.
- Remind me that skills require a **Claude Code restart** to activate.

---
_Last updated: 2026-07-16 · Reference project: `~/Desktop/framer-motion-app` → https://github.com/wakas-stack/framer-motion-app_

---

## 7. Installed in this repository (UK Accounting Platform, 2026-10-25; DEC-075)
Installed from this file's §3 commands into `.claude/skills/` and committed, so every session on this repository has them:

| Skill | Source | How it was installed |
|---|---|---|
| **design-taste-frontend** (v2) | Leonxlnx/taste-skill | `npx skills add … --skill '*'`. The repository now ships this one consolidated skill; the 13 separate Taste skills listed in §3 no longer exist there |
| **frontend-design** | claude-code-templates | Copied from the repository (its installer's GitHub API calls are blocked from the build environment); identical to the copy the product owner uploaded |
| **senior-frontend** | claude-code-templates | Copied from the repository, as above |
| **ui-design-system** | claude-code-templates | Copied from the repository, as above |
| **ui-ux-pro-max** | uipro-cli | `uipro init --ai claude` |

* **Not installed:**
  * **framer-motion and gsap:** §4 says to install them only if used. The platform's screens use motion only where a person's action needs it (DEC-075), so the libraries are added only if a screen needs them.
  * **The MCP servers (§5):** they are set up per machine, outside the repository. 21st.dev needs the owner's API key, and Higgsfield needs an interactive sign-in.
* **Restart:** skills load when a session starts, so they are active from the next session on this repository.
* **Lint and CodeQL:** the vendored skill code under `.claude/` is excluded from both (`eslint.config.mjs`, `.github/codeql/codeql-config.yml`); it is tooling for the assistant and never ships in the app.
* **This project's own rules still apply to screen work:** screens show what the API returns and compute nothing (DEC-048, DEC-071); every action needs the route's permission; decisions are recorded before code; the real-browser tests (DEC-050) must pass.
