#!/usr/bin/env bash
# 一键安装 VLESS-Reality(TCP) + Hysteria2(UDP/QUIC)。
# 适用: Debian 11+/Ubuntu 22.04+ (KVM)，每次运行随机生成全部凭据。
# 用法:
#   sudo bash install-node.sh
#   sudo bash install-node.sh -p 8443                         # 同时自定义 TCP/UDP 端口（适合禁 443 的家宽/ISP 机）
#   sudo bash install-node.sh --tcp-port 8443 --udp-port 9443 # 分别自定义 TCP 与 UDP 端口
#   sudo bash install-node.sh -p 8443 --sub-port 18080        # 自定义 HTTP 订阅下载端口
#   sudo bash install-node.sh -p 8443 --no-sub                # 不启用 nginx 订阅链接，仅生成本地 YAML
#   bash install-node.sh --help                               # 查看全部参数
# 也兼容环境变量: SNI / TCP_PORT / UDP_PORT / SUB_PORT / ENABLE_SUB / SERVER_IP / XRAY_VERSION（命令行参数优先）
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"

SNI="${SNI:-www.nvidia.com}"
TCP_PORT="${TCP_PORT:-443}"
UDP_PORT="${UDP_PORT:-443}"
SUB_PORT="${SUB_PORT:-18080}"
ENABLE_SUB="${ENABLE_SUB:-1}"
SERVER_IP="${SERVER_IP:-}"
XRAY_VERSION="${XRAY_VERSION:-25.12.8}"

info(){ printf '\033[32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[!]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage(){
  cat <<'USAGE'
用法: sudo bash install-node.sh [选项]

选项:
  -p, --port <端口>          同时设置 Reality(TCP) 与 Hysteria2(UDP) 端口（默认 443）
      --tcp-port <端口>      单独指定 Reality(TCP) 端口（覆盖 -p）
      --udp-port <端口>      单独指定 Hysteria2(UDP) 端口（覆盖 -p）
      --sub-port <端口>      nginx 订阅链接端口（默认 18080，方便直接导入订阅）
      --no-sub               不安装/不启用 nginx 订阅下载链接，仅输出本地 YAML
      --sni <域名>           伪装域名（默认 www.nvidia.com，需支持 TLS1.3 + HTTP/2）
      --ip <IP或域名>        手动指定服务器公网 IP 或域名（默认自动探测 IPv4）
      --xray-version <版本>  指定 Xray 版本（默认 25.12.8）
  -h, --help                 显示此帮助信息

示例:
  sudo bash install-node.sh                             # 默认 443/tcp + 443/udp + 18080 订阅链接
  sudo bash install-node.sh -p 8443                     # 自定义同端口（适合禁 443 的家宽/ISP 机）
  sudo bash install-node.sh --tcp-port 8443 --udp-port 9443 --sub-port 20880
  sudo bash install-node.sh -p 8443 --no-sub            # 仅生成本地 YAML，不开 HTTP 端口

环境变量兼容: SNI / TCP_PORT / UDP_PORT / SUB_PORT / ENABLE_SUB / SERVER_IP / XRAY_VERSION（命令行参数优先）
USAGE
}

