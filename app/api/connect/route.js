
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers'; // Import cookies
import WebSocket from 'ws';
import crypto from 'crypto';

// FnOsClient (Server-Side Implementation using Native Node.js Crypto)
class FnOsClient {
    constructor(url, options = {}) {
        this.url = url;
        this.ws = null;
        this.reqIdIndex = 1;
        this.callbacks = new Map();
        this.backId = '0000000000000000';

        // Encryption keys (Matched with fnos.js)
        this.key = this.generateRandomString(32);
        this.iv = crypto.randomBytes(16);
        this.rsaPub = null;
        this.si = null;
        
        // Session info
        this.token = null;
        this.secret = null;

        this.logger = options.logger || console;
        this.headers = options.headers || {};
    }

    generateRandomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    getReqId() {
        const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
        const e = (this.reqIdIndex++).toString(16).padStart(4, '0');
        return `${t}${this.backId}${e}`;
    }

    // Generate a random entry-token (32 hex chars) to mimic client behavior
    // It seems the server expects this cookie to be present even for initial connection.
    generateEntryToken() {
        return crypto.randomBytes(16).toString('hex');
    }

    async connect() {
        return new Promise((resolve, reject) => {
            let wsUrl = this.url;
            if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
                if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://');
                else if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');
                else wsUrl = `wss://${wsUrl}`;
            }
            
            if (!wsUrl.includes('/websocket')) {
                wsUrl += '/websocket?type=main';
            }

            console.log('Connecting to WebSocket:', wsUrl);

            // Ensure headers have the token
            if (!this.headers['Cookie'] || !this.headers['Cookie'].includes('entry-token')) {
                const token = this.generateEntryToken();
                const cookiePart = `entry-token=${token}`;
                if (this.headers['Cookie']) {
                    this.headers['Cookie'] += `; ${cookiePart}`;
                } else {
                    this.headers['Cookie'] = `mode=relay; language=zh; ${cookiePart}`;
                }
            }

            this.ws = new WebSocket(wsUrl, {
                headers: this.headers,
                rejectUnauthorized: false
            });

            this.ws.on('open', () => {
                this.logger.log('WebSocket connected');
                resolve();
            });

            this.ws.on('error', (err) => {
                this.logger.error('WebSocket error:', err);
                reject(err);
            });

            this.ws.on('message', (data) => this.handleMessage(data));

            this.ws.on('close', () => {
                this.logger.log('WebSocket closed');
            });
        });
    }

    handleMessage(message) {
        try {
            const data = JSON.parse(message);
            if (data.reqid && this.callbacks.has(data.reqid)) {
                console.log(`[WS] Resolving reqid: ${data.reqid}, result: ${data.result}`);
                const { resolve, reject } = this.callbacks.get(data.reqid);
                this.callbacks.delete(data.reqid);
                if (data.result === 'fail') {
                    reject(new Error(`Request failed: ${JSON.stringify(data)}`));
                } else {
                    resolve(data);
                }
            }
        } catch (e) {
            this.logger.error('Error parsing message:', e);
        }
    }

    getSignature(dataStr, key) {
        // key is base64 encoded string, decode it first
        const keyBuffer = Buffer.from(key, 'base64');
        const hmac = crypto.createHmac('sha256', keyBuffer);
        hmac.update(dataStr, 'utf8');
        return hmac.digest('base64');
    }

    getSignatureReq(data, key) {
        const signReq = ['encrypted', 'util.getSI', 'util.crypto.getRSAPub'];
        const req = data.req;
        const jsonStr = JSON.stringify(data);
        if (!signReq.includes(req) && key) {
            const signature = this.getSignature(jsonStr, key);
            return signature + jsonStr;
        }
        return jsonStr;
    }

    // AES Decrypt (Native Node.js)
    aesDecrypt(ciphertext, key, iv) {
        // key and iv are buffers
        const cipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = cipher.update(ciphertext, 'base64');
        try {
            decrypted = Buffer.concat([decrypted, cipher.final()]);
        } catch (e) {
            console.error('AES Decrypt Final failed:', e.message);
            throw e;
        }
        return decrypted.toString('base64');
    }

    // Login Encrypt (Native Node.js - Aligned with fnos.js)
    loginEncrypt(dataStr) {
        // RSA Encrypt the AES Key
        const keyBuffer = Buffer.from(this.key, 'utf8');

        // Encrypt key with RSA Public Key
        // Ensure RSA key format is correct (PEM)
        let rsaKey = this.rsaPub;
        if (!rsaKey.includes('-----BEGIN PUBLIC KEY-----')) {
             rsaKey = `-----BEGIN PUBLIC KEY-----\n${rsaKey}\n-----END PUBLIC KEY-----`;
        }

        const rsaEncrypted = crypto.publicEncrypt({
            key: rsaKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, keyBuffer).toString('base64');

        // AES Encrypt the data
        const ivBuffer = this.iv;
        const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, ivBuffer);

        let aesEncrypted = cipher.update(dataStr, 'utf8', 'base64');
        aesEncrypted += cipher.final('base64');

        return {
            req: 'encrypted',
            // reqid is NOT included at top level in fnos.js
            iv: ivBuffer.toString('base64'),
            rsa: rsaEncrypted,
            aes: aesEncrypted
        };
    }

    async sendRequest(req, params = {}) {
        const reqid = this.getReqId();
        let data = { reqid, req, ...params };
        
        console.log(`[WS] Sending request: ${req} (reqid: ${reqid})`);

        if (req === 'user.login' || req === 'user.add') {
            if (!this.rsaPub) throw new Error('RSA Public Key not available');
            const dataStr = JSON.stringify(data);
            const encrypted = this.loginEncrypt(dataStr);
            data = encrypted;
        }

        const message = this.getSignatureReq(data, this.secret);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.callbacks.has(reqid)) {
                    this.callbacks.delete(reqid);
                    reject(new Error(`Request timeout for ${req} (reqid: ${reqid})`));
                }
            }, 10000); 

            this.callbacks.set(reqid, { 
                resolve: (res) => { clearTimeout(timeout); resolve(res); }, 
                reject: (err) => { clearTimeout(timeout); reject(err); } 
            });

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(message);
            } else {
                clearTimeout(timeout);
                reject(new Error('WebSocket not connected'));
            }
        });
    }

    async getRSAPub() {
        const res = await this.sendRequest('util.crypto.getRSAPub');
        if (res.result === 'succ' || res.result === 'success') {
            this.rsaPub = res.pub || (res.data && res.data.public_key);
            this.si = res.si || (res.data && res.data.si);
            console.log('[WS] Got RSA Pub:', this.rsaPub ? 'Yes' : 'No');
            return res;
        }
        throw new Error('Failed to get RSA Public Key: ' + JSON.stringify(res));
    }

    async login(username, password) {
        await this.getRSAPub();

        const params = {
            user: username,
            password: password, 
            deviceType: 'Browser', 
            deviceName: 'NodeJS Client',
            stay: true,
            si: this.si
        };

        const res = await this.sendRequest('user.login', params);
        if (res.result === 'succ') {
            this.token = res.token;
            try {
                const keyBuffer = Buffer.from(this.key, 'utf8');
                const decryptedSecret = this.aesDecrypt(res.secret, keyBuffer, this.iv);
                this.secret = decryptedSecret;
            } catch (e) {
                console.log('Decrypt secret failed, using raw:', e.message);
                this.secret = res.secret;
            }
            this.backId = res.backId || this.backId;
            return res;
        }
        throw new Error(`Login failed: ${JSON.stringify(res)}`);
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

// Helper: MD5 for signature (HTTP)
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

// Helper: SHA256 for signature (HTTP)
function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

function genSign(e, i) {
    const s = `trim_connect\`${e}\`${i}\`anna`;
    return sha256(s);
}

function genAuthX(url, method, paramsOrData) {
    const API_KEY = "zIGtkc3dqZnJpd29qZXJqa2w7c";
    const PREFIX = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";
    let o = '';
    if (method.toLowerCase() === 'get') {
        const keys = Object.keys(paramsOrData || {}).sort();
        if (keys.length > 0) {
            o = keys.map(k => encodeURIComponent(k) + "=" + encodeURIComponent(paramsOrData[k])).join("&");
        }
    } else {
        o = JSON.stringify(paramsOrData);
    }
    const c = (Math.floor(Math.random() * 900000) + 100000).toString();
    const d = Date.now();
    const g = [PREFIX, url, c, d, md5(o), API_KEY].join("_");
    const sign = md5(g);
    return `nonce=${c}&timestamp=${d}&sign=${sign}`;
}

async function fetchNasList(config) {
    const i = Date.now();
    const bodyData = { fnId: config.fnId };
    const fnSign = genSign(config.fnId, i);
    const authX = genAuthX('/api/v1/fn/con', 'post', bodyData);

    const response = await fetch('https://fnos.net/api/v1/fn/con', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'fn-sign': fnSign,
            'authx': authX
        },
        body: JSON.stringify(bodyData)
    });

    const responseData = await response.json();
    if (responseData.code === 0) {
        return responseData.data.fn[0].split(':')[0];
    }
    throw new Error('Failed to get NAS list');
}

