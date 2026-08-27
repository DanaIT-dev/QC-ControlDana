# UI design system

Визуальный слой «Реестра дефектных актов СГР» построен на [shadcn/ui](https://ui.shadcn.com/docs) (Radix, стиль `radix-nova`), Tailwind CSS v4, Lucide Icons, существующем TanStack Query и TanStack Table.

Исходники компонентов хранятся в `apps/web/components/ui`. Продуктовые обёртки — в `apps/web/components`.

## Components

Используемые официальные компоненты shadcn/ui:

Button, Input, Label, Textarea, Card, Badge, Checkbox, Select, Command, Popover, DropdownMenu, Sheet, Dialog, AlertDialog, Table, Tabs, Tooltip, Skeleton, Separator, ScrollArea, Breadcrumb, Pagination, Avatar, Collapsible, Field, Alert, Sonner.

Продуктовые:

- `MultiSelect` — Popover + Command, закрыт по умолчанию, поиск, check 16–18 px слева, label слева.
- `PageHeader`, `FilterChips`, `StatusBadge`, `DeadlineBadge`, `EmptyState`, `ErrorState`, `ConflictDialog`, `UserAvatar`, `UserMenu`, `AppShell`, `AttachmentsPanel`.

Новый UI-компонент добавляется через `pnpm dlx shadcn@latest add <name>` из `apps/web`, затем при необходимости кастомизируется высота контролов до 44 px и токены. Community registries и коммерческие UI kits не используются.

## Semantic tokens

Задаются CSS-переменными в `apps/web/app/globals.css` и дублируются для тестов в `apps/web/lib/design-tokens.ts`. Hex не разбрасываются по React-компонентам.

| Token                  | HEX                   |
| ---------------------- | --------------------- |
| background             | `#F8FAFC`             |
| foreground             | `#1E293B`             |
| card / popover         | `#FFFFFF`             |
| muted-foreground       | `#64748B`             |
| primary (solid button) | `#0070AD`             |
| primary-hover          | `#005A8C`             |
| brand / ring / links   | `#0087CD`             |
| accent / selected nav  | `#E0F2FE`             |
| border / input         | `#E2E8F0`             |
| success                | `#DCFCE7` / `#15803D` |
| warning                | `#FEF9C3` / `#A16207` |
| error                  | `#FEE2E2` / `#B91C1C` |

Фиолетовый акцент shadcn по умолчанию не используется. Dark theme на этом этапе не реализуется.

## Typography

Шрифт Inter через `next/font/google` (latin + cyrillic), self-hosted на сборке.

Fallback: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

- Page title: 24–26 px, semibold
- Section title: 18–20 px, semibold
- Card metric: 22 px, semibold
- UI text: 14 px
- Secondary / labels: 13 px, medium
- Table header: 12 px, medium

## Spacing, radii, shadows

- Отступы кратны 4 px
- Content gutters: 24–32 px desktop, 16 px mobile
- Max content width: 1600 px
- Radius: 8–10 px (dialogs/cards до 12 px)
- Тени очень умеренные (`shadow-sm` / кольцо границы)
- Без glassmorphism и градиентных блоков

## Breakpoints

- Mobile cards: `max-width: 767 px`
- Tablet secondary columns hidden: `768–1279 px`
- Desktop table: `≥ 768 px`, полные столбцы с `1280 px`
- Touch targets на mobile: минимум 44×44

## Registry filter pattern

Toolbar: поиск 320–420 px, кнопка «Фильтры» с badge, компактные Status / Object / Deadline, «Сбросить» только при активных фильтрах.

Остальные группы открываются в правом Sheet ~480 px: Основное, Участники, Сроки. Списки закрыты по умолчанию. Active chips под toolbar, удаляются крестиком, URL state сохраняется.

Запрещены глобальные правила вида `input { width: 100% }` для checkbox.

## Table and mobile cards

TanStack Table, manual server pagination/sorting. Белая поверхность, sticky header `#F8FAFC`, compact rows ~56 px, без тяжёлого zebra. Статусы — Badge + иконка. Deadline — текстовая метка и тонкий индикатор, цвет не единственный признак. B/C сворачиваются; RESPONSIBLE не видит B/C controls.

На 360–767 px таблица скрыта, показываются карточки DefectItem. Панель вложений на карточке акта не даёт горизонтальный overflow: имя файла `break-all`, кнопки 44 px.

## Status colors

IN_PROGRESS — info/blue; COMPLETED — success; WARNING — warning; OVERDUE — error; NO_DEADLINE — neutral outline.

## Accessibility

Semantic HTML, Radix focus management, видимый `:focus-visible` (синий ring `#0087CD`), keyboard / Escape / Enter, sr-only для icon-only, WCAG AA для текста, dialogs возвращают focus, Sheet блокирует фон.

## Adding components

1. `pnpm dlx shadcn@latest add <component>` в `apps/web`.
2. Не менять Radix a11y без необходимости.
3. Использовать semantic tokens, не hex.
4. Высота Input / Select / Button — 44 px (`h-11`).
5. Покрыть новым control unit/component тестом, если это фильтр, статус или дата.