require_arg(){
  [ $# -ge 2 ] && [ -n "$2" ] || die "选项 $1 缺少参数值（使用 --help 查看用法）"
}

CLI_PORT=""
CLI_TCP_PORT=""
CLI_UDP_PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      require_arg "$@"
      CLI_PORT="$2"
      shift 2
      ;;
    --port=*)
      CLI_PORT="${1#*=}"
      [ -n "$CLI_PORT" ] || die "选项 --port 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    --tcp-port)
      require_arg "$@"
      CLI_TCP_PORT="$2"
      shift 2
      ;;
    --tcp-port=*)
      CLI_TCP_PORT="${1#*=}"
      [ -n "$CLI_TCP_PORT" ] || die "选项 --tcp-port 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    --udp-port)
      require_arg "$@"
      CLI_UDP_PORT="$2"
      shift 2
      ;;
    --udp-port=*)
      CLI_UDP_PORT="${1#*=}"
      [ -n "$CLI_UDP_PORT" ] || die "选项 --udp-port 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    --sub-port)
      require_arg "$@"
      SUB_PORT="$2"
      ENABLE_SUB="1"
      shift 2
      ;;
    --sub-port=*)
      SUB_PORT="${1#*=}"
      [ -n "$SUB_PORT" ] || die "选项 --sub-port 缺少参数值（使用 --help 查看用法）"
      ENABLE_SUB="1"
      shift
      ;;
    --no-sub)
      ENABLE_SUB="0"
      shift
      ;;
    --sni)
      require_arg "$@"
      SNI="$2"
      shift 2
      ;;
    --sni=*)
      SNI="${1#*=}"
      [ -n "$SNI" ] || die "选项 --sni 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    --ip)
      require_arg "$@"
      SERVER_IP="$2"
      shift 2
      ;;
    --ip=*)
      SERVER_IP="${1#*=}"
      [ -n "$SERVER_IP" ] || die "选项 --ip 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    --xray-version)
      require_arg "$@"
      XRAY_VERSION="$2"
      shift 2
      ;;
    --xray-version=*)
      XRAY_VERSION="${1#*=}"
      [ -n "$XRAY_VERSION" ] || die "选项 --xray-version 缺少参数值（使用 --help 查看用法）"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（自定义端口请用 -p 8443 或 --tcp-port / --udp-port，查看完整用法：bash install-node.sh --help）"
      ;;
  esac
done

if [ -n "$CLI_PORT" ]; then
  TCP_PORT="$CLI_PORT"
  UDP_PORT="$CLI_PORT"
fi
if [ -n "$CLI_TCP_PORT" ]; then
  TCP_PORT="$CLI_TCP_PORT"
fi
if [ -n "$CLI_UDP_PORT" ]; then
  UDP_PORT="$CLI_UDP_PORT"
fi
XRAY_VER="${XRAY_VERSION#v}"

validate_port(){
  local label="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ] \
    || die "${label} 端口无效（需 1-65535）：${value}"
}

validate_sni(){
  [[ "$1" =~ ^[A-Za-z0-9.-]+$ ]] && [[ "$1" == *.* ]] \
    || die "SNI 域名格式无效：${1}"
}

curl_fetch(){
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 "$@"
}

print_log_tail(){
  local file="$1"
  if [ -s "$file" ]; then
    warn "失败日志尾部："
    tail -n 20 "$file" >&2 || true
  fi
}

# 先检测再开启 BBR，并调大 QUIC/UDP 缓冲区；内核不支持/容器环境只提示，不阻断部署。
setup_network_tuning(){
  local current available qdisc virt
  current=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)
  available=$(sysctl -n net.ipv4.tcp_available_congestion_control 2>/dev/null || true)
  qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || true)
  virt=$(systemd-detect-virt 2>/dev/null || echo unknown)

  if [ "$virt" = "openvz" ] || [ "$virt" = "lxc" ] || [ "$virt" = "lxc-libvirt" ]; then
    warn "检测到 ${virt}（共享宿主内核），BBR 与内核网络参数需由服务商开启，跳过"
    return 0
  fi

  if [ "$current" = "bbr" ]; then
    info "BBR 已开启（qdisc=${qdisc:-未知}），无需处理"
  else
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
    else
      info "开启 BBR（当前算法：${current:-未知}）"
      if [ ! -f /etc/modules-load.d/bbr.conf ]; then echo "tcp_bbr" > /etc/modules-load.d/bbr.conf; fi
      sysctl -w net.core.default_qdisc=fq >/dev/null 2>&1 || true
      if ! sysctl -w net.ipv4.tcp_congestion_control=bbr >/dev/null 2>&1; then
        warn "开启 BBR 失败，跳过（不影响节点部署）"
      else
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
      fi
    fi
  fi

  # 调大 UDP 缓冲区，减少 Hysteria2 高带宽下的丢包（失败不阻断）。
  local rmem wmem
  rmem=$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)
  wmem=$(sysctl -n net.core.wmem_max 2>/dev/null || echo 0)
  if [[ "${rmem:-0}" =~ ^[0-9]+$ ]] && [[ "${wmem:-0}" =~ ^[0-9]+$ ]]; then
    if [ "$rmem" -lt 16777216 ] || [ "$wmem" -lt 16777216 ]; then
      if sysctl -w net.core.rmem_max=16777216 >/dev/null 2>&1 && sysctl -w net.core.wmem_max=16777216 >/dev/null 2>&1; then
        cat > /etc/sysctl.d/99-hy2-udp.conf <<'SYSCTL'
