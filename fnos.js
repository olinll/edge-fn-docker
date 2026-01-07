const WebSocket = require('ws');
const crypto = require('crypto');

class FnOsClient {
    constructor(url, options = {}) {
        this.url = url;
        this.ws = null;
        this.reqIdIndex = 1; // Start index
        this.callbacks = new Map(); // reqid -> {resolve, reject}
        this.backId = '0000000000000000';

        // Encryption keys
        this.key = this.generateRandomString(32);
        this.iv = crypto.randomBytes(16);
        this.rsaPub = null;
        this.si = null;

        // Session info
        this.token = null;
        this.secret = null;
        this.uid = null;
        this.isAdmin = null;

        // Options
        this.logger = options.logger || console;
        this.headers = options.headers || {};

        // Auto set Origin if not provided
        if (!this.headers['Origin'] && !this.headers['origin']) {
            try {
                const u = new URL(url);
                this.headers['Origin'] = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
            } catch (e) {
                // ignore invalid url
            }
        }
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

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, {
                headers: this.headers,
                rejectUnauthorized: false // Allow self-signed certs
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
            // The message might be just JSON, or it might be prefixed with something?
            // Python: data = json.loads(message)
            // It seems the response is just JSON.
            const data = JSON.parse(message);
            // this.logger.log('Received:', data);

            if (data.reqid && this.callbacks.has(data.reqid)) {
                const {resolve, reject} = this.callbacks.get(data.reqid);
                this.callbacks.delete(data.reqid);

                if (data.result === 'fail') {
                    // Python: {"errno":131072,"result":"fail","reqid":"..."}
                    // If errno is present, it's an error.
                    reject(new Error(`Request failed: ${JSON.stringify(data)}`));
                } else {
                    resolve(data);
                }
            }
        } catch (e) {
            this.logger.error('Error parsing message:', e);
        }
    }

    /**
     * Generate signature for the request.
     * Corresponds to `get_signature` in encryption.py
     */
    getSignature(dataStr, key) {
        // 签名步骤说明
        // 1、将请求体（字典）转换为 JSON 字符串，无空格、无换行； (Caller does this)
        // 2、使用 AES 解密后的密钥对 JSON 字符串进行 HMAC-SHA256 计算； (Caller passes secret which is already the key string?)
        //    Wait, user says "密钥由登录接口返回的secretAES解密后得到".
        //    In Python code provided earlier: self.secret = res.secret
        //    And get_signature uses `key_bytes = base64.b64decode(key)`
        //    So `key` passed here should be the base64 string `self.secret`.
        // 3、将计算结果再进行 Base64 编码，得到最终签名字符串；

        // key is base64 encoded string, decode it first
        const keyBuffer = Buffer.from(key, 'base64');
        const hmac = crypto.createHmac('sha256', keyBuffer);
        hmac.update(dataStr, 'utf8');
        return hmac.digest('base64');
    }

    /**
     * Prepare the request message, potentially adding signature.
     * Corresponds to `get_signature_req` in encryption.py
     */
    getSignatureReq(data, key) {
        const signReq = [
            'encrypted',
            'util.getSI',
            'util.crypto.getRSAPub',
        ];

        const req = data.req;
        // Ensure no spaces in JSON
        // 1、将请求体（字典）转换为 JSON 字符串，无空格、无换行；
        const jsonStr = JSON.stringify(data);

        if (!signReq.includes(req) && key) {
            const signature = this.getSignature(jsonStr, key);
            // 4、在请求数据前拼接签名字符串后再发送。
            // {sign}{json}
            return signature + jsonStr;
        }
        return jsonStr;
    }

