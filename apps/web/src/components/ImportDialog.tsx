import { useEffect, useRef, useState } from 'react';
import type {
  AccountSubtype,
  DataGap,
  ImportPreviewAccount,
  ImportPreviewAnalysis,
  ImportPreviewFile,
  ImportPreviewGuess,
} from '@finance-app/shared';
import { ImportRequestError, importFile, previewImport } from '../api/client';
import type { ImportChoice, ImportResult } from '../api/client';

// Import flow: the user picks one or more files; each is previewed in turn
// (where it would go and what it would do), the user confirms or picks the
// account, and only then is it imported. The next file's preview is fetched
// after the previous import, so its overlap numbers include that file.

const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  checking: 'Käyttötili',
  savings: 'Säästötili',
  credit_card: 'Luottokortti',
};

const eur = new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR' });

/** 2026-03-12 → 12.3.2026 */
function fiDate(day: string | null | undefined) {
  if (!day) return '–';
  const [y, m, d] = day.split('-').map(Number);
  return `${d}.${m}.${y}`;
}

/** 2026-03-12 → 12.3. */
function fiDayMonth(day: string) {
  const [, m, d] = day.split('-').map(Number);
  return `${d}.${m}.`;
}

function accountLabel(a: ImportPreviewAccount) {
  const range = a.firstDate ? `, ${fiDate(a.firstDate)}–${fiDate(a.lastDate)}` : ', ei tapahtumia';
  return `${a.name} (${SUBTYPE_LABELS[a.subtype] ?? a.subtype}${range})`;
}

function errorText(err: unknown) {
  if (err instanceof ImportRequestError) {
    switch (err.code) {
      case 'account_name_exists':
        return 'Tämänniminen tili on jo olemassa — anna toinen nimi tai valitse tili listasta.';
      case 'account_not_found':
        return 'Valittua tiliä ei enää löydy — valitse tili uudelleen.';
      case 'account_required':
        return 'Tiedostosta ei tunnistettu tiliä — valitse tili.';
      case 'iban_mismatch':
      case 'iban_in_use':
        return 'Tiedoston IBAN kuuluu toiselle tilille — vahvista valinta ruksilla, jos tili on silti oikea.';
      case 'invalid_request':
        return 'Tiedot ovat puutteelliset — tarkista tilin nimi ja tyyppi.';
    }
  }
  return 'Pyyntö epäonnistui. Tarkista, että tiedosto on Nordean CSV- tai XLSX-tiliote.';
}

type Choice = { kind: 'existing'; accountId: string } | { kind: 'new' } | null;

export type ImportOutcome = { filename: string; status: 'imported' | 'skipped'; message: string };

type StepProps = {
  file: File;
  onBusyChange: (busy: boolean) => void;
  onDone: (outcome: ImportOutcome, result?: ImportResult) => void;
};