net.core.rmem_max=16777216
net.core.wmem_max=16777216
SYSCTL
        info "已调大 UDP 缓冲区至 16MB（/etc/sysctl.d/99-hy2-udp.conf）"
      fi
    fi
  fi
}

check_port(){
  local proto="$1" port="$2" expected="$3" ss_flag lines conflict
  if ! command -v ss >/dev/null 2>&1; then
    warn "未找到 ss 命令，跳过 ${proto}/${port} 占用检测"
    return 0
  fi
  if [ "$proto" = "tcp" ]; then ss_flag="-H -lntp"; else ss_flag="-H -lnup"; fi
  lines=$(ss ${ss_flag} 2>/dev/null | awk -v p="$port" '$4 ~ ("[:.]" p "$")' || true)
  [ -n "$lines" ] || return 0
  conflict=$(printf '%s\n' "$lines" | grep -vF "\"${expected}\"" || true)
  if [ -n "$conflict" ]; then
    die "${proto}/${port} 端口被其他进程占用，请先处理："$'\n'"${conflict}"
  fi
  warn "${proto}/${port} 端口由已有 ${expected} 占用，将重启覆盖"
}

detect_public_ip(){
  local candidate url
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    candidate=$(curl -4 -fsSL --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$candidate" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' \
    | grep -vE '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)' | head -1 || true)
  [ -n "$candidate" ] || candidate=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  printf '%s\n' "$candidate"
}

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"
command -v apt-get >/dev/null 2>&1 || die "仅支持 Debian/Ubuntu"
command -v systemctl >/dev/null 2>&1 || die "需要 systemd"
validate_sni "$SNI"
validate_port "TCP_PORT" "$TCP_PORT"
validate_port "UDP_PORT" "$UDP_PORT"
if [ "$ENABLE_SUB" = "1" ]; then
  validate_port "SUB_PORT" "$SUB_PORT"
  [ "$SUB_PORT" != "$TCP_PORT" ] || die "SUB_PORT(${SUB_PORT}) 不能与 TCP_PORT(${TCP_PORT}) 相同，请用 --sub-port 指定其他端口"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

NGINX_WAS_INSTALLED=0
if command -v nginx >/dev/null 2>&1; then NGINX_WAS_INSTALLED=1; fi

info "安装依赖"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
apt-get -o DPkg::Lock::Timeout=120 update -qq
DEPS=(curl unzip openssl ca-certificates iproute2)
if [ "$ENABLE_SUB" = "1" ]; then DEPS+=(nginx); fi
apt-get -o DPkg::Lock::Timeout=120 install -y -qq "${DEPS[@]}" >/dev/null

setup_network_tuning

check_port tcp "$TCP_PORT" xray
check_port udp "$UDP_PORT" sing-box
if [ "$ENABLE_SUB" = "1" ]; then
  check_port tcp "$SUB_PORT" nginx
fi
if [ -f /usr/local/etc/xray/config.json ]; then
  warn "检测到已有 xray 配置，将备份后覆盖（凭据会更新）"
fi
if [ -f /etc/sing-box/config.json ]; then
  warn "检测到已有 sing-box 配置，将备份后覆盖（凭据会更新）"
fi

INSTALLED_XRAY=$(xray version 2>/dev/null | awk 'NR==1{print $2}' | sed 's/^v//' || true)
if [ "$INSTALLED_XRAY" != "$XRAY_VER" ]; then
  if [ -n "$INSTALLED_XRAY" ]; then
    info "切换 Xray 版本：${INSTALLED_XRAY} -> ${XRAY_VER}"
  else
    info "安装 Xray ${XRAY_VER}"
  fi
  XRAY_INSTALLER="${TMP_DIR}/xray-install.sh"
  XRAY_LOG="${TMP_DIR}/xray-install.log"
  curl_fetch "https://github.com/XTLS/Xray-install/raw/main/install-release.sh" -o "$XRAY_INSTALLER" \
    || die "下载 Xray 安装脚本失败（请检查服务器到 github.com 的连通性）"
  if ! bash "$XRAY_INSTALLER" install --version "v${XRAY_VER}" >"$XRAY_LOG" 2>&1; then
    print_log_tail "$XRAY_LOG"
    die "Xray v${XRAY_VER} 安装失败（请检查上方日志，确认网络连通且版本 v${XRAY_VER} 存在）"
  fi
else
  info "Xray ${INSTALLED_XRAY} 已安装，跳过下载"
fi
command -v xray >/dev/null 2>&1 || die "Xray 安装完成后未找到 xray 命令"

if ! command -v sing-box >/dev/null 2>&1; then
  SB_ARCH=$(dpkg --print-architecture)
  SB_LOG="${TMP_DIR}/sing-box-install.log"
  SB_LATEST_URL=$(curl_fetch -I -o /dev/null -w '%{url_effective}' "https://github.com/SagerNet/sing-box/releases/latest" || true)
  SB_VER="${SB_LATEST_URL##*/v}"
  if [ -z "$SB_VER" ] || [ "$SB_VER" = "$SB_LATEST_URL" ]; then
    SB_VER=$(curl_fetch "https://api.github.com/repos/SagerNet/sing-box/releases/latest" \
      | sed -nE 's/.*"tag_name":[[:space:]]*"v?([^"]+)".*/\1/p' | head -1 || true)
  fi
  [ -n "$SB_VER" ] || die "无法获取 sing-box 最新版本号（请检查服务器到 github.com 的连通性）"
  SB_DEB="${TMP_DIR}/sing-box_${SB_VER}_linux_${SB_ARCH}.deb"
  info "安装 sing-box v${SB_VER} (${SB_ARCH})"
  curl_fetch "https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box_${SB_VER}_linux_${SB_ARCH}.deb" -o "$SB_DEB" \
    || die "下载 sing-box v${SB_VER} 安装包失败（架构：${SB_ARCH}）"
  chmod 755 "$TMP_DIR"
  chmod 644 "$SB_DEB"
  if ! apt-get -o DPkg::Lock::Timeout=120 install -y -qq "$SB_DEB" >"$SB_LOG" 2>&1; then
    print_log_tail "$SB_LOG"
    die "sing-box 安装失败（请检查上方日志）"
  fi
else
  info "sing-box 已安装，跳过下载"
fi
command -v sing-box >/dev/null 2>&1 || die "sing-box 安装完成后未找到 sing-box 命令"

info "生成随机凭据"
UUID=$(xray uuid | tr -d '\r\n')
KEYS=$(xray x25519)
PRIV=$(printf '%s\n' "$KEYS" | sed -nE 's/^(Private[[:space:]]*[Kk]ey|PrivateKey)[^:]*:[[:space:]]*//p' | head -1 | tr -d '\r\n')
PUB=$(printf '%s\n' "$KEYS" | sed -nE 's/^(Public[[:space:]]*[Kk]ey|Password)[^:]*:[[:space:]]*//p' | head -1 | tr -d '\r\n')
[ -n "$PRIV" ] && [ -n "$PUB" ] || die "无法解析 xray x25519 输出：${KEYS}"
SHORT_ID=$(openssl rand -hex 8)
HY2_PASS=$(openssl rand -base64 16 | tr -d '\r\n')
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(detect_public_ip)
fi
[ -n "$SERVER_IP" ] || die "无法获取服务器公网 IP，可手动指定：sudo bash install-node.sh --ip 你的IP"

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
        "minClientVer": "0.0.0",
        "shortIds": ["${SHORT_ID}"]
      }
    },
    "sniffing": { "enabled": false }
  }],
  "outbounds": [{ "protocol": "freedom", "tag": "direct" }]
}
EOF
chmod 644 /usr/local/etc/xray/config.json