    async sendRequest(req, params = {}) {
        const reqid = this.getReqId();
        // Match user's order: reqid first
        let data = {reqid, req, ...params};

        // Handle Login Encryption
        if (req === 'user.login' || req === 'user.add') {
            if (!this.rsaPub) {
                throw new Error('RSA Public Key not available. Call getRSAPub first.');
            }

            // Encryption
            // Python: data = json.dumps(data, separators=(',', ':'))
            // Python: data = login_encrypt(data, self.pub, self.key, self.iv)
            const dataStr = JSON.stringify(data);
            const encrypted = this.loginEncrypt(dataStr);

            // The encrypted payload replaces the original data dictionary
            data = encrypted;
            // Note: 'req' inside encrypted is 'encrypted', so getSignatureReq will see 'encrypted'
            // and skip signature (which is correct as per python code).
        }

        // IMPORTANT: The Python client updates the reqid in `send_request` using `get_reqid(self.backId)`.
        // But if we are strictly incrementing, we might not need to re-generate reqid if we already generated it.
        // However, if we just logged in, we might receive a backId.
        // The user says "reqid is auto-incrementing, every request needs to be +1 based on the last response".
        // If the login response updates backId, and we are strictly incrementing, using backId would cause a jump.
        // So we stick to `this.lastReqId += 1n`.

        // Generate Signature
        // In Python: message = get_signature_req(data, self.sign_key)

        // Debugging: Log the data being signed and the key
        // console.log('Signing data:', JSON.stringify(data));
        // console.log('Using secret:', this.secret);
        console.log('发送', data)
        const message = this.getSignatureReq(data, this.secret);

        return new Promise((resolve, reject) => {
            this.callbacks.set(reqid, {resolve, reject});

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(message);
            } else {
                reject(new Error('WebSocket not connected'));
            }
        });
    }

    // AES Decrypt
    aesDecrypt(ciphertext, key, iv) {
        // key and iv are buffers
        const cipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = cipher.update(ciphertext, 'base64');
        try {
            decrypted = Buffer.concat([decrypted, cipher.final()]);
        } catch (e) {
            console.error('AES Decrypt Final failed:', e.message);
            // Maybe padding error?
            throw e;
        }
        return decrypted.toString('base64');
    }

    loginEncrypt(dataStr) {
        // RSA Encrypt the AES Key
        const keyBuffer = Buffer.from(this.key, 'utf8');

        // Encrypt key with RSA Public Key
        const rsaEncrypted = crypto.publicEncrypt({
            key: this.rsaPub,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, keyBuffer).toString('base64');

        // AES Encrypt the data
        const ivBuffer = this.iv;
        const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, ivBuffer);

        let aesEncrypted = cipher.update(dataStr, 'utf8', 'base64');
        aesEncrypted += cipher.final('base64');

        return {
            req: 'encrypted',
            iv: ivBuffer.toString('base64'),
            rsa: rsaEncrypted,
            aes: aesEncrypted
        };
    }

    async getRSAPub() {
        const res = await this.sendRequest('util.crypto.getRSAPub');
        if (res.result === 'succ') {
            this.rsaPub = res.pub;
            this.si = res.si;
            return res;
        } else {
            throw new Error('Failed to get RSA Public Key');
        }
    }

    async login(username, password, deviceType = 'Browser', deviceName = 'NodeJS Client', stay = false) {
        // Ensure we have RSA key
        if (!this.rsaPub) {
            await this.getRSAPub();
        }

        const params = {
            user: username,
            password: password,
            deviceType,
            deviceName,
            stay,
            si: this.si
        };

        const res = await this.sendRequest('user.login', params);

        if (res.result === 'succ') {
            this.token = res.token;
            // "密钥由登录接口返回的secretAES解密后得到"
            // Python code didn't show decryption of secret, but the user instructions say so.
            // Python code: self.secret = None ... self.secret = response['secret'] (in MainClient.login?)
            // Wait, the python snippet provided in FnOsClient.md showed: "secret": "bWH/dMzpTM2c498hzpW5FXic9ap5wPHhFiMqXnFBqs4=", // 后面签名密钥
            // And encryption.py `get_signature` takes `key: str` and does `base64.b64decode(key)`.
            // So `res.secret` IS the base64 encoded key.
            // But user says: "密钥由登录接口返回的secretAES解密后得到".
            // If the server returns an AES encrypted secret, we must decrypt it first.
            // Let's try to decrypt `res.secret` using the session key/iv we generated?

            try {
                // Try decrypting the secret
                // The secret in response is Base64.
                // We use this.key (string) and this.iv (buffer) used in loginEncrypt?
                // Note: encryption.py `aes_encrypt` uses `key.encode()` (utf8).

                const keyBuffer = Buffer.from(this.key, 'utf8');
                // this.iv is buffer

                // However, look at the secret format in log: "CDsiyX+mm5WvmL7eKcB9mKW2HPQ6li5g9bto5FT4OOs=" (44 chars)
                // Base64 of 32 bytes is 44 chars.
                // AES-256 block size is 16 bytes. 32 bytes is 2 blocks.
                // If it was encrypted, it would be padded?
                // If `secret` IS the key itself (32 bytes random), then it matches the length.
                // If it is AES encrypted, it might be longer or same if raw?

                // User instruction: "密钥由登录接口返回的secretAES解密后得到"
                // This implies `res.secret` is a ciphertext.
                // Let's try to decrypt it.
                const decryptedSecret = this.aesDecrypt(res.secret, keyBuffer, this.iv);
                // console.log('Decrypted secret:', decryptedSecret);
                // The result should be the signing key (likely 32 chars string or base64?)
                // If the decryption works, we use it.
                this.secret = decryptedSecret;
            } catch (e) {
                console.log('Failed to decrypt secret, using raw:', e.message);
                this.secret = res.secret;
            }

            this.uid = res.uid;
            this.isAdmin = res.admin;
            this.backId = res.backId || this.backId; // Update backId if provided
            return res;
        } else {
            throw new Error(`Login failed: ${JSON.stringify(res)}`);
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

// Example Usage
if (require.main === module) {
    (async () => {
        // Replace with your actual IP
        // const url = 'ws://10.0.0.11:5666/websocket?type=main';
        const url = 'wss://lin288.5ddd.com/websocket?type=main';

        const client = new FnOsClient(url, {
            headers: {
                'Origin': 'https://lin288.5ddd.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
                'Cookie': 'mode=relay; language=zh; entry-token=f503fd0fbeaa49e5badc89daad133950',
                'Host': 'lin288.5ddd.com'
            },
            // rejectUnauthorized: false // Might be needed if cert is self-signed, but usually Let's Encrypt is fine
        });

        try {
            await client.connect();
            console.log('Connected!');

            // Login
            const loginRes = await client.login('jianglin', 'Lin203428');
            console.log('Login success:', loginRes);

            const token = await client.sendRequest('appcgi.sac.entry.v1.exchangeEntryToken', {});
            // console.log('toekn：'+JSON.stringify(toekn, null, 2));
            const entryToken = token.data.token;
            console.log('entry-token=' + entryToken);
            // Do something else...
            // Try dockerList (sac entry)
            try {
                console.log('Requesting dockerList (sac entry)...');
                const containerList = await client.sendRequest('appcgi.sac.entry.v1.dockerList', {all: true});
                // console.log('Docker List:', JSON.stringify(containerList, null, 2));
                if (containerList.result === 'succ' && Array.isArray(containerList.data.list)) {
                    console.log('\nApp List:');
                    console.log('---------------------------------------------------------------------------------------------------');
                    console.log('| App Name           | Port  | fnDomain           | URL');
                    console.log('---------------------------------------------------------------------------------------------------');

                    containerList.data.list.forEach(c => {
                        // console.log(c);
                        // Adjust fields based on sac.entry.v1 response structure
                        // Usually it wraps the container info or provides simplified info
                        // If it is the same as containerList, this works. If different, we might need adjustment.
                        // Assuming c has similar fields or is the container object.

                        const appName = c.title || 'Unknown';
                        const fnDomain = c.uri.fnDomain || 'N/A';

                        let port = c.uri.port || 'N/A';


                        let url = 'N/A';
                        if (fnDomain !== 'N/A') {
                            url = `https://${fnDomain}.lin288.5ddd.com`;
                        }

                        console.log(`| ${appName.padEnd(18)} | ${String(port).padEnd(5)} | ${fnDomain.padEnd(18)} | ${url}`);
                    });
                    console.log('---------------------------------------------------------------------------------------------------');
                } else {
                    console.log('dockerList failed or invalid response:', JSON.stringify(containerList));
                }

            } catch (e) {
                console.log('dockerList failed:', e.message);
            }

        } catch (err) {
            console.error('Error:', err);
        } finally {
            client.close();
        }
    })();
}

module.exports = FnOsClient;
