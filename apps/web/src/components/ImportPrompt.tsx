import { useState } from 'react';

type ImportPromptProps = {
  dataAgeDays: number;
  onImport: (file: File) => Promise<void>;
  status: string;
};

export default function ImportPrompt({ dataAgeDays, onImport, status }: ImportPromptProps) {
  const [isLoading, setIsLoading] = useState(false);

  if (dataAgeDays <= 7) {
    return null;
  }

  const isUrgent = dataAgeDays > 14;
  const className = isUrgent ? 'import-prompt import-prompt-urgent' : 'import-prompt import-prompt-stale';

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    try {
      await onImport(file);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={className}>
      <span>Viimeisin data {dataAgeDays} pv sitten — tuo uusi tiedosto</span>
      <label>
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={handleFileChange}
          disabled={isLoading}
          style={{ display: 'none' }}
        />
        {isLoading ? 'Ladataan...' : 'Valitse tiedosto'}
      </label>
      {status && <span>{status}</span>}
    </div>
  );
}
