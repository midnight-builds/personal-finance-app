type ImportPromptProps = {
  dataAgeDays: number;
  /** The picked files; the import dialog takes it from there. */
  onFiles: (files: File[]) => void;
  status: string;
};

export default function ImportPrompt({ dataAgeDays, onFiles, status }: ImportPromptProps) {
  if (dataAgeDays <= 7) {
    return null;
  }

  const isUrgent = dataAgeDays > 14;
  const className = isUrgent ? 'import-prompt import-prompt-urgent' : 'import-prompt import-prompt-stale';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Cleared so that picking the same file again opens the dialog again.
    e.target.value = '';
    if (files.length > 0) onFiles(files);
  };

  return (
    <div className={className}>
      <span>Viimeisin data {dataAgeDays} pv sitten — tuo uusi tiedosto</span>
      <label>
        <input type="file" accept=".csv,.xlsx" multiple onChange={handleFileChange} style={{ display: 'none' }} />
        Valitse tiedostot
      </label>
      {status && <span>{status}</span>}
    </div>
  );
}
