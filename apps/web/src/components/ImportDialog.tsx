import { useEffect, useRef, useState } from 'react';
import type { AccountSubtype, ImportPreview, ImportPreviewAccount } from '@finance-app/shared';
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
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState<Choice>(null);
  const [newName, setNewName] = useState('');
  const [newSubtype, setNewSubtype] = useState<AccountSubtype>('checking');
  // Only the latest preview request may update the view.
  const requestSeq = useRef(0);

  const requestPreview = (as?: { accountId: string } | 'new') => {
    const seq = ++requestSeq.current;
    return previewImport(file, as).then(
      (p) => {
        if (seq !== requestSeq.current) return null;
        setPreview(p);
        setError('');
        setLoading(false);
        return p;
      },
      (err) => {
        if (seq !== requestSeq.current) return null;
        setError(errorText(err));
        setLoading(false);
        return null;
      }
    );
  };

  useEffect(() => {
    requestPreview().then((p) => {
      if (!p) return;
      setChoice(p.guess.accountId ? { kind: 'existing', accountId: p.guess.accountId } : null);
      setNewName(p.guess.newAccount.name);
      setNewSubtype(p.guess.newAccount.subtype);
    });
    // Once per file: the step is keyed by the file's place in the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = (value: string) => {
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

  const confirm = async () => {
    if (!preview || !choice) return;
    const target: ImportChoice =
      choice.kind === 'existing'
        ? { accountId: choice.accountId }
        : { newAccount: { name: newName.trim(), subtype: newSubtype } };
    const targetName =
      choice.kind === 'existing' ? preview.accounts.find((a) => a.id === choice.accountId)?.name ?? '' : newName.trim();
    setImporting(true);
    onBusyChange(true);
    setError('');
    try {
      const result = await importFile(file, target);
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

  const skip = () => onDone({ filename: file.name, status: 'skipped', message: 'Ohitettu' });

  if (!preview) {
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

  const { file: f, guess, accounts, analysis: a } = preview;
  const guessedName = accounts.find((acc) => acc.id === guess.accountId)?.name;
  const target = choice?.kind === 'existing' ? accounts.find((acc) => acc.id === choice.accountId) : undefined;
  const selectValue = choice === null ? '' : choice.kind === 'new' ? 'new' : choice.accountId;
  const canConfirm = !!choice && !loading && !importing && (choice.kind === 'existing' || newName.trim() !== '');

  let guessText: string;
  if (guess.reason === 'iban') guessText = `Tunnistettu IBANista: ${guessedName}`;
  else if (guess.reason === 'overlap') guessText = `${guess.overlapCount} päällekkäistä tapahtumaa tilin ${guessedName} kanssa`;
  else guessText = 'Tiliä ei tunnistettu — valitse tili';

  const warnings: string[] = [];
  if (a.ibanMismatch && target) warnings.push(`Tiedoston IBAN (${f.ownIban}) on eri kuin tilin ${target.name} IBAN (${target.iban}).`);
  if (a.gapBefore) {
    warnings.push(`${a.gapBefore.days} päivää puuttuu ennen tätä tiedostoa (${fiDate(a.gapBefore.from)}–${fiDate(a.gapBefore.to)}).`);
  }
  if (a.gapAfter) {
    warnings.push(
      `${a.gapAfter.days} päivää puuttuu tämän tiedoston ja tilin aiempien tietojen välistä (${fiDate(a.gapAfter.from)}–${fiDate(a.gapAfter.to)}).`
    );
  }
  for (const b of a.balanceBreaks) {
    warnings.push(`Saldo ei täsmää ${fiDayMonth(b.date)}: puuttuu ${eur.format(b.difference)} (odotettu ${eur.format(b.expected)}, tiedostossa ${eur.format(b.actual)}).`);
  }
  if (a.openingMismatch) {
    const o = a.openingMismatch;
    warnings.push(
      `Tiedoston alkusaldo ${eur.format(o.actual)} ei täsmää tilin saldoon ${eur.format(o.expected)} ennen ${fiDate(o.date)} — ero ${eur.format(o.difference)}.`
    );
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
        ) : (
          <>
            <ul className="import-facts">
              <li>
                <strong>{a.duplicates}</strong> tapahtumaa on jo tuotu (päällekkäin), <strong>{a.newRows}</strong> uutta
                {a.overlap && ` · päällekkäin ${fiDate(a.overlap.from)}–${fiDate(a.overlap.to)}`}
              </li>
              {a.transfers > 0 && <li>{a.transfers} siirtoa omien tilien välillä tunnistettu</li>}
              {a.quietPeriods.map((q) => (
                <li key={q.from}>
                  Hiljainen jakso {fiDate(q.from)}–{fiDate(q.to)}: {q.days} päivää ilman tapahtumia
                </li>
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
        )}
      </div>

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
