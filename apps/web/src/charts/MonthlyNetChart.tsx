import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { MonthlyRow } from '../api/client';

type MonthlyNetChartProps = {
  data: MonthlyRow[];
};

export default function MonthlyNetChart({ data }: MonthlyNetChartProps) {
  if (data.length === 0) return <p>Ei kuukausidataa.</p>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" />
        <YAxis unit=" €" />
        <Tooltip />
        <Legend />
        <Bar dataKey="income" name="Tulot" fill="#16a34a" />
        <Bar dataKey="expense" name="Menot" fill="#dc2626" />
      </BarChart>
    </ResponsiveContainer>
  );
}
