/**
 * 阿里云 ECS OpenAPI 客户端（RPC 签名 v1.0），用于查/改安全组规则。
 * 凭据取自 ~/.workbench/config.json 的当前 profile（不打印任何密钥）。
 *
 * 用法（实例 ID 与地域通过环境变量给出，不写死在仓库里）：
 *   ECS_INSTANCE_ID=i-xxxxxxxx node deploy/aliyun-sg.mjs show
 *   ECS_INSTANCE_ID=i-xxxxxxxx node deploy/aliyun-sg.mjs open 80
 *   ECS_REGION=cn-hangzhou 可覆盖地域（默认 cn-hangzhou）
 */
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INSTANCE_ID = process.env.ECS_INSTANCE_ID ?? '';
const REGION = process.env.ECS_REGION ?? 'cn-hangzhou';
const ENDPOINT = `https://ecs.${REGION}.aliyuncs.com/`;

if (!INSTANCE_ID) {
  console.error('缺少实例 ID：请设置环境变量 ECS_INSTANCE_ID（例如 ECS_INSTANCE_ID=i-xxxxxxxx）');
  process.exit(2);
}

const cfgPath = join(homedir(), '.workbench', 'config.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
const prof = cfg.profiles[cfg.current];
if (!prof?.access_key_id || !prof?.access_key_secret) {
  console.error('workbench config 里没有可用的 AK 凭据');
  process.exit(1);
}
const AK = prof.access_key_id;
const SK = prof.access_key_secret;

const enc = (s) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function sign(params) {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const stringToSign = `GET&${enc('/')}&${enc(canonical)}`;
  const signature = createHmac('sha1', `${SK}&`).update(stringToSign).digest('base64');
  return `${ENDPOINT}?${canonical}&Signature=${enc(signature)}`;
}

async function call(action, extra = {}) {
  const params = {
    Action: action,
    Version: '2014-05-26',
    Format: 'JSON',
    AccessKeyId: AK,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: REGION,
    ...extra,
  };
  const res = await fetch(sign(params), { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.Code) {
    throw new Error(`${action} 失败: HTTP ${res.status} ${body.Code ?? ''} ${body.Message ?? ''}`);
  }
  return body;
}

async function securityGroups() {
  const inst = await call('DescribeInstances', { 'InstanceIds.1': INSTANCE_ID });
  const item = inst?.Instances?.Instance?.[0];
  if (!item) throw new Error('没查到实例');
  return {
    name: item.InstanceName,
    status: item.Status,
    eip: item.EipAddress?.IpAddress ?? item.PublicIpAddress?.IpAddress?.[0] ?? '',
    sgs: item.SecurityGroupIds?.SecurityGroupId ?? [],
  };
}

const mode = process.argv[2] ?? 'show';

if (mode === 'show') {
  const info = await securityGroups();
  console.log(`实例 ${INSTANCE_ID} (${info.name}) 状态 ${info.status} 公网 ${info.eip}`);
  console.log(`安全组: ${info.sgs.join(', ') || '（无）'}`);
  for (const sg of info.sgs) {
    const attr = await call('DescribeSecurityGroupAttribute', { SecurityGroupId: sg, Direction: 'ingress' });
    const perms = attr?.Permissions?.Permission ?? [];
    console.log(`\n[${sg}] ${attr.Description ?? ''} 入方向规则 ${perms.length} 条：`);
    for (const p of perms) {
      console.log(
        `  ${String(p.IpProtocol).padEnd(5)} ${String(p.PortRange).padEnd(12)} ${String(p.SourceCidrIp || p.Ipv6SourceCidrIp || '').padEnd(18)} ${p.Policy} ${p.Description ?? ''}`,
      );
    }
  }
} else if (mode === 'open') {
  const port = Number(process.argv[3] ?? 80);
  const info = await securityGroups();
  const sg = info.sgs[0];
  if (!sg) throw new Error('实例没有安全组');
  const attr = await call('DescribeSecurityGroupAttribute', { SecurityGroupId: sg, Direction: 'ingress' });
  const perms = attr?.Permissions?.Permission ?? [];
  const already = perms.some((p) => {
    const [lo, hi] = String(p.PortRange).split('/').map(Number);
    return String(p.IpProtocol).toLowerCase() === 'tcp' && lo <= port && (hi ?? lo) >= port && /0\.0\.0\.0\/0/.test(String(p.SourceCidrIp));
  });
  if (already) {
    console.log(`${sg} 已经放通 tcp/${port}，不用改`);
  } else {
    await call('AuthorizeSecurityGroup', {
      SecurityGroupId: sg,
      IpProtocol: 'tcp',
      PortRange: `${port}/${port}`,
      SourceCidrIp: '0.0.0.0/0',
      Priority: '1',
      Description: `excavator web tcp/${port}`,
    });
    console.log(`${sg} 已放通 tcp/${port}（0.0.0.0/0）`);
  }
  const after = await call('DescribeSecurityGroupAttribute', { SecurityGroupId: sg, Direction: 'ingress' });
  for (const p of after?.Permissions?.Permission ?? []) {
    if (String(p.IpProtocol).toLowerCase() === 'tcp' && /0\.0\.0\.0\/0/.test(String(p.SourceCidrIp))) {
      console.log(`  tcp ${p.PortRange} <- ${p.SourceCidrIp}  ${p.Description ?? ''}`);
    }
  }
} else {
  console.error('用法: node aliyun-sg.mjs show | open <port>');
  process.exit(2);
}
