---
status: planned
created: 2026-01-28
priority: high
tags:
- web-ui
- nextjs
- shadcn
- tailwind
- frontend
depends_on:
- 004-migrate-to-monorepo
created_at: 2026-01-28T15:16:36.955914Z
updated_at: 2026-02-23T02:17:27.631382Z
dependencies:
- 001-bootstrap-telegramable
---

# UI Framework Setup

> **Status**: planned · **Priority**: high · **Created**: 2026-01-28  
> **North Star**: Establish a modern, professional UI foundation for telegramable admin interfaces using Next.js + shadcn/ui + Tailwind CSS

## Overview

Before building specific admin features like runtime configuration, we need a solid UI foundation that provides:
- Modern, professional aesthetics (Vercel, Supabase caliber)
- Type-safe component library with accessibility
- Consistent design system and theming
- Production-ready build pipeline
- Developer experience with hot reload

This spec establishes the frontend architecture as a separate Next.js application within the telegramable monorepo, properly integrated with the existing backend API.

**Design References:**
- Vercel Dashboard (clean, minimal, excellent spacing)
- Supabase Studio (sidebar nav, card layouts, data tables)
- Linear (smooth interactions, keyboard shortcuts)

## Design

### Architecture

```
telegramable/
├── apps/
│   └── web/                    # Next.js 15 App Router
│       ├── app/                # Routes & layouts
│       ├── components/         # App-specific components
│       ├── lib/                # Utils, API clients
│       └── styles/             # Global styles, Tailwind
├── packages/
│   └── ui/                     # Shared shadcn components
│       ├── components/         # Reusable UI components
│       └── styles/             # Design tokens, globals
├── src/                        # Existing backend (Fastify)
│   └── api/                    # REST API routes
└── turbo.json                  # Turborepo config
```

### Technology Stack

| Layer      | Technology                   | Purpose                      |
| ---------- | ---------------------------- | ---------------------------- |
| Framework  | Next.js 16 (App Router)      | React framework with SSR/SSG |
| Language   | TypeScript                   | Type safety                  |
| Styling    | Tailwind CSS 4               | Utility-first CSS            |
| Components | shadcn/ui                    | Accessible, customizable UI  |
| State      | React Query (TanStack)       | Server state management      |
| Forms      | React Hook Form + Zod        | Form handling & validation   |
| Icons      | Lucide React                 | Consistent iconography       |
| Fonts      | Inter (Sans), JetBrains Mono | Typography                   |
| Build      | Turborepo                    | Monorepo task orchestration  |

### Design System

**Color Palette (Dark-first, like Vercel/Supabase):**
```css
--background: 0 0% 3.9%;        /* #0a0a0a */
--foreground: 0 0% 98%;         /* #fafafa */
--card: 0 0% 5%;                /* #0d0d0d */
--card-foreground: 0 0% 98%;
--popover: 0 0% 5%;
--popover-foreground: 0 0% 98%;
--primary: 0 0% 98%;            /* White for primary actions */
--primary-foreground: 0 0% 9%;
--secondary: 0 0% 14.9%;        /* #262626 */
--secondary-foreground: 0 0% 98%;
--muted: 0 0% 14.9%;
--muted-foreground: 0 0% 63.9%; /* #a3a3a3 */
--accent: 0 0% 14.9%;
--accent-foreground: 0 0% 98%;
--destructive: 0 62.8% 30.6%;
--destructive-foreground: 0 0% 98%;
--border: 0 0% 14.9%;          /* #262626 */
--input: 0 0% 14.9%;
--ring: 0 0% 83.1%;
--radius: 0.5rem;
```

**Layout Principles:**
- Max content width: 1280px (centered)
- Sidebar width: 280px (collapsible to 64px)
- Card padding: 24px
- Section spacing: 32px
- Border radius: 8px (cards), 6px (buttons/inputs)

**Typography:**
- Headings: Inter, font-weight 600
- Body: Inter, font-weight 400
- Mono: JetBrains Mono (for code/commands)
- Scale: 48px (h1), 32px (h2), 24px (h3), 18px (body), 14px (small)

### Component Standards

**shadcn/ui Base Components to Install:**
- Layout: Card, Sheet, Sidebar, Tabs, Accordion
- Forms: Input, Textarea, Select, Switch, Checkbox, Label
- Feedback: Button, Badge, Alert, Toast, Skeleton
- Data: Table, Dialog, Dropdown Menu, Tooltip
- Navigation: Breadcrumb, Command (cmd+k), Separator

