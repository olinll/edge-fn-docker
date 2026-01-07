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



const proxy = async (request, origin, token) => {
    const requestUrl = new URL(request.url)
    const requestOrigin = requestUrl.origin

    const target = request.url.replace(requestOrigin, origin)
    const targetUrl = new URL(target)
    const targetHeaders = new Headers(request.headers)
    targetHeaders.set('host', targetUrl.host)

    const cookieObject = CookieHelper.getCookieObject(request.headers.get('cookie'))
    cookieObject['entry-token'] = token
    targetHeaders.set('cookie', CookieHelper.getCookieStr(cookieObject))

    const response = await fetch(targetUrl, {
        method: request.method,
        headers: targetHeaders,
        body: request.body,
        redirect: 'manual'
    })


    // if (Array.from(response.headers.keys()).length === 1) {
    //     if (response.headers.get('content-type') === 'text/html; charset=UTF-8') {
    //         const clone = response.clone()
    //         const html = await clone.text()
    //         if (html.includes('https://www.ug.link/errorPage')) {
    //             throw new Error('访问错误')
    //         }
    //     }
    // }

    return response
}

const getFnUrl = async ctx => {
    const config ={
        fnId: ctx.config.fnId,
        username: ctx.config.username,
        password: ctx.config.password,
        port: ctx.config.port,
        key: ctx.config.key,
    }
    console.log('config',config)
    const aliasUrl = new URL(ctx.config.api + '/api/fn/connect')
    const response = await fetch(aliasUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(config)
    })
    const res = await response.json()
    // console.log('res',res)
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
        api: env.FN_API,
    }
    const ctx = {}
    // const key = config.alias + ':' + config.port
    // try {
    //     const cache = await Database.getObject(key)
    //     if (cache) {
    //         const response = await proxy(request, cache.origin, cache.token)
    //         response.headers.set('x-edge-kv', 'hit')
    //         return response
    //     }
    // } catch (error) {
    //     console.log('缓存访问出错')
    // }
    ctx.config = config
    try {
        let data = await getFnUrl(ctx);
        console.log('data',data)
        const response1 = await proxy(request, data.url,data.token)
        response1.headers.set('x-edge-kv', 'miss')
        // await Database.setObject(key, {origin: ctx.proxyOrigin, token: ctx.proxyToken})
        return response1
    } catch (error) {
        console.log('error', error)
        return new Response('访问出错', {status: 500})
    }
}