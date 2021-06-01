const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
if (process.env.NODE_ENV === 'production') {
    kc.loadFromCluster();
} else {
    kc.loadFromDefault();
}

const IMAGE_URL = process.env.IMAGE_URL || 'wangsijie/code-server';
const HOME_URL = process.env.HOME_URL;

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

module.exports.findRunningPods = async () => {
    const res = await k8sApi.listNamespacedPod('default', undefined, undefined, undefined, undefined, 'app=code-server');
    return res.body.items;
}

module.exports.deletePod = async (name) => {
    return await k8sApi.deleteNamespacedPod(name, 'default');
}

module.exports.safeDeletePod = async (name) => {
    try {
        await module.exports.deletePod(name);
    } catch (e) {
        // noop
    }
}

module.exports.getPod = async (name) => {
    return await k8sApi.readNamespacedPod(name, 'default');
}

module.exports.createPod = async (repo, user = '', token = '', v2rayConfigMap) => {
    const pod = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
            name: `code-server-${Math.floor(Math.random() * 1000000)}`,
            labels: {
                app: 'code-server',
            },
        },
        spec: {
            containers: [
                {
                    name: 'runner',
                    image: IMAGE_URL,
                    ports: [
                        {
                            name: 'port',
                            containerPort: 3000,
                            protocol: 'TCP',
                        }
                    ],
                    env: [
                        {
                            name: 'REPO',
                            value: repo,
                        },
                        {
                            name: 'GH_USER',
                            value: user,
                        },
                        {
                            name: 'GH_TOKEN',
                            value: token,
                        },
                        {
                            name: 'TZ',
                            value: 'Asia/Shanghai',
                        },
                    ],
                    imagePullPolicy: 'Always',
                    command: [
                        '/bin/bash',
                        '-c',
                        [
                            'mkdir -p /workspace',
                            'source proxy.sh',
                            'cd /workspace',
                            `git config --global credential.helper '!f() { printf "%s\\n" "username=$GH_USER" "password=$GH_TOKEN"; };f'`,
                            'git clone https://github.com/${REPO} /workspace',
                            HOME_URL ? `code-server --home="${HOME_URL}" --auth="none" --bind-addr="0.0.0.0:8080" /workspace` : `code-server --auth="none" --bind-addr="0.0.0.0:8080" /workspace`,
                        ].join('\n'),
                    ],
                    securityContext: {
                        allowPrivilegeEscalation: true,
                    },
                    volumeMounts: [],
                    resources: {
                        requests: {
                            cpu: '1',
                            memory: '2Gi',
                        },
                        limits: {
                            cpu: '2',
                            memory: '4Gi',
                        },
                    }
                },
            ],
            volumes: [],
        },
    };
    if (v2rayConfigMap) {
        pod.spec.volumes.push({
            name: 'v2ray',
            configMap: {
                name: v2rayConfigMap,
            },
        });
        pod.spec.containers[0].volumeMounts.push({
            name: 'v2ray',
            mountPath: '/etc/v2ray'
        });
    }
    if (!process.env.DISABLE_DOCKER) {
        pod.spec.volumes.push({
            name: 'docker-sock',
            hostPath: {
                path: '/var/run/docker.sock'
            },
        });
        pod.spec.containers[0].volumeMounts.push({
            name: 'docker-sock',
            mountPath: '/var/run/docker.sock',
        });
    }
    if (process.env.ALIYUN_VK) {
        pod.spec.tolerations = [
            { key: 'virtual-kubelet.io/provider' },
            { operator: 'Exists' },
        ];
        pod.spec.nodeSelector = {
            type: 'virtual-kubelet',
        };
    }
    const res = await k8sApi.createNamespacedPod(
        'default',
        pod,
    );
    return res;
}

module.exports.getPodLog = async (podName) => {
    const res = await k8sApi.readNamespacedPodLog(podName, 'default');
    return res.body;
}

if (typeof require !== 'undefined' && require.main === module) {
    (async function() {
        const res = await module.exports.getPodLog('code-server-894242');
        console.log(res);
    })()
}