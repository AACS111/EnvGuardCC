#!/usr/bin/env bash
# 一键安装 VLESS-Reality(TCP) + Hysteria2(UDP/QUIC)。
# 适用: Debian 11+/Ubuntu 22.04+ (KVM)，每次运行随机生成全部凭据。
# 用法: sudo bash install-node.sh（在自己的 Debian/Ubuntu 服务器运行）
# 可选环境变量:
#   SNI=www.nvidia.com   伪装域名（需支持 TLS1.3 + HTTP/2）
#   TCP_PORT=443         Reality 端口
#   UDP_PORT=443         Hysteria2 端口
#   XRAY_VERSION=1.8.26  Xray 版本（1.8.24 有 QUIC sniff 越界 panic；26.x 与 mihomo 1.19 的 REALITY 不兼容）
set -euo pipefail

SNI="${SNI:-www.nvidia.com}"
TCP_PORT="${TCP_PORT:-443}"
UDP_PORT="${UDP_PORT:-443}"
XRAY_VERSION="${XRAY_VERSION:-1.8.26}"

info(){ printf '\033[32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[!]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# 先检测再开启 BBR；内核不支持/容器环境只提示，不阻断部署。
setup_bbr(){
  local current available qdisc virt
  current=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)
  available=$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || true)
  qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || true)
  virt=$(systemd-detect-virt 2>/dev/null || echo unknown)

  if [ "$current" = "bbr" ]; then
    info "BBR 已开启（qdisc=${qdisc:-未知}），无需处理"
    return 0
  fi
  if [ "$virt" = "openvz" ] || [ "$virt" = "lxc" ] || [ "$virt" = "lxc-libvirt" ]; then
    warn "检测到 ${virt}（共享宿主内核），BBR 需由服务商开启，跳过"
    return 0
  fi
  if ! printf '%s' "$available" | grep -qw bbr; then
    # Debian/Ubuntu 常把 BBR 编成模块，未加载时 available 里看不到。
    modprobe tcp_bbr >/dev/null 2>&1 || true
    available=$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || true)
  fi
  if ! printf '%s' "$available" | grep -qw bbr; then
    warn "当前内核不支持 BBR（可用算法：${available:-未知}），跳过"
    warn "Debian 可试：apt update && apt install -y linux-image-amd64 && reboot"
    warn "Ubuntu 可试：apt update && apt install -y linux-image-generic && reboot"
    warn "换内核有起不来的风险，重启前确认服务商控制台/VNC 可用"
    return 0
  fi

  info "开启 BBR（当前算法：${current:-未知}）"
  if [ ! -f /etc/modules-load.d/bbr.conf ]; then echo "tcp_bbr" > /etc/modules-load.d/bbr.conf; fi
  sysctl -w net.core.default_qdisc=fq >/dev/null 2>&1 || true
  if ! sysctl -w net.ipv4.tcp_congestion_control=bbr >/dev/null 2>&1; then
    warn "开启 BBR 失败，跳过（不影响节点部署）"
    return 0
  fi
  if ! grep -qs "tcp_congestion_control=bbr" /etc/sysctl.d/99-bbr.conf 2>/dev/null; then
    {
      echo "net.core.default_qdisc=fq"
      echo "net.ipv4.tcp_congestion_control=bbr"
    } >> /etc/sysctl.d/99-bbr.conf
  fi
  if [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" = "bbr" ]; then
    info "BBR 已开启并写入 /etc/sysctl.d/99-bbr.conf"
  else
    warn "BBR 未生效，请手动检查 sysctl"
  fi
}

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"
command -v apt-get >/dev/null 2>&1 || die "仅支持 Debian/Ubuntu"
command -v systemctl >/dev/null 2>&1 || die "需要 systemd"

info "安装依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip openssl ca-certificates >/dev/null

setup_bbr

for port in "$TCP_PORT" "$UDP_PORT"; do
  holder=$(ss -lntup 2>/dev/null | grep -m 1 -E "[:.]${port}[[:space:]]" || true)
  if [ -z "$holder" ]; then continue; fi
  if printf '%s' "$holder" | grep -qE 'xray|sing-box'; then
    warn "端口 ${port} 由本脚本安装的服务占用，将重启覆盖"
  else
    die "端口 ${port} 被其他进程占用，请先处理：${holder}"
  fi
done
if [ -f /usr/local/etc/xray/config.json ]; then
  warn "检测到已有 xray 配置，将备份后覆盖（凭据会更新）"
fi
if [ -f /etc/sing-box/config.json ]; then
  warn "检测到已有 sing-box 配置，将备份后覆盖（凭据会更新）"
fi

if ! command -v xray >/dev/null 2>&1; then
  info "安装 Xray ${XRAY_VERSION}"
  if ! bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install --version "${XRAY_VERSION}" >/dev/null 2>&1; then
    die "Xray ${XRAY_VERSION} 安装失败；请检查网络后重试，勿回退到 26.x（与 mihomo 1.19 REALITY 不兼容）"
  fi
fi
if ! command -v sing-box >/dev/null 2>&1; then
  info "安装 sing-box"
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://sing-box.app/install.sh -o "$installer"
  bash "$installer" >/dev/null
fi

