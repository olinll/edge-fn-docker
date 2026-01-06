
import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;
  
  // DEBUG LOG
  console.log(`[Middleware] Path: ${pathname}`);
  const nasUrl = request.cookies.get('nas_url')?.value;
  const nasToken = request.cookies.get('nas_token')?.value;
  console.log(`[Middleware] Cookies - nas_url: ${nasUrl}, nas_token: ${nasToken ? 'YES' : 'NO'}`);

  // Skip Next.js internal requests and API routes
  if (pathname.startsWith('/_next') || pathname.startsWith('/api') || pathname.startsWith('/static')) {
    return NextResponse.next();
  }

  // If cookies are present, proxy the request to NAS
  if (nasUrl && nasToken) {
    // TEST: Redirect to Baidu to verify middleware execution and cookie presence
    return NextResponse.redirect('https://www.baidu.com');
    
    // Construct target URL
    // If pathname is '/', we proxy to nasUrl + '/'
    // If pathname is '/foo', we proxy to nasUrl + '/foo'
    const targetUrl = new URL(pathname + request.nextUrl.search, nasUrl);
    
    // Rewrite the request (Server-Side Proxy)
    const response = NextResponse.rewrite(targetUrl, {
        request: {
            headers: new Headers(request.headers),
        },
    });

    // Inject Cookie header for authentication
    // Note: We need to set the 'Cookie' header on the *outgoing* request to the NAS.
    // NextResponse.rewrite allows modifying request headers.
    // But setting 'Cookie' header might overwrite existing cookies.
    // The NAS expects 'entry-token=...; mode=relay; language=zh;'
    
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Cookie', `mode=relay; language=zh; entry-token=${nasToken}`);
    newHeaders.set('Host', new URL(nasUrl).host); // Important for Virtual Hosts
    // Remove Origin/Referer to avoid CORS issues if possible, or set them to NAS domain
    newHeaders.set('Origin', nasUrl);
    newHeaders.set('Referer', nasUrl);

    return NextResponse.rewrite(targetUrl, {
        request: {
            headers: newHeaders
        }
    });
  }

  // Otherwise, allow normal Next.js handling (e.g. serve app/page.js)
  return NextResponse.next();
}

export const config = {
  matcher: '/:path*',
};
