import { useState } from 'react';

import { apiGet } from '@/lib/apiClient';
import type { ApiError } from '@/lib/apiError';

export default function LoginPage() {
  // throw new Error('FE-09 crash test');
  const [last, setLast] = useState<string>('(no call yet)');

  const callHealthOk = async () => {
    try {
      const res = await apiGet<unknown>('/api/health');
      console.log('[health:ok]', res);
      setLast(JSON.stringify({ ok: true, res }, null, 2));
    } catch (e) {
      console.error('[health:ok:error]', e);
      setLast(JSON.stringify({ ok: false, error: e as ApiError }, null, 2));
    }
  };

  const callHealthFail = async () => {
    try {
      const res = await apiGet<unknown>('/api/health', {
        baseUrl: 'http://127.0.0.1:59999',
        timeoutMs: 1500,
      });
      console.log('[health:fail-unexpected-ok]', res);
      setLast(JSON.stringify({ ok: true, res }, null, 2));
    } catch (e) {
      console.error('[health:fail:expected-error]', e);
      setLast(JSON.stringify({ ok: false, error: e as ApiError }, null, 2));
    }
  };

  return (
    <main style={{ padding: 24 }}>
      <h1>Login</h1>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type='button' onClick={callHealthOk}>
          GET /api/health (ok)
        </button>
        <button type='button' onClick={callHealthFail}>
          GET /api/health (fail)
        </button>
      </div>

      <pre
        style={{
          marginTop: 12,
          padding: 12,
          border: '1px solid #ddd',
          borderRadius: 8,
          whiteSpace: 'pre-wrap',
        }}
      >
        {last}
      </pre>
    </main>
  );
}