info "生成随机凭据"
UUID=$(xray uuid)
KEYS=$(xray x25519)
PRIV=$(printf '%s\n' "$KEYS" | sed -nE 's/^(Private[[:space:]]*[Kk]ey|PrivateKey):[[:space:]]*//p' | head -1)
PUB=$(printf '%s\n' "$KEYS" | sed -nE 's/^(Public[[:space:]]*[Kk]ey|Password):[[:space:]]*//p' | head -1)
[ -n "$PRIV" ] && [ -n "$PUB" ] || die "无法解析 xray x25519 输出"
SHORT_ID=$(openssl rand -hex 8)
HY2_PASS=$(openssl rand -base64 16 | tr -d '\n')
SERVER_IP=$(curl -fsSL --max-time 8 https://api.ipify.org 2>/dev/null || true)
[ -n "$SERVER_IP" ] || SERVER_IP=$(hostname -I | awk '{print $1}')
[ -n "$SERVER_IP" ] || die "无法获取服务器公网 IP"

info "写入 Xray 配置（Reality ${TCP_PORT}/tcp，SNI=${SNI}）"
mkdir -p /usr/local/etc/xray
if [ -f /usr/local/etc/xray/config.json ]; then cp /usr/local/etc/xray/config.json "/usr/local/etc/xray/config.json.bak.$(date +%s)"; fi
cat > /usr/local/etc/xray/config.json <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "listen": "0.0.0.0",
    "port": ${TCP_PORT},
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "${UUID}", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "show": false,
        "dest": "${SNI}:443",
        "xver": 0,
        "serverNames": ["${SNI}"],
        "privateKey": "${PRIV}",
        "shortIds": ["${SHORT_ID}"]
      }
    },
    "sniffing": { "enabled": false }
  }],
  "outbounds": [{ "protocol": "freedom", "tag": "direct" }]
}
EOF

info "写入 sing-box 配置（Hysteria2 ${UDP_PORT}/udp）"
mkdir -p /etc/sing-box/cert
openssl ecparam -genkey -name prime256v1 -out /etc/sing-box/cert/key.pem 2>/dev/null
openssl req -new -x509 -days 3650 -key /etc/sing-box/cert/key.pem -out /etc/sing-box/cert/cert.pem -subj "/CN=${SNI}" 2>/dev/null
if [ -f /etc/sing-box/config.json ]; then cp /etc/sing-box/config.json "/etc/sing-box/config.json.bak.$(date +%s)"; fi
cat > /etc/sing-box/config.json <<EOF
{
  "log": { "level": "warn" },
  "inbounds": [{
    "type": "hysteria2",
    "tag": "hy2",
    "listen": "0.0.0.0",
    "listen_port": ${UDP_PORT},
    "users": [{ "password": "${HY2_PASS}" }],
    "masquerade": "https://${SNI}",
    "tls": {
      "enabled": true,
      "server_name": "${SNI}",
      "alpn": ["h3"],
      "certificate_path": "/etc/sing-box/cert/cert.pem",
      "key_path": "/etc/sing-box/cert/key.pem"
    }
  }],
  "outbounds": [{ "type": "direct" }]
}
EOF

info "启动服务"
systemctl enable xray >/dev/null 2>&1
systemctl restart xray
systemctl enable sing-box >/dev/null 2>&1
systemctl restart sing-box
sleep 1
systemctl is-active --quiet xray || die "xray 启动失败：journalctl -u xray -n 30"
systemctl is-active --quiet sing-box || die "sing-box 启动失败：journalctl -u sing-box -n 30"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${TCP_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow "${UDP_PORT}/udp" >/dev/null 2>&1 || true
  info "已放行 ufw：${TCP_PORT}/tcp、${UDP_PORT}/udp"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# mktemp 创建仅当前管理员可读写的文件，配置含连接凭据。
CLIENT_FILE=$(mktemp "${SCRIPT_DIR}/node-XXXXXXXX.yaml")
cat > "${CLIENT_FILE}" <<EOF
proxies:
  - name: TCP-Reality
    type: vless
    server: ${SERVER_IP}
    port: ${TCP_PORT}
    uuid: ${UUID}
    network: tcp
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: ${SNI}
    client-fingerprint: chrome
    reality-opts:
      public-key: ${PUB}
      short-id: ${SHORT_ID}
  - name: UDP-Hysteria2
    type: hysteria2
    server: ${SERVER_IP}
    port: ${UDP_PORT}
    password: "${HY2_PASS}"
    sni: ${SNI}
    skip-cert-verify: true
    udp: true
    up: "20 Mbps"
    down: "50 Mbps"
proxy-groups:
  - name: Overseas
    type: select
    proxies:
      - TCP-Reality
      - UDP-Hysteria2
rules:
  - DOMAIN-SUFFIX,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,Overseas
EOF


echo
info "安装完成"
echo "  服务器    : ${SERVER_IP}"
echo "  Reality   : ${TCP_PORT}/tcp  SNI=${SNI}"
echo "  Hysteria2 : ${UDP_PORT}/udp"
echo "  客户端配置: ${CLIENT_FILE}"
echo
warn "云厂商安全组也要放行 ${TCP_PORT}/tcp 与 ${UDP_PORT}/udp"
warn "把 ${CLIENT_FILE} 的内容导入 FlClash / EnvGuardCC 即可"
