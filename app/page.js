
'use client';

import { useState, useEffect } from 'react';

export default function Home() {
  const [status, setStatus] = useState('Initializing...');
  const [error, setError] = useState('');

  // Auto-connect on mount
  useEffect(() => {
    // Check for infinite redirect loop
    const retryCount = parseInt(sessionStorage.getItem('nas_retry_count') || '0');
    if (retryCount > 3) {
      setError('Too many redirect attempts. Please check your cookie settings or try clearing your browser cache.');
      setStatus('Failed');
      // Reset count after some time or manually
      return;
    }

    // Increment retry count
    sessionStorage.setItem('nas_retry_count', (retryCount + 1).toString());

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

      const contentType = res.headers.get('content-type');
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        console.error('Non-JSON response:', text);
        // Extract a meaningful error if possible, or show snippet
        const snippet = text.slice(0, 100);
        throw new Error(`Server returned non-JSON response (${res.status}): ${snippet}...`);
      }

      if (data.success) {
        setStatus('Connected! Redirecting to NAS...');
        // Reload the page. The middleware will pick up the cookies and rewrite to NAS.
        setTimeout(() => {
             window.location.reload();
        }, 1000);
      } else {
        // Reset retry count on explicit error so user can retry manually
        sessionStorage.removeItem('nas_retry_count');
        setError(data.error || 'Unknown error');
        setStatus('Failed');
      }
    } catch (err) {
      // Reset retry count on error
      sessionStorage.removeItem('nas_retry_count');
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
