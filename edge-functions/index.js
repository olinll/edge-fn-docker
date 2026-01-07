// import WebSocket from 'ws'
// import crypto from 'crypto'


const Database = {
    async getObject(key) {
        const value = await nas.get(key)
        if (value == null) {
            return null
        }
        return JSON.parse(value)
    },
    async setObject(key, value) {
        if (value == null) {
            await nas.delete(key)
        } else {
            await nas.put(key, JSON.stringify(value))
        }
    }
}



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

    ctx.config = config
    const key = config.fnId + ':' + config.port
    try {

        try {
            const cache = await Database.getObject(key)
            if (cache) {
                const response = await proxy(request, cache.origin, cache.token)
                response.headers.set('x-edge-kv', 'hit')
                return response
            }
        } catch (error) {
        console.log('缓存访问出错')
        }
        const data = await getFnUrl(ctx);
        const configData = { origin: data.url, token: data.token };
        
        const response = await proxy(request, configData.origin, configData.token)
        response.headers.set('x-edge-kv', 'miss')
        await Database.setObject(key, {origin: ctx.url, token: ctx.token})
        return response
    } catch (error) {
        console.log('error111', error)
        return new Response('访问出错', {status: 500})
    }
}