export async function POST(request) {
    try {
        // Try to parse body, but if empty use defaults
        let body = {};
        try {
            body = await request.json();
        } catch (e) {
            // Body might be empty
        }

        const { username, password, port, fnId } = body;
        
        // Priority: Request Body > Environment Variables > Hardcoded Defaults
        const config = {
            fnId: fnId || process.env.FN_ID,
            username: username || process.env.FN_USERNAME,
            password: password || process.env.FN_PASSWORD,
            port: port || process.env.FN_PORT 
        };

        console.log('Connecting to NAS for port:', config.port);
        
        // 1. Get NAS Host
        const nasHost = await fetchNasList(config);
        
        // 2. Connect via WebSocket (Server-Side)
        const client = new FnOsClient(nasHost, {
            headers: {
                // Initial connection doesn't need entry-token
                'Cookie': 'mode=relay; language=zh;entry-token=9f531e22575646b5ab5ffa3254e14006', 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
                'Origin': 'https://' + nasHost,
                'Host': nasHost
            }
        });

        await client.connect();
        await client.login(config.username, config.password);
        
        const tokenRes = await client.sendRequest('appcgi.sac.entry.v1.exchangeEntryToken', {});
        const entryToken = tokenRes.data.token;
        
        const listRes = await client.sendRequest('appcgi.sac.entry.v1.dockerList', {all: true});
        console.log('Docker List:', JSON.stringify(listRes));
        const matched = listRes.data?.list?.find(c => Number(c?.uri?.port) === Number(config.port));
        client.close();

        if (matched?.uri?.fnDomain) {
            const targetUrl = `https://${matched.uri.fnDomain}.${nasHost}`;
            
            // Set Cookies for Middleware to use
            const cookieStore = cookies();
            cookieStore.set('nas_url', targetUrl, { httpOnly: true, secure: true, sameSite: 'lax' });
            cookieStore.set('nas_token', entryToken, { httpOnly: true, secure: true, sameSite: 'lax' });
            
            // Return success (no data needed, cookies are set)
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ success: false, error: 'App not found on port ' + config.port }, { status: 404 });

    } catch (error) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
