// import WebSocket from 'ws'
// import crypto from 'crypto'






const CookieHelper = {
    getSetCookieObject(response) {
        const cookieObject = {}
        const setCookie = response.headers.getSetCookie()
        if (setCookie) {
            for (let cookieStr of setCookie) {
                const [key, value] = cookieStr.split(';')[0].split('=')
                cookieObject[key] = value
            }
        }
        return cookieObject
    },
    getCookieObject(cookieStr) {
        const cookieObject = {}
        if (cookieStr == null) {
            return cookieObject
        }
        const cookieArr = cookieStr.split('; ')
        for (let cookie of cookieArr) {
            const cookieObj = cookie.split('=')
            cookieObject[cookieObj[0]] = decodeURIComponent(cookieObj[1])
        }
        return cookieObject
    },
    getCookieStr(cookieObject) {
        const cookieArr = []
        if (cookieObject) {
            for (let key of Object.keys(cookieObject)) {
                cookieArr.push(key + '=' + encodeURIComponent(cookieObject[key]))
            }
        }
        return cookieArr.join('; ')
    }
}

const memoryCache = new Map();
const pendingRequests = new Map();

const ConfigManager = {
    async getConfig(key, fetcher) {
        // 1. Check Memory Cache
        const cachedItem = memoryCache.get(key);
        if (cachedItem && Date.now() < cachedItem.expireAt) {
            return { ...cachedItem.value, hit: 'memory' };
        }

        // 2. Check Pending Requests
        if (pendingRequests.has(key)) {
            try {
                const value = await pendingRequests.get(key);
                return { ...value, hit: 'coalesced' };
            } catch (e) {
                throw e;
            }
        }

        // 3. Fetch New Data
        const promise = (async () => {
            try {
                const data = await fetcher();
                const value = { origin: data.url, token: data.token };
                // Cache for 60 seconds
                memoryCache.set(key, {
                    value,
                    expireAt: Date.now() + 60 * 1000
                });
                return value;
            } finally {
                pendingRequests.delete(key);
            }
        })();

        pendingRequests.set(key, promise);
        try {
            const result = await promise;
            return { ...result, hit: 'miss' };
        } catch (error) {
            throw error;
        }
    }
}



const proxy = async (request, origin, token) => {
    const requestUrl = new URL(request.url)
    const requestOrigin = requestUrl.origin

    const target = request.url.replace(requestOrigin, origin)
    const targetUrl = new URL(target)
    const targetHeaders = new Headers()
    // Filter hop-by-hop headers
    const hopByHopHeaders = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'host' // Host is set explicitly
    ]

    for (const [key, value] of request.headers) {
        if (!hopByHopHeaders.includes(key.toLowerCase())) {
            targetHeaders.set(key, value)
        }
    }
    
    targetHeaders.set('host', targetUrl.host)
    // Force close connection to avoid concurrency issues with connection reuse
    targetHeaders.set('connection', 'close')

    const cookieObject = CookieHelper.getCookieObject(request.headers.get('cookie'))
    cookieObject['entry-token'] = token
    targetHeaders.set('cookie', CookieHelper.getCookieStr(cookieObject))

    const maxRetries = 3;
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            // Handle body for retries
            let fetchBody = request.body;
            let fetchMethod = request.method;
            
            // If it's not the last try, and we have a body, we might need to handle it.
            // However, streams are single-use.
            // For safety, we only retry idempotent requests without body (GET/HEAD)
            // or if we can ensure body integrity (TODO: implement body buffering if needed)
            const isIdempotent = ['GET', 'HEAD'].includes(fetchMethod.toUpperCase());
            
            if (i > 0 && !isIdempotent) {
                // Cannot retry request with consumed body stream without buffering
                throw lastError;
            }

            const response = await fetch(targetUrl, {
                method: fetchMethod,
                headers: targetHeaders,
                body: fetchBody,
                redirect: 'manual'
            })
            
            return response;
        } catch (error) {
            lastError = error;
            const isPeerError = error.message && (
                error.message.includes('net_exception_peer_error') || 
                error.message.includes('net_exception_closed') ||
                error.message.includes('net_exception_timeout')
            );

            // If it's not a network peer error, rethrow immediately
            if (!isPeerError) throw error;
            
            // If it is a peer error, wait and retry
            if (i < maxRetries - 1) {
                // Exponential backoff: 100ms, 200ms, etc.
                await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
                console.log(`Retry ${i + 1}/${maxRetries} for ${targetUrl} due to ${error.message}`);
                continue;
            }
        }
    }
    
    throw lastError;
}

const getFnUrl = async ctx => {
    const config ={
        fnId: ctx.config.fnId,
        username: ctx.config.username,
        password: ctx.config.password,
        port: ctx.config.port,
        key: ctx.config.key,
    }
    // console.log('config',config)
    const aliasUrl = new URL(ctx.config.api + '/api/fn/connect')
    const response = await fetch(aliasUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(config)
    })
    const res = await response.json()
    console.log('res',res)
    return res;
}

export async function onRequest(context) {
    let request = context.request
    const env = context.env
    const config = {
        fnId: env.FN_ID,
        username: env.FN_USERNAME,
        password: env.FN_PASSWORD,
        port: env.FN_PORT,
        key: env.FN_KEY,
        api: env.FN_API
    }
    const ctx = {}
    const key = config.fnId
    ctx.config = config

    try {
        const configData =
        // {success:true,token:'cac1d6d348c34485ac73eae8c465f281',origin:'https://9719e9b66f39-0.lin288.5ddd.com'}
    // {success:true,token:'5681f223e51140f5b95c9dc4bdf11bdb',origin:'https://7e66dd8e82c2-1.lin288.5ddd.com'}
    await ConfigManager.getConfig(key, () => getFnUrl(ctx));
        
        const response = await proxy(request, configData.origin, configData.token)
        // response.headers.set('x-edge-kv', configData.hit)
        return response
    } catch (error) {
        console.log('error111', error)
        return new Response('访问出错', {status: 500})
    }
}