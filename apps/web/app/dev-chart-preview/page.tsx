import { BarChart } from '../analytics/analytics-view';

const rows = [
  ['2023-01', 1],
  ['2023-02', 1],
  ['2023-03', 16],
  ['2023-04', 12],
  ['2023-06', 2],
  ['2023-09', 1],
  ['2023-10', 9],
  ['2023-11', 1],
  ['2023-12', 1],
  ['2024-01', 14],
  ['2024-03', 2],
  ['2024-06', 5],
  ['2024-07', 2],
  ['2024-08', 1],
  ['2024-09', 1],
  ['2024-11', 1],
  ['2024-12', 1],
  ['2025-01', 4],
  ['2025-02', 1],
  ['2025-04', 1],
  ['2025-06', 1],
  ['2025-07', 1],
  ['2025-09', 7],
  ['2025-10', 19],
  ['2025-11', 5],
  ['2025-12', 1],
  ['2026-01', 4],
  ['2026-02', 10],
  ['2026-03', 5],
  ['2026-04', 4],
  ['2026-05', 4],
  ['2026-06', 6],
  ['2026-07', 13],
  ['2026-08', 14],
].map(([label, value]) => ({ label: String(label), value: Number(value), secondary: 0 }));

export default function DevChartPreviewPage() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <BarChart
        title="Открыто и закрыто"
        compact
        valueLabel="Открыто"
        secondaryLabel="Закрыто"
        valueColor="var(--error-foreground)"
        secondaryColor="var(--success-foreground)"
        rows={rows}
      />
    </main>
  );
}
