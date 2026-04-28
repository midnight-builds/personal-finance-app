import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { RecurringPattern } from '../api/client';

type SubscriptionChartProps = {
  data: RecurringPattern[];
};

export default function SubscriptionChart({ data }: SubscriptionChartProps) {
  if (data.length === 0) return <p>Ei tilauksia tunnistettu.</p>;

  const transformed = data.map(p => ({ name: p.counterparty_name, amount: p.typical_amount }));

  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={transformed} layout="vertical">
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" unit=" €" />
        <YAxis dataKey="name" type="category" width={120} />
        <Tooltip />
        <Bar dataKey="amount" name="€/kk" fill="#7c3aed" />
      </BarChart>
    </ResponsiveContainer>
  );
}