/** One file of the queue: preview, choice of account, confirm. */
function ImportFileStep({ file, onBusyChange, onDone }: StepProps) {
  // From the first preview: the file, the accounts and the guess. Later
  // previews name the target, so they carry no guess; only the analysis changes.
  const [base, setBase] = useState<{ file: ImportPreviewFile; accounts: ImportPreviewAccount[]; guess: ImportPreviewGuess } | null>(null);
  const [analysis, setAnalysis] = useState<ImportPreviewAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState<Choice>(null);
  const [newName, setNewName] = useState('');
  const [newSubtype, setNewSubtype] = useState<AccountSubtype>('checking');
  const [ibanConfirmed, setIbanConfirmed] = useState(false);
  // Only the latest preview request may update the view.
  const requestSeq = useRef(0);

  const requestPreview = (as?: { accountId: string } | 'new') => {
    const seq = ++requestSeq.current;
    return previewImport(file, as).then(
      (p) => {
        if (seq !== requestSeq.current) return null;
        setAnalysis(p.analysis);
        setError('');
        setLoading(false);
        return p;
      },
      (err) => {
        if (seq !== requestSeq.current) return null;
        // No numbers for this choice: nothing to confirm until a preview succeeds.
        setAnalysis(null);
        setError(errorText(err));
        setLoading(false);
        return null;
      }
    );
  };

  useEffect(() => {
    requestPreview().then((p) => {
      if (!p?.guess) return;
      setBase({ file: p.file, accounts: p.accounts, guess: p.guess });
      // The analysis is for the guess, or for a new account when there is none:
      // shown only once the user has a choice.
      setChoice(p.guess.accountId ? { kind: 'existing', accountId: p.guess.accountId } : null);
      setNewName(p.guess.newAccount.name);
      setNewSubtype(p.guess.newAccount.subtype);
    });
    // Once per file: the step is keyed by the file's place in the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = (value: string) => {
    setIbanConfirmed(false);
    setAnalysis(null);
    setError('');
    if (value === '') {
      setChoice(null);
      return;
    }
    setLoading(true);
    if (value === 'new') {
      setChoice({ kind: 'new' });
      requestPreview('new');
    } else {
      setChoice({ kind: 'existing', accountId: value });
      requestPreview({ accountId: value });
    }
  };

  const skip = () => onDone({ filename: file.name, status: 'skipped', message: 'Ohitettu' });

  if (!base) {
    return (
      <div className="import-step" aria-busy={loading}>
        <h3>{file.name}</h3>
        {loading && <p className="muted">Luetaan tiedostoa…</p>}
        {error && <p className="import-error" role="alert">{error}</p>}
        {!loading && (
          <div className="import-actions">
            <button type="button" className="ghost" onClick={skip}>Ohita tiedosto</button>
          </div>
        )}
      </div>
    );
  }

  const { file: f, guess, accounts } = base;
  const a = analysis;
  const guessedName = accounts.find((acc) => acc.id === guess.accountId)?.name;
  const target = choice?.kind === 'existing' ? accounts.find((acc) => acc.id === choice.accountId) : undefined;
  const selectValue = choice === null ? '' : choice.kind === 'new' ? 'new' : choice.accountId;

  // The file's own IBAN points elsewhere: importing needs an explicit yes.
  let ibanWarning = '';
  if (choice?.kind === 'existing' && a?.ibanMismatch && target) {
    ibanWarning = `Tiedoston IBAN (${f.ownIban}) on eri kuin tilin ${target.name} IBAN (${target.iban}).`;
  } else if (choice?.kind === 'new' && f.ownIbanAccount) {
    ibanWarning = `Tiedoston IBAN (${f.ownIban}) kuuluu jo tilille ${f.ownIbanAccount.name}.`;
  }

  const canConfirm =
    !!choice &&
    !!a &&
    !loading &&
    !importing &&
    (choice.kind === 'existing' || newName.trim() !== '') &&
    (!ibanWarning || ibanConfirmed);

  const confirm = async () => {
    if (!choice || !canConfirm) return;
    const target: ImportChoice =
      choice.kind === 'existing'
        ? { accountId: choice.accountId }
        : { newAccount: { name: newName.trim(), subtype: newSubtype } };
    const targetName =
      choice.kind === 'existing' ? accounts.find((acc) => acc.id === choice.accountId)?.name ?? '' : newName.trim();
    setImporting(true);
    onBusyChange(true);
    setError('');
    try {
      const result = await importFile(file, target, { allowIbanMismatch: ibanConfirmed });
      const parts = [`${result.normalizedCount} riviä tilille ${targetName}`];
      if (result.duplicateCount) parts.push(`${result.duplicateCount} oli jo tuotu`);
      if (result.transferCount) parts.push(`${result.transferCount} siirtoa`);
      if (result.skippedCount) parts.push(`${result.skippedCount} ohitettu`);
      onDone({ filename: file.name, status: 'imported', message: `Tuotu: ${parts.join(', ')}` }, result);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setImporting(false);
      onBusyChange(false);
    }
  };

  let guessText: string;
  if (guess.reason === 'iban') guessText = `Tunnistettu IBANista: ${guessedName}`;
  else if (guess.reason === 'overlap') guessText = `${guess.overlapCount} päällekkäistä tapahtumaa tilin ${guessedName} kanssa`;
  else guessText = 'Tiliä ei tunnistettu — valitse tili';

  const notes: string[] = [];
  const warnings: string[] = [];
  if (a) {
    const range = (g: DataGap) => `${fiDate(g.from)}–${fiDate(g.to)}`;
    const gapText = (g: DataGap, where: string) => {
      if (g.balance === 'matches') {
        notes.push(`${g.days} päivää ilman tapahtumia ${where} (${range(g)}), saldo täsmää — mitään ei puutu.`);
      } else if (g.balance === 'differs') {
        warnings.push(`${g.days} päivää puuttuu ${where} (${range(g)}): saldoissa on eroa ${eur.format(g.difference ?? 0)}.`);
      } else {
        warnings.push(`${g.days} päivää puuttuu ${where} (${range(g)}).`);
      }
    };
    if (a.gapBefore) gapText(a.gapBefore, 'ennen tätä tiedostoa');
    if (a.gapAfter) gapText(a.gapAfter, 'tämän tiedoston ja tilin aiempien tietojen välistä');
    for (const b of a.balanceBreaks) {
      warnings.push(`Saldo ei täsmää ${fiDayMonth(b.date)}: puuttuu ${eur.format(b.difference)} (odotettu ${eur.format(b.expected)}, tiedostossa ${eur.format(b.actual)}).`);
    }
    if (a.openingMismatch) {
      const o = a.openingMismatch;
      warnings.push(
        `Tiedoston alkusaldo ${eur.format(o.actual)} ei täsmää tilin saldoon ${eur.format(o.expected)} ennen ${fiDate(o.date)} — ero ${eur.format(o.difference)}.`
      );
    }
  }

  return (
    <div className="import-step" aria-busy={loading || importing}>
      <h3>{f.filename}</h3>
      <p className="muted">
        {f.firstDate ? `${fiDate(f.firstDate)}–${fiDate(f.lastDate)}` : 'Ei kirjattuja tapahtumia'} · {f.bookedCount} tapahtumaa
        {f.pendingCount > 0 && ` · ${f.pendingCount} varausta (ei vielä kirjattu)`}
        {f.skippedCount > 0 && ` · ${f.skippedCount} riviä ilman summaa ohitetaan`}
      </p>

      <p className={guess.reason === 'none' ? 'import-guess import-guess-none' : 'import-guess'}>{guessText}</p>

      <div className="import-target">
        <label>
          Kohdetili
          <select value={selectValue} onChange={(e) => onSelect(e.target.value)} disabled={importing}>
            <option value="" disabled>
              Valitse tili…
            </option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {accountLabel(acc)}
                {acc.id === guess.accountId ? ' — arvaus' : ''}
              </option>
            ))}
            <option value="new">Uusi tili…</option>
          </select>
        </label>
        {choice?.kind === 'new' && (
          <div className="import-new-account">
            <label>
              Tilin nimi
              <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} required disabled={importing} />
            </label>
            <label>
              Tyyppi
              <select value={newSubtype} onChange={(e) => setNewSubtype(e.target.value as AccountSubtype)} disabled={importing}>
                {(Object.keys(SUBTYPE_LABELS) as AccountSubtype[]).map((s) => (
                  <option key={s} value={s}>
                    {SUBTYPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      <div className="import-analysis" aria-live="polite">
        {choice === null ? (
          <p className="muted">Valitse kohdetili, niin näet päällekkäisyydet ja aukot.</p>
        ) : loading ? (
          <p className="muted">Lasketaan…</p>
        ) : a ? (
          <>
            <ul className="import-facts">
              <li>
                <strong>{a.duplicates}</strong> tapahtumaa on jo tuotu (päällekkäin), <strong>{a.newRows}</strong> uutta
                {f.pendingCount > 0 && ` · ${f.pendingCount} varausta erikseen`}
                {a.overlap && ` · päällekkäin ${fiDate(a.overlap.from)}–${fiDate(a.overlap.to)}`}
              </li>
              {a.transfers > 0 && <li>{a.transfers} siirtoa omien tilien välillä tunnistettu</li>}
              {a.quietPeriods.map((q) => (
                <li key={q.from}>
                  Hiljainen jakso {fiDate(q.from)}–{fiDate(q.to)}: {q.days} päivää ilman tapahtumia
                </li>
              ))}
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {!f.hasRunningBalance && <li className="muted">Tiedostossa ei ole saldoa, joten puuttuvia rivejä ei voi tarkistaa saldosta.</li>}
            </ul>
            {warnings.length > 0 && (
              <ul className="import-warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>

      {ibanWarning && (
        <div className="import-warnings import-iban-warning">
          <p>{ibanWarning}</p>
          <label className="import-checkbox">
            <input
              type="checkbox"
              checked={ibanConfirmed}
              onChange={(e) => setIbanConfirmed(e.target.checked)}
              disabled={importing}
            />
            Tuo silti tälle tilille
          </label>
        </div>
      )}

      {error && <p className="import-error" role="alert">{error}</p>}

      <div className="import-actions">
        <button type="button" onClick={confirm} disabled={!canConfirm}>
          {importing ? 'Tuodaan…' : 'Tuo tiedosto'}
        </button>
        <button type="button" className="ghost" onClick={skip} disabled={importing}>
          Ohita tiedosto
        </button>
      </div>
    </div>
  );
}

type DialogProps = {
  files: File[];
  onClose: (outcomes: ImportOutcome[]) => void;
  /** After each imported file, e.g. to refresh the views. */
  onImported: (result: ImportResult) => void;
};

/** Modal import queue; open while mounted. */
export default function ImportDialog({ files, onClose, onImported }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const done = index >= files.length;
  const close = () => {
    if (!busy) onClose(outcomes);
  };

  const onDone = (outcome: ImportOutcome, result?: ImportResult) => {
    setOutcomes((prev) => [...prev, outcome]);
    setIndex((i) => i + 1);
    if (result) onImported(result);
  };

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog"
      aria-labelledby="import-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="card-head">
        <div>
          <p className="eyebrow">{done ? 'Valmis' : `Tiedosto ${index + 1} / ${files.length}`}</p>
          <h2 id="import-dialog-title">Tuo tiliotteet</h2>
        </div>
        <button type="button" className="ghost mini" onClick={close} disabled={busy} aria-label="Sulje">
          ✕
        </button>
      </div>

      {files.length > 1 && (
        <>
          <p className="muted">
            Tiedostot käydään läpi valitsemassasi järjestyksessä. Vanhinta tiedostoa ei tarvitse tuoda ensin:
            päällekkäiset tapahtumat yhdistetään järjestyksestä riippumatta.
          </p>
          <ol className="import-queue">
            {files.map((file, i) => (
              <li key={`${i}-${file.name}`} aria-current={i === index ? 'step' : undefined} className={i === index ? 'current' : undefined}>
                <span>{file.name}</span>
                <span className="muted">{outcomes[i]?.message ?? (i === index ? 'Käsittelyssä' : 'Odottaa')}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {done ? (
        <div className="import-step">
          <ul className="import-facts">
            {outcomes.map((o, i) => (
              <li key={i}>
                <strong>{o.filename}</strong>: {o.message}
              </li>
            ))}
          </ul>
          <div className="import-actions">
            <button type="button" onClick={close} autoFocus>
              Sulje
            </button>
          </div>
        </div>
      ) : (
        <ImportFileStep key={index} file={files[index]} onBusyChange={setBusy} onDone={onDone} />
      )}
    </dialog>
  );
}
