
'use client';

import { useState, useEffect } from 'react';

export default function Home() {
  const [status, setStatus] = useState('Initializing...');
  const [error, setError] = useState('');

  // Auto-connect on mount
  useEffect(() => {
    handleConnect();
  }, []);

  const handleConnect = async () => {
    setError('');
    setStatus('Connecting to NAS...');

    try {
      // No params needed, server will use env vars
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) 
      });

      const data = await res.json();

      if (data.success) {
        setStatus('Connected! Redirecting to NAS...');
        // Reload the page. The middleware will pick up the cookies and rewrite to NAS.
        window.location.reload();
      } else {
        setError(data.error || 'Unknown error');
        setStatus('Failed');
      }
    } catch (err) {
      setError(err.message);
      setStatus('Error');
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24 bg-gray-100">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm lg:flex flex-col">
        <h1 className="text-4xl font-bold mb-8 text-blue-600">NAS Connector</h1>
        
        <div className="bg-white p-8 rounded-xl shadow-lg w-full max-w-md text-center">
          <div className="mb-6">
            <div className="text-lg text-gray-800 mb-4">
               {error ? 'Connection Failed' : status}
            </div>
            
            {/* Loading Spinner */}
            {!error && (
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            )}

            {error && <div className="text-red-500 text-sm mt-4 p-4 bg-red-50 rounded">{error}</div>}
          </div>

          {error && (
            <button 
              onClick={handleConnect}
              className="mt-4 bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors"
            >
              Retry Connection
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
