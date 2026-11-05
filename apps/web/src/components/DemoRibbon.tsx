import { useEffect, useState } from 'react';
import { API, safeFetch } from '../utils';

/** A full-width warning shown only when the API serves the fictional demo database. */
export default function DemoRibbon() {
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await safeFetch(`${API}/data-status`);
      if (!res.ok) return;
      const status = (await res.json()) as { dataset?: string };
      if (!cancelled) setIsDemo(status.dataset === 'demo');
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isDemo) return null;
  return (
    <div className="demo-ribbon" role="status">
      DEMO — kuvitteellista dataa kehitystä varten, ei oikeita tapahtumia
    </div>
  );
}
