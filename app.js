const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const proxy = require('express-http-proxy');
const moment = require('moment');
const nocache = require('nocache');
const UUID = require('readableuuid').default;
const cookieParser = require('cookie-parser');
const store = require('./store');
const kube = require('./kube');
const { requestAccessToken, getUserInfo } = require('./github');

const POD_TIMEOUT = 60 * 1000 * 60;

const getIpFromHost = hostname => {
    const podSearch = /^(\d*)-(\d*)-(\d*)-(\d*)-(\d*)\./.exec(hostname);
    if (podSearch) {
        return [`${podSearch[1]}.${podSearch[2]}.${podSearch[3]}.${podSearch[4]}`, podSearch[5]];
    }
    const ipSearch = /^(\d*)-(\d*)-(\d*)-(\d*)\./.exec(hostname);
    if (!ipSearch) {
        return [null, null];
    }
    return [`${ipSearch[1]}.${ipSearch[2]}.${ipSearch[3]}.${ipSearch[4]}`, 8080];
}

const checkLogin = (req) => {
    const token = req.cookies.csh_token;
    const item = store.tokens[token];
    if (!item || item.createdAt < new Date() - 3600 * 1000 * 24 * 7) {
        return null;
    }
    return item.githubLogin;
}

const updatePodActive = (ip) => {
    const pod = store.pods[ip];
    if (!pod) {
        store.pods[ip] = {
            lastActive: new Date().getTime(),
        };
        pod = store.pods[ip];
    }
    pod.lastActive = new Date().getTime();
}

const clearOldPods = async () => {
    console.log('准备clearOldPods', store.pods);
    const pods = await kube.findRunningPods();
    for (const pod of pods) {
        const storePod = store.pods[pod.status.podIP];
        if (!storePod) {
            console.log(`${pod.status.podIP}没有记录，标记为刚运行`);
            updatePodActive(pod.status.podIP);
            continue;
        }
        if (storePod.lastActive < new Date().getTime() - POD_TIMEOUT) {
            console.log(`${pod.status.podIP}超时，正在关闭`);
            await kube.deletePod(pod.metadata.name);
        } else {
            console.log(`${pod.status.podIP}上次运行：${storePod.lastActive}`);
        }
    }
}

const app = express();
app.use(cookieParser())
app.use(nocache());
const wsProxy = createProxyMiddleware({
    target: '0.0.0.0',
    changeOrigin: true,
    ws: true,
    router: (req) => {
        const [ip, port] = getIpFromHost(req.headers['x-forwarded-host']);
        if (ip) {
            return `http://${ip}:${port}`;
        }
        return `http://127.0.0.1:3000`;
    }
});

app.get('/delete/:podName', async (req, res) => {
    if (!checkLogin(req)) {
        return res.redirect(process.env.HOME_URL || '/');
    }
    const pods = await kube.findRunningPods();
    const pod = pods.find(p => p.metadata.name === req.params.podName);
    if (!pod) {
        return res.status(404).end('not found');
    }
    await kube.safeDeletePod(pod.metadata.name);
    res.send('删除成功，<a href="/">返回</a>');
});