**Custom Components (to build):**
- `PageHeader`: Title + description + actions
- `DataTable`: Sortable, filterable table with pagination
- `EmptyState`: Illustration + text for empty lists
- `StatusBadge`: Colored status indicators (active, error, etc.)
- `CodeBlock`: Syntax-highlighted code display
- `Terminal`: Monospace output viewer
- `ConfirmDialog`: Destructive action confirmation
- `FormField`: Label + input + error message wrapper

## Plan

### Phase 1: Monorepo Setup
- [ ] Initialize Turborepo at repo root
- [ ] Create `apps/web/` with Next.js 16 (App Router)
- [ ] Create `packages/ui/` for shared components
- [ ] Configure TypeScript project references
- [ ] Set up path aliases (`@/web/*`, `@/ui/*`)

### Phase 2: Design System Foundation
- [ ] Initialize Tailwind CSS v4 with CSS-first config
- [ ] Configure dark mode (class-based, default dark)
- [ ] Set up CSS custom properties (design tokens)
- [ ] Add Inter and JetBrains Mono fonts
- [ ] Create base layout components (RootLayout with providers)

### Phase 3: shadcn/ui Integration
- [ ] Initialize shadcn/ui in `packages/ui/`
- [ ] Configure component aliases and base color (neutral)
- [ ] Install core components: button, card, input, label, select, switch, badge, dialog, toast, skeleton, table, tabs, separator, tooltip, dropdown-menu, command, sheet
- [ ] Customize component styles to match design system
- [ ] Export components from `packages/ui/index.ts`

### Phase 4: App Shell & Navigation
- [ ] Create sidebar navigation component (collapsible)
- [ ] Build main layout with sidebar + content area
- [ ] Implement navigation items with active states
- [ ] Add breadcrumb component for page hierarchy
- [ ] Create mobile-responsive navigation (sheet/drawer)

### Phase 5: API Integration Layer
- [ ] Set up React Query provider
- [ ] Create API client with fetch wrapper
- [ ] Add error handling and toast notifications
- [ ] Implement loading states with skeletons
- [ ] Add request/response types from backend

### Phase 6: Shared Utilities & Types
- [ ] Create `lib/utils.ts` with cn() helper
- [ ] Add date formatting utilities
- [ ] Create validation schemas (Zod)
- [ ] Set up environment variable types

### Phase 7: Development Experience
- [ ] Configure ESLint + Prettier
- [ ] Add Tailwind CSS IntelliSense
- [ ] Set up VS Code workspace settings
- [ ] Configure hot reload for monorepo
- [ ] Add development scripts to root package.json

### Phase 8: Build & Deployment
- [ ] Configure static export for Next.js
- [ ] Update Dockerfile for multi-stage build (frontend + backend)
- [ ] Set up Nginx or serve static via Fastify
- [ ] Add health check endpoint
- [ ] Configure production environment variables

## Test

- [ ] `pnpm dev` starts both frontend and backend concurrently
- [ ] Hot reload works for both frontend and shared packages
- [ ] Dark mode persists across page reloads
- [ ] All shadcn components render correctly with custom theme
- [ ] TypeScript compilation passes without errors
- [ ] Build succeeds: `pnpm build` generates static files
- [ ] Docker image builds and serves the application
- [ ] Responsive design works on mobile, tablet, desktop
- [ ] Accessibility: keyboard navigation, focus states, aria labels
- [ ] Performance: Lighthouse score >90 on all metrics

## Notes

**Why Next.js + shadcn/ui?**
- Next.js: Industry standard, excellent DX, static export option
- shadcn/ui: Not a component library dependency, but copy-paste components we own
- Tailwind v4: CSS-first configuration, better performance
- This stack matches the professional quality of Vercel, Linear, etc.

**Monorepo Benefits:**
- Shared types between frontend and backend
- UI components can be used by multiple apps
- Single command to run everything
- Consistent tooling and linting

**Alternative Considerations:**
- **Vite + React Router**: Lighter, but Next.js has better ecosystem
- **Chakra UI**: Good DX, but Tailwind + shadcn is more flexible
- **Radix UI directly**: shadcn is built on Radix, saves time

**Future Enhancements:**
- Storybook for component documentation
- Playwright for E2E testing
- Feature flags system
- Real-time updates via WebSocket
- Theme customization (user preferences)
