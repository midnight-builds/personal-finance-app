import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type DataPoint = { date: string; [account: string]: number | string };

type BalanceChartProps = {
  data: DataPoint[];
  accountNames: string[];
};

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#ea580c', '#7c3aed'];

export default function BalanceChart({ data, accountNames }: BalanceChartProps) {
  if (data.length === 0) return <p>Ei saldodataa.</p>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis unit=" €" />
        <Tooltip />
        <Legend />
        {accountNames.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COLORS[i % COLORS.length]}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
