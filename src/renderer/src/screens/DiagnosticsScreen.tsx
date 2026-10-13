import { useCallback, useEffect, useState } from 'react';
import type { IntegrityReport, SystemInfo } from '../../../shared/ipc';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { KeyValueList } from '../components/KeyValueList';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { formatBytes, formatNetworkMode, formatPlatform } from '../lib/format';

export function DiagnosticsScreen() {
  const notify = useToast();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState(false);

  const apply = useCallback((result: InfoResult) => {
    setInfo(result.info);
    setLoadError(result.error);
  }, []);

  useEffect(() => {
    let active = true;
    void fetchInfo().then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  const load = async () => apply(await fetchInfo());

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await call('db:integrity-check');
      setReport(result);
      notify(
        result.ok ? 'Database check passed.' : 'Database check found problems.',
        result.ok ? 'success' : 'error',
      );
      void load();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h1>Diagnostics</h1>
        <p className="muted">
          Technical details for troubleshooting. Nothing on this page is sent anywhere.
        </p>
      </header>

      {loadError && (
        <div className="notice row row--between" role="alert">
          <span>{loadError}</span>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {!info && !loadError && <Spinner label="Collecting diagnostics…" />}

      {info && (
        <>
          <Card title="Application">
            <KeyValueList
              items={[
                ['Version', info.app.version],
                ['Profile', info.app.profile ?? 'Default'],
                ['Build', info.app.packaged ? 'Installed' : 'Development'],
                ['Network mode', formatNetworkMode(info.networkMode)],
                [
                  'Operating system',
                  `${formatPlatform(info.os.platform)} ${info.os.release} (${info.os.arch})`,
                ],
                ['Electron', info.runtime.electron],
                ['Chromium', info.runtime.chrome],
                ['Node.js', info.runtime.node],
              ]}
            />
          </Card>

          <Card title="Storage">
            <KeyValueList
              items={[
                ['Data folder', <code key="p">{info.paths.userData}</code>],
                ['Database', <code key="d">{info.paths.database}</code>],
                ['Database size', formatBytes(info.database.sizeBytes)],
                [
                  'Schema version',
                  `${info.database.schemaVersion} of ${info.database.latestKnownVersion}`,
                ],
                [
                  'SQLite',
                  `${info.database.sqliteVersion} (journal: ${info.database.journalMode})`,
                ],
                ['Logs', <code key="l">{info.paths.logs}</code>],
              ]}
            />
          </Card>

          <Card
            title="Database health"
            description="Checks the database file for damage and broken links between records."
            actions={
              <Button variant="primary" loading={checking} onClick={() => void runCheck()}>
                Run check
              </Button>
            }
          >
            {report && (
              <div className="stack" data-testid="integrity-result">
                <div className="row">
                  {report.ok ? (
                    <Badge tone="success">Healthy</Badge>
                  ) : (
                    <Badge tone="danger">Problems found</Badge>
                  )}
                  <span className="muted">
                    Checked {new Date(report.checkedAt).toLocaleTimeString()} in {report.durationMs}{' '}
                    ms
                  </span>
                </div>
                {!report.ok && (
                  <ul>
                    {report.integrity
                      .filter((line) => line !== 'ok')
                      .map((line) => (
                        <li key={line}>
                          <code>{line}</code>
                        </li>
                      ))}
                    {report.foreignKeyViolations > 0 && (
                      <li>{report.foreignKeyViolations} broken links between records</li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

type InfoResult = { info: SystemInfo; error: null } | { info: null; error: string };

async function fetchInfo(): Promise<InfoResult> {
  try {
    return { info: await call('system:info'), error: null };
  } catch (error) {
    return { info: null, error: errorMessage(error) };
  }
}
