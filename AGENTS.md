# telegramable

## Skills

This project uses the Agent Skills framework for domain-specific guidance.

### leanspec-sdd - Spec-Driven Development

- **Location**: `.github/skills/leanspec-sdd/SKILL.md`
- **Use when**: Working with specs, planning features, multi-step changes
- **Key principle**: Run `board` or `search` before creating specs

### development - Monorepo Conventions

- **Location**: `.github/skills/development/SKILL.md`
- **Use when**: Installing dependencies, running builds, creating packages
- **Key principles**:
  - Use pnpm (never npm/yarn)
  - Node.js >=22 required
  - Packages use `@telegramable/` scope

## Project-Specific Rules

- **Package manager**: pnpm only, no package-lock.json
- **Monorepo**: apps/ for deployables, packages/ for shared libs
- **Naming**: All packages use `@telegramable/` scope