info "写入 sing-box 配置（Hysteria2 ${UDP_PORT}/udp）"
mkdir -p /etc/sing-box/cert
openssl ecparam -genkey -name prime256v1 -out /etc/sing-box/cert/key.pem 2>/dev/null
if ! openssl req -new -x509 -days 3650 -key /etc/sing-box/cert/key.pem \
    -out /etc/sing-box/cert/cert.pem -subj "/CN=${SNI}" \
    -addext "subjectAltName=DNS:${SNI}" 2>/dev/null; then
  openssl req -new -x509 -days 3650 -key /etc/sing-box/cert/key.pem \
    -out /etc/sing-box/cert/cert.pem -subj "/CN=${SNI}" 2>/dev/null
fi
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
SB_USER=$(systemctl show -p User --value sing-box 2>/dev/null || true)
SB_DYNAMIC=$(systemctl show -p DynamicUser --value sing-box 2>/dev/null || true)
if [ "$SB_DYNAMIC" = "yes" ]; then
  chmod 755 /etc/sing-box /etc/sing-box/cert
  chmod 644 /etc/sing-box/cert/key.pem /etc/sing-box/cert/cert.pem /etc/sing-box/config.json
elif [ -n "$SB_USER" ] && id "$SB_USER" >/dev/null 2>&1; then
  SB_GROUP=$(id -gn "$SB_USER")
  chmod 755 /etc/sing-box
  chown -R "${SB_USER}:${SB_GROUP}" /etc/sing-box/cert
  chown "${SB_USER}:${SB_GROUP}" /etc/sing-box/config.json
  chmod 600 /etc/sing-box/cert/key.pem
  chmod 644 /etc/sing-box/cert/cert.pem /etc/sing-box/config.json