app.get('/', async (req, res) => {
    const username = checkLogin(req);
    if (!username) {
        return res.status(401).send(`<div><a href="https://github.com/login/oauth/authorize?client_id=${process.env.GH_CLIENT_ID}&scope=repo">GitHub登陆</a></div>`);
    }
    const [ip, port] = getIpFromHost(req.hostname);
    if (ip) {
        updatePodActive(ip);
        proxy(`http://${ip}:${port}`)(req, res);
        return;
    }
    const pods = (await kube.findRunningPods()).filter(pod => pod.spec.containers[0].env.find(e => e.name === 'GH_USER')?.value === username);
    res.status(200).send(`<div>欢迎：${username}</div>` + pods.map(pod => {
        const repo = pod.spec.containers[0].env.find(e => e.name === 'REPO').value;
        return `<div>
            <a href="/#${repo}">${repo}</a>，${pod.status.podIP}，创建于${moment(pod.status.startTime).format('YYYY-MM-DD HH:mm:ss')}
            <a href="/delete/${pod.metadata.name}">删除</a>
        </div>`
    }).join('') + `<script>
        if (location.hash) {
            const hash = location.hash.replace(/^#/, '').replace('https://github.com/', '');
            const search = /([^/]+)\\/([^/]+)$/.exec(hash);
            if (search) {
                const repo = search[1] + '/' + search[2];
                fetch(
                    '/workspaces?repo=' + encodeURIComponent(repo),
                    {
                        method: 'POST',
                    })
                .then(response => response.json())
                .then(data => {
                    if (data.url) {
                        document.querySelector('body').append('启动成功，正在跳转');
                        window.location.href = data.url;
                        setTimeout(() => window.location.reload(), 3000);
                    } else if (data.message) {
                        document.querySelector('body').append(data.message);
                        setTimeout(() => window.location.reload(), 1000);
                    } else if (data.logs) {
                        const pre = document.createElement('pre');
                        pre.innerText = data.logs;
                        document.querySelector('body').append(pre);
                        setTimeout(() => window.location.reload(), 1000);
                    }
                });
            }
        }
    </script>`);
})

app.post('/workspaces', async (req, res) => {
    const username = checkLogin(req);
    if (!username) {
        return res.redirect(process.env.HOME_URL || '/');
    }
    const repo = decodeURIComponent(req.query.repo);
    const pods = (await kube.findRunningPods()).filter(pod => pod.spec.containers[0].env.find(e => e.name === 'GH_USER')?.value === username);
    const pod = pods.find(pod => pod.spec.containers[0].env.find(e => e.name === 'REPO').value === repo);
    if (pod) {
        try {
            const logs = await kube.getPodLog(pod.metadata.name);
            if (/HTTP\sserver\slistening\son/.test(logs)) {
                res.json({ url: `https://${pod.status.podIP.replace(/\./g, '-')}.${req.hostname}` });
            } else {
                res.json({ logs: logs || '等待启动' });
            }
        } catch (e) {
            res.json({ message: `获取log失败:${e.message}` });
        }
    } else {
        const { body } = await kube.createPod(repo, username, req.cookies.csh_gh_token, process.env.V2RAY_CONFIG_MAP);
        const podName = body?.metadata?.name;
        res.json({ message: podName + '创建成功' });
    }
})

app.get('/oauth/github', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(401).end('invalid code');
    }
    try {
        const { access_token: accessToken } = await requestAccessToken(code);
        const githubUser = await getUserInfo(accessToken);
        const allowUsers = (process.env.ALLOW_GITHUB_LOGINS || '').split(',').filter(Boolean);
        if (allowUsers.length && !allowUsers.includes(githubUser.login)) {
            return res.status(403).end('forbidden');
        }
        const token = UUID();
        store.tokens[token] = { createdAt: new Date().getTime(), githubLogin: githubUser.login };
        res.statusCode = 302;
        res.setHeader('location', '/');
        res.cookie('csh_token', token, { domain: req.hostname, secure: true, path: '/' });
        res.cookie('csh_gh_token', accessToken, { domain: req.hostname, secure: true, path: '/' });
        res.end();
    } catch (e) {
        console.error(e);
        res.status(500).end('error');
    }
})

app.all('*', async (req, res) => {
    if (!checkLogin(req)) {
        return res.redirect(process.env.HOME_URL || '/');
    }
    const [ip, port] = getIpFromHost(req.hostname);
    if (ip) {
        updatePodActive(ip);
        proxy(`http://${ip}:${port}`)(req, res);
    } else {
        res.status(404).send('not found');
    }
});

const server = app.listen(3000, () => {
    console.log('CODE-HUB started at port 3000');
});

server.on('upgrade', wsProxy.upgrade);

setInterval(clearOldPods, 30 * 1000);
