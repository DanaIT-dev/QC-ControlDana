'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createFinancialImpact, fetchFinancialImpacts } from '@/lib/analytics-api';
import { commandFetch } from '@/lib/command-api';
import { queryKeys } from '@/lib/query-keys';

export function FinancialImpactPanel({
  defectItemId,
  csrfToken,
}: {
  defectItemId: string;
  csrfToken: string;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.analytics.financials(defectItemId),
    queryFn: () => fetchFinancialImpacts(defectItemId),
  });
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await client.invalidateQueries({ queryKey: queryKeys.analytics.financials(defectItemId) });
  }

  async function save() {
    setError(null);
    try {
      await createFinancialImpact(defectItemId, csrfToken, {
        amountType: 'ACTUAL_COST',
        payerType: 'COMPANY',
        amountOriginal: amount,
        currency: 'BYN',
        occurredAt: new Date().toISOString().slice(0, 10),
        comment,
      });
      setAmount('');
      await refresh();
    } catch {
      setError('Не удалось сохранить черновик.');
    }
  }

  async function confirm(id: string) {
    await commandFetch(`/api/defects/${defectItemId}/financials/${id}/confirm`, {
      method: 'POST',
      csrfToken,
      body: {},
    });
    await refresh();
  }

  if (query.isLoading)
    return <p className="text-sm text-muted-foreground">Финансовое влияние загружается.</p>;
  if (query.isError || !query.data)
    return <p className="text-sm">Финансовое влияние недоступно.</p>;
  return (
    <section className="grid gap-2 rounded-[10px] border p-3" aria-label="Финансовое влияние">
      <h3 className="text-sm font-medium">Финансовое влияние</h3>
      <p className="text-sm">{query.data.headline}</p>
      {query.data.items.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {query.data.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2">
              <span>{item.amountType}</span>
              <span>{item.status}</span>
              <span>{item.amountByn} BYN</span>
              {query.data.canManage && item.status === 'DRAFT' ? (
                <Button type="button" variant="outline" onClick={() => void confirm(item.id)}>
                  Подтвердить
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {query.data.canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Сумма BYN
            <Input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <label className="grid gap-1 text-xs">
            Комментарий
            <Input value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          <Button type="button" onClick={() => void save()}>
            Черновик
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