else
  chmod 600 /etc/sing-box/cert/key.pem
  chmod 644 /etc/sing-box/cert/cert.pem /etc/sing-box/config.json
fi

info "校验配置"
if ! xray run -test -config /usr/local/etc/xray/config.json >/dev/null 2>&1; then
  xray run -test -config /usr/local/etc/xray/config.json >&2 || true
  die "xray 配置校验失败"
fi
if ! sing-box check -c /etc/sing-box/config.json >/dev/null 2>&1; then
  sing-box check -c /etc/sing-box/config.json >&2 || true
  die "sing-box 配置校验失败"
fi

info "启动服务"
systemctl enable xray >/dev/null 2>&1
systemctl restart xray
systemctl enable sing-box >/dev/null 2>&1
systemctl restart sing-box
sleep 1
if ! systemctl is-active --quiet xray; then
  journalctl -u xray -n 20 --no-pager >&2 || true
  die "xray 启动失败，请查看上方日志"
fi
if ! systemctl is-active --quiet sing-box; then
  journalctl -u sing-box -n 20 --no-pager >&2 || true
  die "sing-box 启动失败，请查看上方日志"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${TCP_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow "${UDP_PORT}/udp" >/dev/null 2>&1 || true
  info "已放行 ufw：${TCP_PORT}/tcp、${UDP_PORT}/udp"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
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

SUB_URL=""
if [ "$ENABLE_SUB" = "1" ]; then
  info "配置 nginx 订阅链接（${SUB_PORT}/tcp）"
  SUB_TOKEN=$(openssl rand -hex 16)
  SUB_DIR="/var/www/node-sub"
  mkdir -p "$SUB_DIR"
  rm -f "${SUB_DIR}"/*.yaml
  cp "$CLIENT_FILE" "${SUB_DIR}/${SUB_TOKEN}.yaml"
  chmod 755 "$SUB_DIR"
  chmod 644 "${SUB_DIR}/${SUB_TOKEN}.yaml"

  if [ "$NGINX_WAS_INSTALLED" -eq 0 ] && [ -L /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
  mkdir -p /etc/nginx/conf.d
  cat > /etc/nginx/conf.d/node-sub.conf <<EOF
server {
    listen ${SUB_PORT};
    server_tokens off;
    default_type text/yaml;
    charset utf-8;

    location = /${SUB_TOKEN}.yaml {
        alias ${SUB_DIR}/${SUB_TOKEN}.yaml;
        add_header Cache-Control "no-store";
        add_header Content-Disposition 'inline; filename="node.yaml"';
    }

    location / {
        return 444;
    }
}
EOF
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t >&2 || true
    die "nginx 配置校验失败"
  fi
  systemctl enable nginx >/dev/null 2>&1
  systemctl restart nginx
  sleep 1
  if ! systemctl is-active --quiet nginx; then
    journalctl -u nginx -n 20 --no-pager >&2 || true
    die "nginx 启动失败，请查看上方日志"
  fi
  SUB_BODY=$(curl -fsS --max-time 5 "http://127.0.0.1:${SUB_PORT}/${SUB_TOKEN}.yaml" 2>/dev/null || true)
  if ! printf '%s\n' "$SUB_BODY" | grep -q '^proxies:'; then
    die "nginx 订阅链接本机自检失败：http://127.0.0.1:${SUB_PORT}/${SUB_TOKEN}.yaml"
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${SUB_PORT}/tcp" >/dev/null 2>&1 || true
    info "已放行 ufw：${SUB_PORT}/tcp"
  fi
  SUB_URL="http://${SERVER_IP}:${SUB_PORT}/${SUB_TOKEN}.yaml"
fi

echo
info "安装完成"
echo "  服务器    : ${SERVER_IP}"
echo "  Xray 版本 : v${XRAY_VER}"
echo "  Reality   : ${TCP_PORT}/tcp  SNI=${SNI}"
echo "  Hysteria2 : ${UDP_PORT}/udp"
echo "  客户端配置: ${CLIENT_FILE}"
if [ -n "$SUB_URL" ]; then
  echo "  订阅链接  : ${SUB_URL}"
fi
echo
if [ -n "$SUB_URL" ]; then
  warn "云厂商安全组也要放行 ${TCP_PORT}/tcp、${UDP_PORT}/udp 与 ${SUB_PORT}/tcp（订阅端口）"
  warn "可直接把上面的订阅链接粘贴到 EnvGuardCC / FlClash 订阅导入框"
  warn "订阅链接含节点凭据，请妥善保管；导入后如需关闭 HTTP 端口可执行：rm -f /etc/nginx/conf.d/node-sub.conf && systemctl reload nginx"
else
  warn "云厂商安全组也要放行 ${TCP_PORT}/tcp 与 ${UDP_PORT}/udp"
  warn "把 ${CLIENT_FILE} 的内容导入 FlClash / EnvGuardCC 即可"
fi
if [ "$TCP_PORT" = "443" ] || [ "$UDP_PORT" = "443" ]; then
  warn "若当前机房/家宽 ISP 封禁 443 端口，可换非标端口重跑：sudo bash install-node.sh -p 8443"
fi
