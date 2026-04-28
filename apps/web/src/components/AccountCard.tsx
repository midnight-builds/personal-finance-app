import type { AccountSignal } from '../api/client';
import { formatAmount } from '../utils';

type AccountCardProps = {
  account: AccountSignal;
};

export default function AccountCard({ account }: AccountCardProps) {
  const subtypeMap: Record<string, { text: string; class: string }> = {
    'checking': { text: 'Käyttö', class: 'chip-subtype-checking' },
    'savings': { text: 'Säästö', class: 'chip-subtype-savings' },
    'credit_card': { text: 'Luotto', class: 'chip-subtype-credit' },
  };

  const subtypeInfo = subtypeMap[account.subtype] || { text: account.subtype, class: '' };

  const trendMap: Record<string, string> = {
    'up': '↑',
    'down': '↓',
    'stable': '→',
  };

  const trendSymbol = account.trend ? trendMap[account.trend] : null;

  return (
    <div className="account-card">
      <div>
        <strong>{account.name}</strong>
      </div>
      <div>{formatAmount(account.balance, 'EUR')}</div>
      <div>
        <span className={`chip ${subtypeInfo.class}`}>{subtypeInfo.text}</span>
        {trendSymbol && (
          <span className={account.trend === 'up' ? 'trend-up' : account.trend === 'down' ? 'trend-down' : ''}>
            {trendSymbol}
          </span>
        )}
        {account.warningLevel !== 'none' && (
          <span className={`chip ${account.warningLevel === 'warn' ? 'chip-warn' : 'chip-alert'}`}>
            {account.warningLevel === 'warn' ? '⚠' : '🚨'}
          </span>
        )}
      </div>
    </div>
  );
}
